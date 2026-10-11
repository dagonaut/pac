import * as path from 'node:path';
import { CfnOutput, Duration, Fn, RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib';
import { CfnStage, HttpApi, HttpMethod, WebSocketApi, WebSocketStage } from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpLambdaIntegration, WebSocketLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
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

    // ---- Tables ---------------------------------------------------------------------------

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

    // Game state. Keys:
    //   room#<id> / state           the room's RoomState (JSON) + seq and lobby summary fields
    //   room#<id> / log#<seq>       one applied op (+ its inverse for undo)
    //   room#<id> / conn#<connId>   a WebSocket connection in the room (TTL)
    //   conn#<connId> / conn        connection -> room lookup for $disconnect (TTL)
    const game = new dynamodb.TableV2(this, 'Game', {
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
      billing: dynamodb.Billing.onDemand(),
      timeToLiveAttribute: 'ttl',
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true }, // campaigns live here
      removalPolicy: RemovalPolicy.RETAIN,
    });

    const fn = (id: string, entry: string, environment: Record<string, string>) =>
      new NodejsFunction(this, id, {
        entry: path.join(import.meta.dirname, '../lambda', entry),
        runtime: Runtime.NODEJS_22_X,
        architecture: Architecture.ARM_64,
        memorySize: 256,
        timeout: Duration.seconds(10),
        environment: { GAME_TABLE: game.tableName, TABLE_KEY_SECRET_ARN: tableKey.secretArn, ...environment },
        bundling: { minify: true, sourceMap: true },
        logGroup: new LogGroup(this, `${id}Logs`, {
          retention: RetentionDays.ONE_MONTH,
          removalPolicy: RemovalPolicy.DESTROY,
        }),
      });

    // ---- Game-state WebSocket ---------------------------------------------------------------

    const wsFn = fn('WsFn', 'ws.ts', {});
    game.grantReadWriteData(wsFn);
    tableKey.grantRead(wsFn);

    const wsIntegration = new WebSocketLambdaIntegration('WsIntegration', wsFn);
    const wsApi = new WebSocketApi(this, 'WsApi', {
      apiName: 'pac-vtt-ws',
      routeSelectionExpression: '$request.body.type',
      connectRouteOptions: { integration: wsIntegration },
      disconnectRouteOptions: { integration: wsIntegration },
      defaultRouteOptions: { integration: wsIntegration },
    });
    const wsStage = new WebSocketStage(this, 'WsStage', {
      webSocketApi: wsApi,
      stageName: 'live',
      autoDeploy: true,
      throttle: { burstLimit: 50, rateLimit: 25 },
    });
    wsApi.grantManageConnections(wsFn);

    // ---- Assets (card art) ---------------------------------------------------------------------

    // Uploaded straight from the browser with presigned POSTs; served by CloudFront at /assets/*.
    // Retained like the Game table: it's campaign content. CORS can't name the CloudFront domain
    // (it would be circular), and the presigned policy is what actually limits uploads, so allow any origin.
    const assets = new s3.Bucket(this, 'Assets', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      removalPolicy: RemovalPolicy.RETAIN,
      cors: [{ allowedMethods: [s3.HttpMethods.POST], allowedOrigins: ['*'], allowedHeaders: ['*'], maxAge: 3600 }],
    });

    // ---- HTTP API (rooms + join + uploads) -------------------------------------------------

    const apiFn = fn('ApiFn', 'api.ts', {
      ROOMS_TABLE: rooms.tableName,
      WS_URL: wsStage.url,
      CHIME_CONTROL_REGION: CHIME_CONTROL_REGIONS.includes(this.region) ? this.region : 'us-east-1',
      CHIME_MEDIA_REGION: this.region,
      ASSETS_BUCKET: assets.bucketName,
    });
    assets.grantPut(apiFn);
    rooms.grantReadWriteData(apiFn);
    game.grantReadWriteData(apiFn);
    tableKey.grantRead(apiFn);
    apiFn.addToRolePolicy(
      new PolicyStatement({
        actions: ['chime:CreateMeeting', 'chime:GetMeeting', 'chime:DeleteMeeting', 'chime:CreateAttendee'],
        resources: ['*'],
      }),
    );

    const api = new HttpApi(this, 'Api', { apiName: 'pac-vtt-api' });
    const apiIntegration = new HttpLambdaIntegration('ApiIntegration', apiFn);
    for (const p of ['/api/join', '/api/rooms', '/api/rooms/create', '/api/rooms/archive', '/api/assets']) {
      api.addRoutes({ path: p, methods: [HttpMethod.POST], integration: apiIntegration });
    }
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
        // HSTS, nosniff, frame-options, referrer policy.
        responseHeadersPolicy: cloudfront.ResponseHeadersPolicy.SECURITY_HEADERS,
      },
      additionalBehaviors: {
        '/assets/*': {
          origin: S3BucketOrigin.withOriginAccessControl(assets),
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
          responseHeadersPolicy: cloudfront.ResponseHeadersPolicy.SECURITY_HEADERS,
        },
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
