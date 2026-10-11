// Applies ops to a RoomState. The server runs resolve() (fills in randomness) and apply() on a
// copy, then broadcasts the resolved op; every browser runs the same apply(), so all copies of the
// state stay identical. apply() returns the op that reverses it (for undo), or null.
import { roll } from './dice.ts';
import type { CardDef, Op, Piece, PieceProps, RoomState, Visibility, Zone, ZoneKind } from './model.ts';

const ZONE_KINDS: ZoneKind[] = ['deck', 'row', 'board', 'slots', 'discard', 'hand'];
const VISIBILITY: Visibility[] = ['all', 'gm', 'owner'];
const MAX_BATCH = 200;
const MAX_DRAW = 50;
const MAX_FIELDS = 40;

export class OpError extends Error {}

function fail(msg: string): never {
  throw new OpError(msg);
}

const isId = (v: unknown): v is string => typeof v === 'string' && /^[\w.:-]{1,64}$/.test(v);
const isText = (v: unknown, max: number): v is string => typeof v === 'string' && v.length <= max;
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

function checkZone(z: Zone) {
  if (!z || !isId(z.id)) fail('Zone needs an id.');
  if (!ZONE_KINDS.includes(z.kind)) fail(`Unknown zone kind "${z.kind}".`);
  if (!isText(z.label, 80)) fail('Zone label is too long.');
  if (z.owner !== undefined && !isText(z.owner, 40)) fail('Bad zone owner.');
  if (z.slots !== undefined) checkSlots(z.slots);
  if (z.fields !== undefined) {
    if (!z.fields || typeof z.fields !== 'object' || Object.keys(z.fields).length > MAX_FIELDS) fail('Too many fields.');
    for (const [k, v] of Object.entries(z.fields)) checkField(k, v);
  }
}

function checkSlots(slots: unknown) {
  if (!Array.isArray(slots) || slots.length > 50 || !slots.every((l) => isText(l, 40))) fail('Bad slot labels.');
}

function checkField(key: unknown, value: unknown) {
  if (!isText(key, 40) || !key.trim()) fail('Field names are 1–40 characters.');
  if (!isText(value, 500)) fail('Field values are at most 500 characters.');
}

function checkCard(c: Partial<CardDef>, partial: boolean) {
  for (const k of ['name', 'front', 'back', 'upgraded'] as const) {
    const v = c[k];
    if (v === undefined) {
      if (!partial && (k === 'name' || k === 'front')) fail(`Card needs a ${k}.`);
      continue;
    }
    if (!isText(v, k === 'name' ? 120 : 300)) fail(`Bad card ${k}.`);
  }
  const extra = Object.keys(c).filter((k) => !['id', 'name', 'front', 'back', 'upgraded'].includes(k));
  if (extra.length) fail(`Unknown card field ${extra[0]}.`);
}

function checkPieceProps(set: Partial<PieceProps>, state: RoomState) {
  for (const [k, v] of Object.entries(set)) {
    const ok = (() => {
      switch (k) {
        case 'zone': return isId(v) && !!state.zones[v];
        case 'index': case 'x': case 'y': return isNum(v);
        case 'faceUp': case 'tapped': case 'upgraded': return typeof v === 'boolean';
        case 'note': return isText(v, 1000);
        case 'visibleTo': return VISIBILITY.includes(v as Visibility);
        case 'owner': return v === undefined || isText(v, 40);
        case 'counters':
          return !!v && typeof v === 'object' && Object.keys(v).length <= 20 &&
            Object.entries(v).every(([name, n]) => isText(name, 30) && isNum(n));
        default: return false;
      }
    })();
    if (!ok) fail(`Bad value for piece ${k}.`);
  }
}

function nextIndex(state: RoomState, zone: string): number {
  let max = -1;
  for (const p of Object.values(state.pieces)) if (p.zone === zone && p.index > max) max = p.index;
  return max + 1;
}

