// End-to-end check against a deployed stack: two players in a throwaway room exercise rolls,
// chat, draws and undo over the real WebSocket, using the browser's GameClient.
//   PAC_KEY=<table key> npx tsx scripts/smoke.ts [https://vtt.16watt.com]
// Archives its room "zz-smoke-<time>" at the end (data and uploaded test images remain).
import assert from 'node:assert/strict';
import { newPiece } from '../shared/engine.ts';
import type { LogEntry, Op, RoomState } from '../shared/model.ts';
import { GameClient } from '../web/src/game.ts';

const site = process.argv[2] ?? 'https://vtt.16watt.com';
const key = process.env.PAC_KEY ?? '';
if (!key) throw new Error('Set PAC_KEY to the table key.');

async function post(path: string, body: object) {
  const res = await fetch(site + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key, ...body }) });
  const data = await res.json();
  if (!res.ok) throw new Error(`${path}: ${res.status} ${data.error}`);
  return data;
}

function player(name: string, room: string): Promise<{ game: GameClient; seen: LogEntry[] }> {
  return post('/api/join', { room, name }).then(
    (join) =>
      new Promise((resolve) => {
        const seen: LogEntry[] = [];
        const game: GameClient = new GameClient(join.wsUrl, join.token, {
          snapshot: () => resolve({ game, seen }),
          op: (e) => seen.push(e),
          status: () => {},
          error: (m) => console.log(`[${name}] error: ${m}`),
        });
      }),
  );
}

const until = async (cond: () => boolean, what: string) => {
  for (let i = 0; i < 50 && !cond(); i++) await new Promise((r) => setTimeout(r, 100));
  assert.ok(cond(), `timed out waiting for ${what}`);
};

const setup: Op[] = [
  { kind: 'zone.create', zone: { id: 'deck', kind: 'deck', label: 'Draw deck' } },
  { kind: 'zone.create', zone: { id: 'row', kind: 'row', label: 'Selection' } },
];
// Card art must live under the room's own /assets/<room>/ path, so cards are added after creation.
const cards = (room: string): Op[] => [0, 1, 2, 3].flatMap((i): Op[] => [
  { kind: 'card.create', card: { id: `c${i}`, name: `Card ${i}`, front: `/assets/${room}/card-${i}.png` } },
  { kind: 'piece.create', piece: newPiece(`p${i}`, `c${i}`, 'deck', { index: i }) },
]);

// The page's own scripts/styles must load (CloudFront routes some paths elsewhere, e.g. /assets/*).
const html = await (await fetch(site)).text();
const files = [...html.matchAll(/(?:src|href)="(\/[^"]+\.(?:js|css))"/g)].map((m) => m[1]);
assert.ok(files.length >= 2, 'index.html references its JS and CSS');
for (const f of files) assert.equal((await fetch(site + f)).status, 200, `${f} loads`);

const t0 = Date.now();
const { room } = await post('/api/rooms/create', { name: `zz-smoke-${Date.now()}`, system: 'generic', setup });
console.log('created room', room.id);
assert.ok((await post('/api/rooms', {})).rooms.some((r: { id: string }) => r.id === room.id), 'room is listed');

const ana = await player('Ana', room.id);
await ana.game.send({ kind: 'batch', ops: cards(room.id) });
const bo = await player('Bo', room.id);
const start: RoomState = structuredClone(ana.game.state!);

const roll = await ana.game.send({ kind: 'roll', expr: '2d6+1' });
assert.equal(roll.op.kind, 'roll');
console.log('roll:', JSON.stringify((roll.op as { result: unknown }).result));

await bo.game.send({ kind: 'chat', text: 'hello from Bo' });
await ana.game.send({ kind: 'draw', from: 'deck', to: 'row', count: 2 });
await until(() => bo.seen.length === 3, 'Bo to see 3 ops');
assert.equal(Object.values(bo.game.state!.pieces).filter((p) => p.zone === 'row').length, 2, 'Bo sees the draw');
assert.deepEqual(bo.game.state, ana.game.state, 'both players have identical state');

