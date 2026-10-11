import assert from 'node:assert/strict';
import { test } from 'node:test';
import { describeRoll, roll } from './dice.ts';
import { apply, newPiece, OpError, resolve } from './engine.ts';
import { emptyRoom, type Op, type RoomState } from './model.ts';

const fixed = (n: number) => () => n; // rand() that always returns n
let seed = 1;
const prng = (sides: number) => ((seed = (seed * 16807) % 2147483647) % sides) + 1;

function room(): RoomState {
  const s = emptyRoom('r', 'Room', 'generic');
  for (const op of [
    { kind: 'zone.create', zone: { id: 'deck', kind: 'deck', label: 'Deck' } },
    { kind: 'zone.create', zone: { id: 'row', kind: 'row', label: 'Market' } },
    { kind: 'zone.create', zone: { id: 'board', kind: 'board', label: 'Table' } },
  ] as Op[]) apply(s, op);
  for (let i = 0; i < 5; i++) apply(s, { kind: 'piece.create', piece: newPiece(`p${i}`, `c${i}`, 'deck', { index: i }) });
  return s;
}

/** Apply op, then its inverse, and check we're back where we started. */
function roundTrip(s: RoomState, op: Op) {
  const before = structuredClone(s);
  const inv = apply(s, op);
  assert.ok(inv, `${op.kind} should be undoable`);
  apply(s, JSON.parse(JSON.stringify(inv))); // inverses are stored and sent as JSON
  assert.deepEqual(s, before);
}

test('dice: parses and totals expressions', () => {
  const r = roll('2d6 + 1d4 - 2', fixed(3));
  assert.equal(r.total, 3 + 3 + 3 - 2);
  assert.equal(describeRoll(r), '2d6 (3, 3) + 1d4 (3) - 2 = 7');
  assert.equal(roll('d20', fixed(20)).total, 20);
  assert.equal(roll('-d4+10', fixed(4)).total, 6);
});

test('dice: rejects junk and huge rolls', () => {
  for (const bad of ['', 'banana', '2d', 'd1', '1000d6', '3+4', '2d6*2', 'd99999']) {
    assert.throws(() => roll(bad, fixed(1)), Error, bad);
  }
});

test('piece.update reverses, including moves and counters', () => {
  const s = room();
  roundTrip(s, { kind: 'piece.update', id: 'p1', set: { zone: 'board', x: 10, y: 20, faceUp: true } });
  roundTrip(s, { kind: 'piece.update', id: 'p1', set: { counters: { dmg: 2 }, note: 'hi', tapped: true } });
});

test('moving to a zone without an index appends', () => {
  const s = room();
  apply(s, { kind: 'piece.update', id: 'p0', set: { zone: 'row' } });
  apply(s, { kind: 'piece.update', id: 'p1', set: { zone: 'row' } });
  assert.equal(s.pieces.p0.index, 0);
  assert.equal(s.pieces.p1.index, 1);
});

test('draw picks distinct cards from the deck, face up, and reverses', () => {
  const s = room();
  const op = resolve(s, { kind: 'draw', from: 'deck', to: 'row', count: 3 }, { rand: prng });
  assert.equal(op.kind, 'draw');
  const ids = (op as { ids: string[] }).ids;
  assert.equal(new Set(ids).size, 3);
  roundTrip(s, op);
  apply(s, op);
  for (const id of ids) {
    assert.equal(s.pieces[id].zone, 'row');
    assert.equal(s.pieces[id].faceUp, true);
  }
});

test('draw is capped by what is left, and an empty deck fails', () => {
  const s = room();
  const op = resolve(s, { kind: 'draw', from: 'deck', to: 'row', count: 99 }, { rand: prng });
  apply(s, op);
  assert.equal(Object.values(s.pieces).filter((p) => p.zone === 'row').length, 5);
  assert.throws(() => resolve(s, { kind: 'draw', from: 'deck', to: 'row', count: 1 }, { rand: prng }), OpError);
});

test('batch resolves in order and reverses as a whole', () => {
  const s = room();
  const op = resolve(s, {
    kind: 'batch',
    ops: [
      { kind: 'draw', from: 'deck', to: 'row', count: 2 },
      { kind: 'draw', from: 'deck', to: 'row', count: 2 },
      { kind: 'roll', expr: 'd6' },
    ],
  }, { rand: prng });
  const before = structuredClone(s);
  const inv = apply(s, op)!;
  assert.equal(Object.values(s.pieces).filter((p) => p.zone === 'row').length, 4);
  apply(s, inv);
  assert.deepEqual(s, before);
});