/** Fill in the parts only the server may decide (dice results, which cards get drawn, undo). */
export function resolve(
  state: RoomState,
  op: Op,
  ctx: { rand: (sides: number) => number; undo?: (state: RoomState) => { target: number; op: Op } },
): Op {
  switch (op.kind) {
    case 'roll':
      if (!isText(op.expr, 60)) fail('Roll expression is too long.');
      try {
        return { kind: 'roll', expr: op.expr, result: roll(op.expr, ctx.rand) };
      } catch (e) {
        fail((e as Error).message); // bad expressions are the player's mistake, not a server error
      }
    case 'draw': {
      const pool = Object.values(state.pieces).filter((p) => p.zone === op.from).map((p) => p.id);
      if (!pool.length) fail('That deck is empty.');
      const count = Math.min(Math.max(1, Math.floor(op.count)), MAX_DRAW, pool.length);
      const ids: string[] = [];
      for (let i = 0; i < count; i++) ids.push(...pool.splice(ctx.rand(pool.length) - 1, 1));
      return { ...op, count, ids };
    }
    case 'batch':
      if (!Array.isArray(op.ops) || op.ops.length > MAX_BATCH) fail(`A batch holds at most ${MAX_BATCH} ops.`);
      // Resolve in order against a scratch copy so later ops see earlier ones (e.g. two draws).
      {
        const scratch = structuredClone(state);
        const ops = op.ops.map((o) => {
          if (o.kind === 'undo' || o.kind === 'batch') fail('Batches cannot contain undo or nested batches.');
          const r = resolve(scratch, o, ctx);
          apply(scratch, r);
          return r;
        });
        return { kind: 'batch', ops };
      }
    case 'undo':
      if (!ctx.undo) fail('Undo is not available here.');
      return { kind: 'undo', ...ctx.undo(state) };
    default:
      return op;
  }
}