await assert.rejects(bo.game.send({ kind: 'undo' }), /Nothing of yours to undo/);
await assert.rejects(ana.game.send({ kind: 'roll', expr: 'banana' }), /Can't read/);
await assert.rejects(ana.game.send({ kind: 'piece.update', id: 'nope', set: { tapped: true } }), /No piece/);

await ana.game.send({ kind: 'undo' }); // undoes the draw (rolls aren't undoable)
await until(() => bo.seen.length === 4, 'Bo to see the undo');
const strip = (s: RoomState) => ({ ...s, seq: 0 });
assert.deepEqual(strip(ana.game.state!), strip(start), 'undo restored the starting state');
assert.deepEqual(bo.game.state, ana.game.state);

// Upload an image the way the import dialog does: presigned POST, then fetch it through CloudFront.
const join = await post('/api/join', { room: room.id, name: 'Ana' });
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const up = await (await fetch(`${site}/api/assets`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ token: join.token, files: [{ name: 'dot.png', type: 'image/png', size: png.length }] }),
})).json();
assert.ok(up.uploads?.[0]?.path, `upload url: ${JSON.stringify(up)}`);
const form = new FormData();
for (const [k, v] of Object.entries(up.uploads[0].fields as Record<string, string>)) form.append(k, v);
form.append('file', new Blob([png], { type: 'image/png' }));
const s3res = await fetch(up.uploads[0].url, { method: 'POST', body: form });
assert.ok(s3res.ok, `S3 upload ${s3res.status}: ${await s3res.text()}`);
const served = await fetch(site + up.uploads[0].path);
assert.equal(served.status, 200, 'asset served by CloudFront');
assert.equal(Buffer.from(await served.arrayBuffer()).length, png.length);
const badType = await fetch(`${site}/api/assets`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ token: join.token, files: [{ name: 'x.svg', type: 'image/svg+xml', size: 10 }] }),
});
assert.equal(badType.status, 400, 'SVG rejected');
const badToken = await fetch(`${site}/api/assets`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ token: 'nope', files: [{ name: 'a.png', type: 'image/png', size: 10 }] }),
});
assert.equal(badToken.status, 401, 'bad token rejected');
console.log('upload OK:', up.uploads[0].path);

// Scale: 150 cards in import-sized batches, so the late joiner's snapshot needs chunking.
const tBatch = Date.now();
for (let b = 0; b < 150; b += 40) {
  const ops: Op[] = [];
  for (let i = b; i < Math.min(150, b + 40); i++) {
    ops.push({ kind: 'card.create', card: { id: `card-big${String(i).padStart(4, '0')}`, name: `Big card number ${i}`, front: `/assets/${room.id}/00000000-0000-4000-8000-${String(i).padStart(12, '0')}.png` } });
    ops.push({ kind: 'piece.create', piece: newPiece(`pc-big${String(i).padStart(4, '0')}`, `card-big${String(i).padStart(4, '0')}`, 'deck', { index: 10 + i }) });
  }
  await ana.game.send({ kind: 'batch', ops });
}
console.log(`150 cards imported in ${Date.now() - tBatch} ms; state is ${JSON.stringify(ana.game.state).length} chars`);
await until(() => JSON.stringify(bo.game.state) === JSON.stringify(ana.game.state), 'Bo to catch up on the import');

// A late joiner gets the same state from the snapshot.
const cy = await player('Cy', room.id);
assert.deepEqual(cy.game.state, ana.game.state, 'late joiner matches');

for (const p of [ana, bo, cy]) p.game.close();
console.log(`OK in ${Date.now() - t0} ms: rolls, chat, draw, rejected ops, undo, uploads, late join all agree.`);
await post('/api/rooms/archive', { room: room.id, archived: true });
const listed = (await post('/api/rooms', {})).rooms.find((r: { id: string }) => r.id === room.id);
assert.equal(listed?.archived, true, 'room archived');
console.log(`Archived ${room.id} (its data and assets/${room.id}/ remain).`);