test('zones: create/delete reverse; non-empty zones cannot be deleted', () => {
  const s = room();
  roundTrip(s, { kind: 'zone.create', zone: { id: 'hand-ana', kind: 'hand', label: 'Ana', owner: 'Ana' } });
  assert.throws(() => apply(s, { kind: 'zone.delete', id: 'deck' }), OpError);
});

test('piece create/delete and gm seat reverse', () => {
  const s = room();
  roundTrip(s, { kind: 'piece.delete', id: 'p2' });
  roundTrip(s, { kind: 'piece.create', piece: newPiece('new', 'c9', 'board') });
  roundTrip(s, { kind: 'gm', seat: 'Paul' });
});

test('rejects bad input without touching state', () => {
  const s = room();
  const before = structuredClone(s);
  const bad: Op[] = [
    { kind: 'chat', text: '' },
    { kind: 'chat', text: 'x'.repeat(501) },
    { kind: 'piece.update', id: 'nope', set: { tapped: true } },
    { kind: 'piece.update', id: 'p0', set: { zone: 'nowhere' } },
    { kind: 'piece.update', id: 'p0', set: { tapped: 'yes' as unknown as boolean } },
    { kind: 'piece.update', id: 'p0', set: { def: 'x' } as never },
    { kind: 'zone.create', zone: { id: 'z', kind: 'bogus' as never, label: '' } },
    { kind: 'roll', expr: 'd6' }, // unresolved: no result
    { kind: 'what' } as unknown as Op,
  ];
  for (const op of bad) assert.throws(() => apply(structuredClone(s), op), OpError, JSON.stringify(op));
  assert.deepEqual(s, before);
});

test('undo resolves through the server callback and applies the inverse', () => {
  const s = room();
  const inv = apply(s, { kind: 'piece.update', id: 'p0', set: { tapped: true } })!;
  const op = resolve(s, { kind: 'undo' }, { rand: prng, undo: () => ({ target: 7, op: inv }) });
  apply(s, op);
  assert.equal(s.pieces.p0.tapped, false);
});

test('zone.update and field.set reverse (including unset slots)', () => {
  const s = room();
  roundTrip(s, { kind: 'zone.update', id: 'row', set: { label: 'Market', slots: ['Weapon', 'Armor'] } });
  apply(s, { kind: 'zone.update', id: 'row', set: { slots: ['A'] } });
  roundTrip(s, { kind: 'zone.update', id: 'row', set: { slots: [] } });
  roundTrip(s, { kind: 'field.set', zone: 'row', key: 'HP', value: '10' });
  apply(s, { kind: 'field.set', zone: 'row', key: 'HP', value: '10' });
  roundTrip(s, { kind: 'field.set', zone: 'row', key: 'HP', value: '7' });
  roundTrip(s, { kind: 'field.set', zone: 'row', key: 'HP', value: null });
  assert.throws(() => apply(s, { kind: 'zone.update', id: 'row', set: { kind: 'deck' } as never }), OpError);
});

test('cards: create/update/delete reverse; cards in use cannot be deleted', () => {
  const s = room();
  roundTrip(s, { kind: 'card.create', card: { id: 'cx', name: 'X', front: '/a/x.png' } });
  apply(s, { kind: 'card.create', card: { id: 'cx', name: 'X', front: '/a/x.png' } });
  roundTrip(s, { kind: 'card.update', id: 'cx', set: { upgraded: '/a/x2.png', back: '/a/b.png' } });
  roundTrip(s, { kind: 'card.delete', id: 'cx' });
  apply(s, { kind: 'card.create', card: { id: 'c0', name: 'Zero', front: '/a/0.png' } });
  assert.throws(() => apply(s, { kind: 'card.delete', id: 'c0' }), OpError); // p0 uses it
  assert.throws(() => apply(s, { kind: 'card.create', card: { id: 'cy', name: 'Y', front: '/y', evil: 1 } as never }), OpError);
});

test('importing a batch of cards undoes completely', () => {
  const s = room();
  const before = structuredClone(s);
  const inv = apply(s, {
    kind: 'batch',
    ops: [
      { kind: 'card.create', card: { id: 'k1', name: 'K1', front: '/k1' } },
      { kind: 'piece.create', piece: newPiece('q1', 'k1', 'deck') },
    ],
  })!;
  apply(s, inv);
  assert.deepEqual(s, before);
});
