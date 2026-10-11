# PAC VTT

A homebrew virtual tabletop for our online TTRPG group: live audio/video plus customizable, plugin-style game tools (dice, card-based sheets, shared images, maps).

Early prototype. Current state: A/V rooms with chat and dice.

## Layout

- `infra/`: AWS CDK app (TypeScript). CloudFront + S3 site, API Gateway + Lambda join endpoint, DynamoDB, Secrets Manager.
- `web/`: Vite + vanilla TypeScript client. `src/av.ts` is a vendor-neutral A/V interface; `src/chime-av.ts` implements it with the Amazon Chime SDK.

## Deploy

```bash
npm install
aws login --profile <profile>              # profile must have a region set
npx -w infra cdk bootstrap                 # once per account/region (with AWS_PROFILE set), plus us-east-1 if using a custom domain
AWS_PROFILE=<profile> npm run deploy
```

**Custom domain.** `infra/cdk.json` sets `zoneName` and `domainNames` (currently `vtt.16watt.com` and `pac.16watt.com`). The Route 53 hosted zone must be in the deploy account. A `PacVttCert` stack in us-east-1 issues the CloudFront certificate, and `PacVtt` adds the aliases and A/AAAA records. To deploy elsewhere, change those values, or pass `-c domainNames=` to skip the custom domain and use the CloudFront URL.

Players join with a shared table key, stored in Secrets Manager as `pac-vtt/table-key`.

## Local development

```bash
VTT_SITE_URL=https://<your-cloudfront-domain> npm run dev   # UI on localhost, /api proxied to the deployed stack
```
