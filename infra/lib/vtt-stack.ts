import * as path from 'node:path';
import { CfnOutput, Duration, Fn, RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib';
import { CfnStage, HttpApi, HttpMethod } from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import type { ICertificate } from 'aws-cdk-lib/aws-certificatemanager';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import { HttpOrigin, S3BucketOrigin } from 'aws-cdk-lib/aws-cloudfront-origins';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import { PolicyStatement } from 'aws-cdk-lib/aws-iam';
import { Architecture, Runtime } from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { LogGroup, RetentionDays } from 'aws-cdk-lib/aws-logs';
import { AaaaRecord, ARecord, HostedZone, RecordTarget } from 'aws-cdk-lib/aws-route53';
import { CloudFrontTarget } from 'aws-cdk-lib/aws-route53-targets';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { BucketDeployment, Source } from 'aws-cdk-lib/aws-s3-deployment';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import type { Construct } from 'constructs';

// Regions that host the Chime meeting API ("control" regions). Media can run in more regions
// (e.g. us-east-2), so when the stack's region has no meeting API we call it in us-east-1.
// https://docs.aws.amazon.com/chime-sdk/latest/dg/sdk-available-regions.html
const CHIME_CONTROL_REGIONS = [
  'us-east-1', 'us-west-2', 'ca-central-1', 'eu-central-1', 'eu-west-2', 'ap-south-1',
  'ap-northeast-1', 'ap-northeast-2', 'ap-southeast-1', 'ap-southeast-2',
];

export interface VttStackProps extends StackProps {
  /** Custom hostnames for the site; the certificate must be in us-east-1 (see CertStack). */
  domain?: { zoneName: string; names: string[]; certificate: ICertificate };
}

export class VttStack extends Stack {
  constructor(scope: Construct, id: string, props: VttStackProps = {}) {
    super(scope, id, props);

    // ---- Join API -------------------------------------------------------------------------

    // room -> current Chime meeting id
    const rooms = new dynamodb.TableV2(this, 'Rooms', {
      partitionKey: { name: 'room', type: dynamodb.AttributeType.STRING },
      billing: dynamodb.Billing.onDemand(),
      removalPolicy: RemovalPolicy.DESTROY,
    });

    // Shared "table key" players enter to join. Stops strangers from creating meetings on our bill.
    const tableKey = new secretsmanager.Secret(this, 'TableKey', {
      secretName: 'pac-vtt/table-key',
      description: 'Shared key players enter to join a PAC VTT room',
      generateSecretString: { excludePunctuation: true, passwordLength: 16 },
    });

    const joinFn = new NodejsFunction(this, 'JoinFn', {
      entry: path.join(import.meta.dirname, '../lambda/join.ts'),
      runtime: Runtime.NODEJS_22_X,
      architecture: Architecture.ARM_64,
      memorySize: 256,
      timeout: Duration.seconds(10),
      environment: {
        ROOMS_TABLE: rooms.tableName,
        TABLE_KEY_SECRET_ARN: tableKey.secretArn,
        CHIME_CONTROL_REGION: CHIME_CONTROL_REGIONS.includes(this.region) ? this.region : 'us-east-1',
        CHIME_MEDIA_REGION: this.region,
      },
      bundling: { minify: true, sourceMap: true },
      logGroup: new LogGroup(this, 'JoinFnLogs', {
        retention: RetentionDays.ONE_MONTH,
        removalPolicy: RemovalPolicy.DESTROY,
      }),
    });
    rooms.grantReadWriteData(joinFn);
    tableKey.grantRead(joinFn);
    joinFn.addToRolePolicy(
      new PolicyStatement({
        actions: ['chime:CreateMeeting', 'chime:GetMeeting', 'chime:DeleteMeeting', 'chime:CreateAttendee'],
        resources: ['*'],
      }),
    );

    const api = new HttpApi(this, 'Api', { apiName: 'pac-vtt-api' });
    api.addRoutes({
      path: '/api/join',
      methods: [HttpMethod.POST],
      integration: new HttpLambdaIntegration('JoinIntegration', joinFn),
    });
    // Cheap guard against someone hammering the endpoint.
    (api.defaultStage!.node.defaultChild as CfnStage).defaultRouteSettings = {
      throttlingBurstLimit: 20,
      throttlingRateLimit: 10,
    };

    // ---- Static site + CDN ----------------------------------------------------------------

    const site = new s3.Bucket(this, 'Site', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    // Same origin for the app and /api, so no CORS. (HTTPS is also required for camera/mic access.)
    const cdn = new cloudfront.Distribution(this, 'Cdn', {
      comment: 'PAC VTT',
      defaultRootObject: 'index.html',
      priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
      domainNames: props.domain?.names,
      certificate: props.domain?.certificate,
      defaultBehavior: {
        origin: S3BucketOrigin.withOriginAccessControl(site),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      },
      additionalBehaviors: {
        '/api/*': {
          origin: new HttpOrigin(Fn.select(2, Fn.split('/', api.apiEndpoint))),
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.HTTPS_ONLY,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
          cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
          originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
        },
      },
    });

    new BucketDeployment(this, 'DeploySite', {
      sources: [Source.asset(path.join(import.meta.dirname, '../../web/dist'))],
      destinationBucket: site,
      distribution: cdn,
      distributionPaths: ['/*'],
    });

    if (props.domain) {
      const zone = HostedZone.fromLookup(this, 'Zone', { domainName: props.domain.zoneName });
      const target = RecordTarget.fromAlias(new CloudFrontTarget(cdn));
      props.domain.names.forEach((name, i) => {
        new ARecord(this, `Alias${i}`, { zone, recordName: name, target });
        new AaaaRecord(this, `Alias${i}v6`, { zone, recordName: name, target });
      });
    }

    new CfnOutput(this, 'SiteUrl', {
      value: `https://${props.domain?.names[0] ?? cdn.distributionDomainName}`,
    });
    new CfnOutput(this, 'CloudFrontUrl', { value: `https://${cdn.distributionDomainName}` });
    new CfnOutput(this, 'TableKeySecretName', { value: tableKey.secretName });
  }
}
