import assert from 'node:assert/strict';
import { test } from 'node:test';
import { describeRoll, roll } from './dice.ts';
import { apply, newPiece, OpError, publicNames, resolve } from './engine.ts';
import { emptyRoom, type Op, type RoomState } from './model.ts';
import { defaultValues, type SheetTemplateFile, slotLabels, templateErrors } from './sheet.ts';

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

test('scale and owner reverse even when they were unset', () => {
  const s = room();
  roundTrip(s, { kind: 'piece.update', id: 'p1', set: { scale: 3 } });
  roundTrip(s, { kind: 'piece.update', id: 'p1', set: { owner: 'Ana' } });
  assert.throws(() => apply(s, { kind: 'piece.update', id: 'p1', set: { scale: 100 } }), OpError);
});

test('publicNames only names face-up, unhidden cards', () => {
  const s = room();
  apply(s, { kind: 'card.create', card: { id: 'c1', name: 'One', front: '/assets/r/1.png' } });
  apply(s, { kind: 'card.create', card: { id: 'c2', name: 'Two', front: '/assets/r/2.png' } });
  apply(s, { kind: 'piece.update', id: 'p1', set: { faceUp: true } });
  apply(s, { kind: 'piece.update', id: 'p2', set: { faceUp: true, visibleTo: 'gm' } });
  const op: Op = { kind: 'batch', ops: [
    { kind: 'piece.update', id: 'p1', set: { tapped: true } },
    { kind: 'piece.update', id: 'p2', set: { tapped: true } },
  ] };
  assert.deepEqual(publicNames(s, op), { p1: 'One' });
});

test('strokes: add/delete reverse; clear-all as a batch undoes', () => {
  const s = room();
  const stroke = { id: 'k1', zone: 'board', color: '#ff0000', width: 3, points: [0, 0, 10, 10, 20, 5], by: 'Ana' };
  roundTrip(s, { kind: 'stroke.add', stroke });
  apply(s, { kind: 'stroke.add', stroke });
  apply(s, { kind: 'stroke.add', stroke: { ...stroke, id: 'k2' } });
  roundTrip(s, { kind: 'batch', ops: [{ kind: 'stroke.delete', id: 'k1' }, { kind: 'stroke.delete', id: 'k2' }] });
  for (const bad of [
    { ...stroke, id: 'k3', zone: 'row' },
    { ...stroke, id: 'k3', color: 'red' },
    { ...stroke, id: 'k3', points: [1, 2, 3] },
    { ...stroke, id: 'k3', points: [0.5, 1] },
    { ...stroke, id: 'k1' },
  ]) assert.throws(() => apply(s, { kind: 'stroke.add', stroke: bad }), OpError, JSON.stringify(bad));
});

test('rooms from before drawing existed accept strokes', () => {
  const s = room();
  delete s.strokes;
  apply(s, { kind: 'stroke.add', stroke: { id: 'k1', zone: 'board', color: '#00ff00', width: 2, points: [1, 1], by: 'Bo' } });
  assert.equal(Object.keys(s.strokes!).length, 1);
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
  roundTrip(s, { kind: 'card.create', card: { id: 'cx', name: 'X', front: '/assets/r/x.png' } });
  apply(s, { kind: 'card.create', card: { id: 'cx', name: 'X', front: '/assets/r/x.png' } });
  roundTrip(s, { kind: 'card.update', id: 'cx', set: { upgraded: '/assets/r/x2.png', back: '/assets/r/b.png' } });
  roundTrip(s, { kind: 'card.delete', id: 'cx' });
  apply(s, { kind: 'card.create', card: { id: 'c0', name: 'Zero', front: '/assets/r/0.png' } });
  assert.throws(() => apply(s, { kind: 'card.delete', id: 'c0' }), OpError); // p0 uses it
  assert.throws(() => apply(s, { kind: 'card.create', card: { id: 'cy', name: 'Y', front: '/y', evil: 1 } as never }), OpError);
});

test('importing a batch of cards undoes completely', () => {
  const s = room();
  const before = structuredClone(s);
  const inv = apply(s, {
    kind: 'batch',
    ops: [
      { kind: 'card.create', card: { id: 'k1', name: 'K1', front: '/assets/r/k1.png' } },
      { kind: 'piece.create', piece: newPiece('q1', 'k1', 'deck') },
    ],
  })!;
  apply(s, inv);
  assert.deepEqual(s, before);
});