/** Validate and apply `op` to `state` in place. Returns the reversing op, or null if not undoable. */
export function apply(state: RoomState, op: Op): Op | null {
  switch (op.kind) {
    case 'chat':
      if (!isText(op.text, 500) || !op.text.trim()) fail('Chat messages are 1–500 characters.');
      return null;

    case 'roll':
      if (!op.result) fail('Roll has no result.');
      return null;

    case 'gm': {
      if (op.seat !== null && !isText(op.seat, 40)) fail('Bad GM seat.');
      const prev = state.gm;
      state.gm = op.seat;
      return { kind: 'gm', seat: prev };
    }

    case 'zone.create':
      checkZone(op.zone);
      if (state.zones[op.zone.id]) fail(`Zone ${op.zone.id} already exists.`);
      state.zones[op.zone.id] = { ...op.zone };
      return { kind: 'zone.delete', id: op.zone.id };

    case 'zone.delete': {
      const zone = state.zones[op.id] ?? fail(`No zone ${op.id}.`);
      if (Object.values(state.pieces).some((p) => p.zone === op.id)) fail(`Zone "${zone.label}" isn't empty.`);
      delete state.zones[op.id];
      return { kind: 'zone.create', zone };
    }

    case 'zone.update': {
      const zone = state.zones[op.id] ?? fail(`No zone ${op.id}.`);
      if (!op.set || typeof op.set !== 'object') fail('Nothing to update.');
      const keys = Object.keys(op.set);
      if (keys.some((k) => k !== 'label' && k !== 'slots')) fail('Only a zone label and slots can change.');
      if (op.set.label !== undefined && (!isText(op.set.label, 80) || !op.set.label.trim())) fail('Bad zone label.');
      if (op.set.slots !== undefined) checkSlots(op.set.slots);
      // Inverses travel as JSON, which drops undefined, so "no slots" is written as [].
      const prev = Object.fromEntries(keys.map((k) => [k, structuredClone(k === 'slots' ? zone.slots ?? [] : zone.label)]));
      Object.assign(zone, structuredClone(op.set));
      if (!zone.slots?.length) delete zone.slots;
      return { kind: 'zone.update', id: op.id, set: prev };
    }

    case 'field.set': {
      const zone = state.zones[op.zone] ?? fail(`No zone ${op.zone}.`);
      if (op.value !== null) checkField(op.key, op.value);
      else if (!isText(op.key, 40)) fail('Bad field name.');
      const fields = (zone.fields ??= {});
      const prev = op.key in fields ? fields[op.key] : null;
      if (op.value === null) delete fields[op.key];
      else {
        if (!(op.key in fields) && Object.keys(fields).length >= MAX_FIELDS) fail('Too many fields.');
        fields[op.key] = op.value;
      }
      if (!Object.keys(fields).length) delete zone.fields;
      return { kind: 'field.set', zone: op.zone, key: op.key, value: prev };
    }

    case 'card.create': {
      const c = op.card;
      if (!c || !isId(c.id)) fail('Bad card.');
      checkCard(c, false);
      if (state.cards[c.id]) fail(`Card ${c.id} already exists.`);
      state.cards[c.id] = { ...c };
      return { kind: 'card.delete', id: c.id };
    }

    case 'card.update': {
      const c = state.cards[op.id] ?? fail(`No card ${op.id}.`);
      if (!op.set || typeof op.set !== 'object' || 'id' in op.set) fail('Bad card update.');
      checkCard(op.set, true);
      // '' means "no image" for back/upgraded (JSON drops undefined).
      const prev = Object.fromEntries(Object.keys(op.set).map((k) => [k, c[k as keyof CardDef] ?? '']));
      Object.assign(c, op.set);
      for (const k of ['back', 'upgraded'] as const) if (!c[k]) delete c[k];
      if (!c.name || !c.front) fail('A card needs a name and a front image.');
      return { kind: 'card.update', id: op.id, set: prev };
    }

    case 'card.delete': {
      const c = state.cards[op.id] ?? fail(`No card ${op.id}.`);
      if (Object.values(state.pieces).some((p) => p.def === op.id)) fail(`"${c.name}" is still on the table.`);
      delete state.cards[op.id];
      return { kind: 'card.create', card: c };
    }

    case 'piece.create': {
      const p = op.piece;
      if (!p || !isId(p.id) || !isId(p.def)) fail('Bad piece.');
      if (state.pieces[p.id]) fail(`Piece ${p.id} already exists.`);
      const { id: _id, def: _def, ...props } = p;
      checkPieceProps(props, state);
      state.pieces[p.id] = structuredClone(p);
      return { kind: 'piece.delete', id: p.id };
    }

    case 'piece.delete': {
      const p = state.pieces[op.id] ?? fail(`No piece ${op.id}.`);
      delete state.pieces[op.id];
      return { kind: 'piece.create', piece: p };
    }

    case 'piece.update': {
      const p = state.pieces[op.id] ?? fail(`No piece ${op.id}.`);
      if (!op.set || typeof op.set !== 'object') fail('Nothing to update.');
      checkPieceProps(op.set, state);
      const set: Partial<PieceProps> = { ...op.set };
      // Moving to another zone without an index appends to the end of it.
      if (set.zone !== undefined && set.zone !== p.zone && set.index === undefined) set.index = nextIndex(state, set.zone);
      const prev = Object.fromEntries(Object.keys(set).map((k) => [k, structuredClone(p[k as keyof PieceProps])]));
      Object.assign(p, structuredClone(set));
      return { kind: 'piece.update', id: op.id, set: prev as Partial<PieceProps> };
    }

    case 'draw': {
      const from = state.zones[op.from] ?? fail(`No zone ${op.from}.`);
      const to = state.zones[op.to] ?? fail(`No zone ${op.to}.`);
      if (from.kind !== 'deck') fail(`"${from.label}" isn't a deck.`);
      if (!op.ids?.length) fail('Draw has no cards.');
      const undo: Op[] = [];
      for (const id of op.ids) {
        const p = state.pieces[id];
        if (!p || p.zone !== op.from) fail('Drawn card is no longer in the deck.');
        undo.push({ kind: 'piece.update', id, set: { zone: p.zone, index: p.index, faceUp: p.faceUp } });
        Object.assign(p, { zone: op.to, index: nextIndex(state, op.to), faceUp: to.kind !== 'deck' });
      }
      return { kind: 'batch', ops: undo.reverse() };
    }

    case 'batch': {
      if (!Array.isArray(op.ops) || op.ops.length > MAX_BATCH) fail(`A batch holds at most ${MAX_BATCH} ops.`);
      const undo: Op[] = [];
      for (const o of op.ops) {
        if (o.kind === 'undo') fail('Batches cannot contain undo.');
        const inv = apply(state, o);
        if (inv) undo.push(inv);
      }
      return undo.length ? { kind: 'batch', ops: undo.reverse() } : null;
    }

    case 'undo':
      if (!op.op) fail('Nothing to undo.');
      apply(state, op.op);
      return null; // no redo (yet)

    default:
      fail(`Unknown op "${(op as { kind: string }).kind}".`);
  }
}

/** A new face-down piece for a card, ready for piece.create. */
export function newPiece(id: string, def: string, zone: string, extra: Partial<Piece> = {}): Piece {
  return {
    id, def, zone, index: 0, x: 0, y: 0, faceUp: false, tapped: false, upgraded: false,
    counters: {}, note: '', visibleTo: 'all', ...extra,
  };
}
