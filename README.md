# PAC VTT

A homebrew virtual tabletop for our online TTRPG group: live audio/video plus customizable, plugin-style game tools (dice, card-based sheets, shared images, maps).

Prototype, usable at the table:
- **Rooms** that persist between sessions, each tied to one game system. They can be archived from the lobby.
- **Audio/video**: a strip of video tiles.
- **Cards**: bulk-import card images. Decks with random server-side draws, face-up rows, discard piles. Drag cards anywhere. Flip, tap, upgrade (with optional upgraded art), counters, notes, and a GM seat that can hide cards. A card library for adding copies.
- **Sheets**: one per player, with named card slots and fields such as HP.
- **Images**: a pull-out drawer of maps and handouts per room. Upload in bulk, optionally hidden until shown. Set one as the table's background map, show one big on everyone's screen (spotlight), or put it on the table as a movable piece.
- **Table**: pan/zoom, optional grid, resizable pieces, **live drawing**, and pings.
- **Dice**: expressions like `2d6+3`, rolled on the server. Chat, a log of every action, and undo.

## Layout

- `shared/`: the table model and engine, run by both the server and the browser. A room is **zones** (deck, row, board, slots, discard, hand) holding **pieces** (card instances, images, tokens), plus card definitions and drawing strokes. Changes are small **ops**. The server resolves randomness (dice, draws), applies the op, and broadcasts it; every client applies the same op with the same `apply()`. Each op returns its inverse, which is how undo works.
- `infra/`: AWS CDK app (TypeScript). CloudFront + S3 site, plus card art at `/assets/*` from a separate bucket. HTTP API (`lambda/api.ts`: rooms, join, upload URLs). WebSocket API (`lambda/ws.ts`: game state; large messages are chunked to fit API Gateway's 32 KB frames). DynamoDB. Secrets Manager.
- `web/`: Vite + vanilla TypeScript client.
  - `src/game.ts`: game-state client (snapshot, live ops, reconnect).
  - `src/board.ts`: the table. Zone bar, table surface, drag and drop, card/zone menus, library, preview. Also `pieces.ts` (card faces), `sheets.ts` (player sheets), `importer.ts` (bulk card upload), `images.ts` (image drawer, maps, spotlight), `draw.ts` (live drawing and pings) and `menu.ts` (the popup menu).
  - `src/av.ts`: vendor-neutral A/V interface; `src/chime-av.ts` implements it with the Amazon Chime SDK. Its data channel also carries unsaved live messages (in-progress strokes, pings).
  - `src/systems/`: game systems (plugins). See below.
- `scripts/smoke.ts`: end-to-end check against a deployed stack (API, WebSocket, uploads, a 150-card import).
- `scripts/ui.ts`: two players in headless Chromium play through the whole UI.

## Writing a game system

A system is configuration on the generic engine. The server never knows which system a room uses. Copy `web/src/systems/example.ts`, change it, add it to the list in `web/src/systems/index.ts`, and deploy:

```ts
export const mygame: GameSystem = {
  id: 'mygame',                       // stored in each room; don't change it later
  name: 'My Game',
  description: 'Shown in the system picker.',
  setup: () => [                      // zones a new room starts with
    { kind: 'zone.create', zone: { id: 'loot', kind: 'deck', label: 'Loot deck' } },
    { kind: 'zone.create', zone: { id: 'market', kind: 'row', label: 'Market' } },
    { kind: 'zone.create', zone: { id: 'table', kind: 'board', label: 'Table' } },
  ],
  sheet: { slots: ['Weapon', 'Armor', 'Gear'], fields: { HP: '10' } },  // "Create my sheet"
  actions: [{                         // buttons above the table
    label: 'Refill market',
    run: ({ state }) => {             // return ops (sent as one batch = one undo), or a message
      const n = Object.values(state.pieces).filter((p) => p.zone === 'market').length;
      return n >= 4 ? 'Market is full.' : [{ kind: 'draw', from: 'loot', to: 'market', count: 4 - n }];
    },
  }],
};
```

Zone kinds: `deck` (hidden, random draws), `row` (face-up line), `board` (free placement), `slots` (named or free slots, used for sheets), `discard`, `hand`. Actions can only produce ordinary ops, so the server validates them like anything else. Custom card or sheet renderers will be added to the contract when a game needs them.

## Data

The `Game` DynamoDB table holds every room's state and action log. It has **point-in-time recovery**. The table and the `Assets` bucket (card art) are both **retained** if the stack is deleted, so a `cdk destroy` doesn't wipe campaigns. Delete them by hand if you really mean it.

Card art is served from unguessable URLs (`/assets/<room>/<uuid>.png`) without a login. Anyone with a link can view an image. Uploads need a session token.

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
PAC_KEY=<table key> npx tsx scripts/ui.ts [site] [image]     # headless browser test (needs Playwright's Chromium)
```

`images/` is gitignored: keep card art there for local testing, not in this public repo.