test('images: create/update/delete reverse; maps and spotlight need library images', () => {
  const s = room();
  const img = { id: 'im1', name: 'Dungeon', src: '/assets/r/dungeon.png', kind: 'map' as const, hidden: true, by: 'Ana' };
  roundTrip(s, { kind: 'image.create', image: img });
  apply(s, { kind: 'image.create', image: img });
  roundTrip(s, { kind: 'image.update', id: 'im1', set: { hidden: false, name: 'Crypt' } });
  roundTrip(s, { kind: 'zone.map', id: 'board', map: { image: 'im1', scale: 1.5 } });
  apply(s, { kind: 'zone.map', id: 'board', map: { image: 'im1', scale: 1 } });
  roundTrip(s, { kind: 'zone.map', id: 'board', map: null });
  assert.throws(() => apply(s, { kind: 'image.delete', id: 'im1' }), /in use/);
  roundTrip(s, { kind: 'spotlight', spotlight: { image: 'im1', by: 'Ana' } });
  apply(s, { kind: 'zone.map', id: 'board', map: null });
  roundTrip(s, { kind: 'image.delete', id: 'im1' });
  for (const bad of [
    { kind: 'zone.map', id: 'row', map: { image: 'im1', scale: 1 } },
    { kind: 'zone.map', id: 'board', map: { image: 'nope', scale: 1 } },
    { kind: 'zone.map', id: 'board', map: { image: 'im1', scale: 99 } },
    { kind: 'spotlight', spotlight: { image: 'nope', by: 'Ana' } },
    { kind: 'image.create', image: { ...img, id: 'im2', src: 'https://evil.example/x.png' } },
    { kind: 'image.create', image: { ...img, id: 'im3', kind: 'poster' } },
    { kind: 'image.create', image: { ...img, id: '__proto__' } },
    { kind: 'image.update', id: '__proto__', set: { hidden: false } },
  ] as Op[]) assert.throws(() => apply(structuredClone(s), bad), OpError, JSON.stringify(bad));
});

test('security: reserved ids and keys never reach Object.prototype', () => {
  const s = room();
  const attempts: Op[] = [
    { kind: 'piece.update', id: '__proto__', set: { owner: 'Bob' } },
    { kind: 'field.set', zone: '__proto__', key: 'x', value: 'y' },
    { kind: 'field.set', zone: 'row', key: '__proto__', value: 'y' },
    { kind: 'field.set', zone: 'row', key: '__proto__', value: null },
    { kind: 'zone.update', id: 'constructor', set: { label: 'x' } },
    { kind: 'card.update', id: '__proto__', set: { name: 'x' } },
    { kind: 'piece.update', id: 'p0', set: { counters: JSON.parse('{"__proto__": 1}') } },
    { kind: 'zone.create', zone: { id: '__proto__', kind: 'row', label: 'x' } },
    { kind: 'stroke.delete', id: '__proto__' },
  ];
  for (const op of attempts) assert.throws(() => apply(structuredClone(s), op), OpError, JSON.stringify(op));
  assert.equal(({} as Record<string, unknown>).owner, undefined);
  assert.equal(({} as Record<string, unknown>).fields, undefined);
});

test('security: piece.create needs every field; zones only known keys; art only from this room', () => {
  const s = room();
  assert.throws(() => apply(s, { kind: 'piece.create', piece: { id: 'bad', def: 'c0', zone: 'board' } as never }), /missing/);
  assert.throws(() => apply(s, { kind: 'zone.create', zone: { id: 'z', kind: 'row', label: 'Z', junk: 'x'.repeat(1000) } as never }), /Unknown zone field/);
  for (const front of ['https://evil.example/x.png', '/assets/other-room/x.png', '/assets/r/../x.png', '/assets/r/x.svg']) {
    assert.throws(() => apply(s, { kind: 'card.create', card: { id: 'cz', name: 'Z', front } }), /uploaded to this room/, front);
  }
});

const raider: SheetTemplateFile = {
  name: 'Raider',
  sections: [
    { title: 'Stats', fields: [
      { id: 'int', label: 'INT', type: 'number', default: 2, min: -3, max: 5, roll: '2d6' },
      { id: 'harm', label: 'Harm', type: 'track', boxes: 4 },
      { id: 'die', label: 'Weapon die', type: 'die', default: 'd8' },
      { id: 'class', label: 'Class', type: 'select', options: ['Pilot', 'Hacker'] },
      { id: 'charged', type: 'checkbox' },
      { id: 'notes', type: 'longtext' },
    ] },
    { title: 'Loadout', slots: [{ id: 'weapon', label: 'Weapon' }, { id: 'gear', label: 'Gear', count: 3 }] },
  ],
};

