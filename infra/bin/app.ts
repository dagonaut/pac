import { App, Tags } from 'aws-cdk-lib';
import { CertStack } from '../lib/cert-stack.ts';
import { VttStack } from '../lib/vtt-stack.ts';

// Account and region come from the AWS profile you deploy with (AWS_PROFILE=... npm run deploy),
// so nothing account-specific lives in the repo. Override the region with `-c region=us-west-2`.
const app = new App();
const region = app.node.tryGetContext('region') ?? process.env.CDK_DEFAULT_REGION;
const account = process.env.CDK_DEFAULT_ACCOUNT;
if (!account || !region) {
  throw new Error('No AWS account/region found. Deploy with AWS_PROFILE set to a signed-in profile that has a region.');
}

// Optional custom domain (cdk.json context). The Route 53 zone must be in the deploy account.
// Pass `-c domainNames=` to deploy without one.
const zoneName: string | undefined = app.node.tryGetContext('zoneName');
const rawNames: unknown = app.node.tryGetContext('domainNames');
const domainNames = (Array.isArray(rawNames) ? rawNames : String(rawNames ?? '').split(',')).filter(Boolean) as string[];

const cert = zoneName && domainNames.length
  ? new CertStack(app, 'PacVttCert', {
      env: { account, region: 'us-east-1' },
      crossRegionReferences: true,
      description: 'PAC VTT: CloudFront certificate (must be us-east-1)',
      zoneName,
      domainNames,
    })
  : undefined;

const stack = new VttStack(app, 'PacVtt', {
  env: { account, region },
  crossRegionReferences: true,
  description: 'PAC VTT: A/V rooms (Chime SDK) + static web app',
  domain: cert && zoneName ? { zoneName, names: domainNames, certificate: cert.certificate } : undefined,
});

for (const s of [stack, cert]) if (s) Tags.of(s).add('project', 'pac-vtt');
