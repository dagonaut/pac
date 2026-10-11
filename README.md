# PAC VTT

A homebrew virtual tabletop for our online TTRPG group: live audio/video plus customizable, plugin-style game tools (dice, card-based sheets, shared images, maps).

Early prototype. Current state: persistent rooms (one game system each) with A/V, a live game-state channel, server-side dice, chat, a GM seat and undo. Cards and the shared board come next.

## Layout

- `shared/`: the table model and engine, run by both the server and the browser. A room is **zones** (deck, row, board, slots, discard, hand) holding **pieces** (card instances, later tokens and images). Changes are small **ops**. The server resolves randomness (dice, draws), applies the op, and broadcasts it; every client applies the same op with the same `apply()`. Each op returns its inverse, which is how undo works.
- `infra/`: AWS CDK app (TypeScript). CloudFront + S3 site; HTTP API (`lambda/api.ts`: rooms, join); WebSocket API (`lambda/ws.ts`: game state); DynamoDB; Secrets Manager.
- `web/`: Vite + vanilla TypeScript client.
  - `src/game.ts`: game-state client (snapshot, live ops, reconnect).
  - `src/av.ts`: vendor-neutral A/V interface; `src/chime-av.ts` implements it with the Amazon Chime SDK.
  - `src/systems/`: game systems (plugins). Each one is config on the generic engine: starting zones now, with sheet layout, custom actions and renderers to come.
- `scripts/smoke.ts`: end-to-end check against a deployed stack.

## Data

The `Game` DynamoDB table holds every room's state and action log. It has **point-in-time recovery** and is **retained** if the stack is deleted, so a `cdk destroy` doesn't wipe campaigns. Delete it by hand if you really mean it.

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
npm test                                                     # engine unit tests
PAC_KEY=<table key> npx tsx scripts/smoke.ts                 # two simulated players against the live site
```
