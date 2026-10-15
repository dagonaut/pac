# PAC VTT

A homebrew virtual tabletop for our online TTRPG group: live audio/video plus customizable, plugin-style game tools (dice, card-based sheets, shared images, maps).

Prototype, usable at the table:
- **Players** sign in with a personal link (no passwords); admins manage the list and who may GM. Guests can still join with the shared table key. Each player has a color and a portrait.
- **Rooms** that persist between sessions, each tied to one game system. They can be archived from the lobby.
- **Audio/video**: a strip of video tiles. Everyone's dice results pop up on their tile.
- **Cards**: bulk-import card images. Decks with random server-side draws, face-up rows, discard piles. Drag cards anywhere. Flip, tap, upgrade (with optional upgraded art), counters, notes, and a GM seat that can hide cards. A card library for adding copies.
- **Sheets**: one per player, made from a **sheet template** (JSON, see below): sections of typed fields (numbers you can click to roll, tracks, choices, notes, die sizes) and card slots. Templates have a builder with live preview and a JSON view, and they export and import between rooms.
- **Images**: a pull-out drawer of maps and handouts per room. Upload in bulk, optionally hidden until shown. Set one as the table's background map (centered with free table around it; right-click it to size or re-center it), show one big on everyone's screen (spotlight), or put it on the table as a movable piece.
- **Table**: pan/zoom, optional grid, resizable pieces that can be locked in place and brought to the front or sent to the back, **live drawing** (freehand, lines, arrows, boxes, circles, text labels), and pings.
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

## Sheet templates

A template is the shape of a character sheet, stored as JSON. Build one in the app (dock → **Templates** → **New template**), or write it by hand: the [`sheet.schema.json`](web/public/sheet.schema.json) schema (served at `https://vtt.16watt.com/sheet.schema.json`) gives VS Code autocomplete and error checking. **Export** downloads a `.sheet.json` and **Import** loads one into any room. The server validates every template with `shared/sheet.ts`.

```json
{
  "$schema": "https://vtt.16watt.com/sheet.schema.json",
  "name": "Raider",
  "sections": [
    { "title": "Stats", "fields": [
      { "id": "int", "label": "INT", "type": "number", "default": 2, "min": -3, "max": 5, "roll": "2d6" },
      { "id": "harm", "label": "Harm", "type": "track", "boxes": 4 },
      { "id": "weapon_die", "label": "Weapon die", "type": "die", "default": "d8" }
    ]},
    { "title": "Loadout", "slots": [ { "id": "weapon", "label": "Weapon" }, { "id": "gear", "label": "Gear", "count": 3 } ] }
  ]
}
```

| Field type | Shows | Options |
|---|---|---|
| `number` | − value + | `default`, `min`, `max`; `roll`: dice rolled with the value as modifier when the label is clicked (`"2d6"` with value 2 rolls `2d6+2`) |
| `text` / `longtext` | one line / notes box | `default` |
| `checkbox` | on/off | `default` (true/false) |
| `select` | dropdown | `options` (required), `default` |
| `track` | row of boxes (harm, stress) | `boxes` (required), `default` (filled count) |
| `die` | d4–d20 picker; click the label to roll it | `default` (e.g. `"d8"`) |
| `image` | a round picture (e.g. a portrait) each player picks for their own sheet: upload one or choose from the room's Images | none (only this room's uploads are accepted) |

Any field can have a `hint` (small help text under it, e.g. "Awareness, understanding, smarts"), and any section a `note` (rules or instructions under its title).

`slots` are card places on the sheet. `count` repeats a slot, e.g. 3 Gear slots. Ids are lowercase keys, unique within the template. Values are stored per sheet under those ids, so renaming a label is safe but changing an id loses that field's value. Editing a template updates every sheet made from it.

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
  templates: [raiderSheet],           // sheet templates (JSON files) every new room starts with
  sheet: { slots: ['Weapon', 'Armor', 'Gear'], fields: { HP: '10' } },  // plain sheet when a room has no templates
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
