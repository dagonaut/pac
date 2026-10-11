import { App, Tags } from 'aws-cdk-lib';
import { VttStack } from '../lib/vtt-stack.ts';

// Account and region come from the AWS profile you deploy with (AWS_PROFILE=... npm run deploy),
// so nothing account-specific lives in the repo. Override the region with `-c region=us-west-2`.
const app = new App();
const region = app.node.tryGetContext('region') ?? process.env.CDK_DEFAULT_REGION;
const account = process.env.CDK_DEFAULT_ACCOUNT;
if (!account || !region) {
  throw new Error('No AWS account/region found. Deploy with AWS_PROFILE set to a signed-in profile that has a region.');
}

const stack = new VttStack(app, 'PacVtt', {
  env: { account, region },
  description: 'PAC VTT: A/V rooms (Chime SDK) + static web app',
});
Tags.of(stack).add('project', 'pac-vtt');