test('templates: valid template, defaults and slot labels', () => {
  assert.deepEqual(templateErrors(raider), []);
  assert.deepEqual(slotLabels(raider), ['Weapon', 'Gear', 'Gear', 'Gear']);
  assert.deepEqual(defaultValues(raider), { int: '2', harm: '0', die: 'd8', class: 'Pilot', charged: 'false', notes: '' });
});

test('templates: readable errors for bad templates', () => {
  const bad = (patch: (t: SheetTemplateFile) => void) => {
    const t = structuredClone(raider);
    patch(t);
    return templateErrors(t).join(' | ');
  };
  assert.match(bad((t) => { t.name = ''; }), /name/);
  assert.match(bad((t) => { t.sections[0].fields![1].id = 'int'; }), /used twice/);
  assert.match(bad((t) => { t.sections[0].fields![0].id = 'Has Space'; }), /lowercase/);
  assert.match(bad((t) => { t.sections[0].fields![0].type = 'colour' as never; }), /type/);
  assert.match(bad((t) => { t.sections[0].fields![0].roll = 'lots'; }), /dice/);
  assert.match(bad((t) => { t.sections[0].fields![1].boxes = 99; }), /boxes/);
  assert.match(bad((t) => { t.sections[0].fields![3].default = 'Wizard'; }), /default/);
  assert.match(bad((t) => { (t as unknown as Record<string, unknown>).evil = 1; }), /Unknown top-level/);
  assert.match(bad((t) => { t.sections[1].slots![1].count = 100; }), /count/);
  assert.deepEqual(templateErrors('nope'), ['A template must be a JSON object.']);
});

test('templates: ops reverse; sheets use them; used templates cannot be deleted', () => {
  const s = room();
  const tpl = { ...raider, id: 'tpl-raider' };
  roundTrip(s, { kind: 'template.create', template: tpl });
  apply(s, { kind: 'template.create', template: tpl });
  roundTrip(s, { kind: 'template.update', id: 'tpl-raider', template: { ...tpl, name: 'Raider v2' } });
  assert.throws(() => apply(s, { kind: 'template.create', template: { ...tpl, id: 'tpl-bad', name: '' } }), /Template problem/);
  apply(s, { kind: 'zone.create', zone: { id: 'sheet-a', kind: 'slots', label: 'Raider', owner: 'Ana', template: 'tpl-raider', slots: slotLabels(raider), fields: defaultValues(raider) } });
  assert.throws(() => apply(s, { kind: 'template.delete', id: 'tpl-raider' }), /used by a sheet/);
  assert.throws(() => apply(s, { kind: 'zone.create', zone: { id: 'sheet-b', kind: 'slots', label: 'X', template: 'missing' } }), /not in this room/);
  assert.throws(() => apply(s, { kind: 'zone.create', zone: { id: 'z-b', kind: 'row', label: 'X', template: 'tpl-raider' } }), /Only a sheet/);
  // Unknown keys are dropped when stored.
  apply(s, { kind: 'template.create', template: { ...tpl, id: 'tpl-2', $schema: 'x' } as never });
  assert.equal('$schema' in s.templates!['tpl-2'], false);
});

test('rolls keep a label', () => {
  const s = room();
  const op = resolve(s, { kind: 'roll', expr: '2d6+2', label: 'INT' }, { rand: fixed(3) });
  assert.equal((op as { label?: string }).label, 'INT');
  apply(s, op);
});

