// End-to-end check against a deployed stack: two players in a throwaway room exercise rolls,
// chat, draws and undo over the real WebSocket, using the browser's GameClient.
//   PAC_KEY=<table key> npx tsx scripts/smoke.ts [https://vtt.16watt.com]
// Leaves a room named "zz-smoke-<time>" behind; delete it afterwards if you like.
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
  ...[0, 1, 2, 3].flatMap((i): Op[] => [
    { kind: 'card.create', card: { id: `c${i}`, name: `Card ${i}`, front: `/assets/c${i}.png` } },
    { kind: 'piece.create', piece: newPiece(`p${i}`, `c${i}`, 'deck', { index: i }) },
  ]),
];

const t0 = Date.now();
const { room } = await post('/api/rooms/create', { name: `zz-smoke-${Date.now()}`, system: 'generic', setup });
console.log('created room', room.id);
assert.ok((await post('/api/rooms', {})).rooms.some((r: { id: string }) => r.id === room.id), 'room is listed');

const ana = await player('Ana', room.id);
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

// A late joiner gets the same state from the snapshot.
const cy = await player('Cy', room.id);
assert.deepEqual(cy.game.state, ana.game.state, 'late joiner matches');

for (const p of [ana, bo, cy]) p.game.close();
console.log(`OK in ${Date.now() - t0} ms: rolls, chat, draw, rejected ops, undo, late join all agree.`);