test('shapes and text: validated, editable, movable, and they reverse', () => {
  const s = room();
  const base = { zone: 'board', color: '#ff0000', width: 4, by: 'Ana' };
  roundTrip(s, { kind: 'stroke.add', stroke: { ...base, id: 'l1', shape: 'arrow', points: [0, 0, 100, 50] } });
  roundTrip(s, { kind: 'stroke.add', stroke: { ...base, id: 'r1', shape: 'rect', fill: true, points: [10, 10, 60, 40] } });
  apply(s, { kind: 'stroke.add', stroke: { ...base, id: 't1', shape: 'text', text: 'Goblins here', points: [200, 200] } });
  assert.equal(s.strokes!.t1.text, 'Goblins here');
  roundTrip(s, { kind: 'stroke.update', id: 't1', set: { text: 'Goblins (3)' } });
  roundTrip(s, { kind: 'stroke.update', id: 't1', set: { points: [250, 220] } });
  // Old-style strokes stay plain paths (no shape key stored).
  apply(s, { kind: 'stroke.add', stroke: { ...base, id: 'p1', points: [0, 0, 5, 5, 9, 2] } });
  assert.equal('shape' in s.strokes!.p1, false);
  for (const bad of [
    { ...base, id: 'b1', shape: 'rect', points: [0, 0, 1] },
    { ...base, id: 'b2', shape: 'line', points: [0, 0, 1, 1, 2, 2] },
    { ...base, id: 'b3', shape: 'text', points: [0, 0] },
    { ...base, id: 'b4', shape: 'text', text: 'x'.repeat(1001), points: [0, 0] },
    { ...base, id: 'b5', shape: 'line', fill: true, points: [0, 0, 1, 1] },
    { ...base, id: 'b6', shape: 'star', points: [0, 0, 1, 1] },
    { ...base, id: 'b7', shape: 'line', text: 'hi', points: [0, 0, 1, 1] },
    { ...base, id: 'b8', points: [0, 0], evil: 1 },
  ]) assert.throws(() => apply(s, { kind: 'stroke.add', stroke: bad as never }), OpError, JSON.stringify(bad));
  assert.throws(() => apply(s, { kind: 'stroke.update', id: 'p1', set: { text: 'no' } }), OpError);
  assert.throws(() => apply(s, { kind: 'stroke.update', id: 't1', set: { points: [1, 2, 3, 4] } }), OpError);
});

test('counter colors are room-wide, reversible and validated', () => {
  const s = room();
  roundTrip(s, { kind: 'counter.color', name: 'poison', color: '#59cd90' });
  apply(s, { kind: 'counter.color', name: 'poison', color: '#59cd90' });
  roundTrip(s, { kind: 'counter.color', name: 'poison', color: '#ee6352' });
  roundTrip(s, { kind: 'counter.color', name: 'poison', color: null });
  for (const bad of [
    { kind: 'counter.color', name: '__proto__', color: '#ffffff' },
    { kind: 'counter.color', name: 'x', color: 'red' },
    { kind: 'counter.color', name: '', color: '#ffffff' },
  ] as Op[]) assert.throws(() => apply(structuredClone(s), bad), OpError);
});

test('text drawings can have several lines', () => {
  const s = room();
  const base = { zone: 'board', color: '#ff0000', width: 4, by: 'Ana', shape: 'text' as const, points: [0, 0] };
  apply(s, { kind: 'stroke.add', stroke: { ...base, id: 't1', text: 'Line one\nLine two\nLine three' } });
  assert.equal(s.strokes!.t1.text!.split('\n').length, 3);
  assert.throws(() => apply(s, { kind: 'stroke.add', stroke: { ...base, id: 't2', text: Array(41).fill('x').join('\n') } }), /40 lines/);
});

test('maps can be placed; placement is validated and reverses', () => {
  const s = room();
  apply(s, { kind: 'image.create', image: { id: 'im1', name: 'Crypt', src: '/assets/r/crypt.png', kind: 'map', hidden: false, by: 'Ana' } });
  roundTrip(s, { kind: 'zone.map', id: 'board', map: { image: 'im1', scale: 1, x: 1200, y: 600 } });
  apply(s, { kind: 'zone.map', id: 'board', map: { image: 'im1', scale: 1, x: 1200, y: 600 } });
  assert.deepEqual(s.zones.board.map, { image: 'im1', scale: 1, x: 1200, y: 600 });
  roundTrip(s, { kind: 'zone.map', id: 'board', map: { image: 'im1', scale: 2, x: 800, y: 300 } });
  for (const bad of [{ x: -5 }, { x: 1.5 }, { y: 99999 }, { z: 1 }]) {
    assert.throws(() => apply(s, { kind: 'zone.map', id: 'board', map: { image: 'im1', scale: 1, ...bad } as never }), OpError, JSON.stringify(bad));
  }
});

test('templates accept field hints and section notes', () => {
  const t: SheetTemplateFile = { name: 'Hints', sections: [{ title: 'Attributes', note: 'Range -1 to +3.', fields: [{ id: 'insight', label: 'Insight', hint: 'Awareness, smarts', type: 'number' }] }] };
  assert.deepEqual(templateErrors(t), []);
  assert.match(templateErrors({ ...t, sections: [{ ...t.sections[0], note: 'x'.repeat(601) }] }).join(), /note/);
});
