// Applies ops to a RoomState. The server runs resolve() (fills in randomness) and apply() on a
// copy, then broadcasts the resolved op; every browser runs the same apply(), so all copies of the
// state stay identical. apply() returns the op that reverses it (for undo), or null.
import { roll } from './dice.ts';
import type { CardDef, Op, Piece, PieceProps, RoomState, StrokeShape, Visibility, Zone, ZoneKind } from './model.ts';
import { normalizeTemplate, type SheetTemplate, templateErrors } from './sheet.ts';

const ZONE_KINDS: ZoneKind[] = ['deck', 'row', 'board', 'slots', 'discard', 'hand'];
const VISIBILITY: Visibility[] = ['all', 'gm', 'owner'];
const MAX_BATCH = 200;
const MAX_DRAW = 50;
const MAX_FIELDS = 200;
const MAX_STROKES = 1500;
const MAX_STROKE_POINTS = 500;
const MAX_ZONES = 100;
const MAX_CARDS = 2000;
const MAX_PIECES = 3000;
const MAX_IMAGES = 500;
const MAX_TEMPLATES = 50;

export class OpError extends Error {}

function fail(msg: string): never {
  throw new OpError(msg);
}

// Keys that would reach Object.prototype through obj[key]. Never valid as ids or names.
const RESERVED = new Set(['__proto__', 'constructor', 'prototype']);
const isId = (v: unknown): v is string => typeof v === 'string' && /^[\w.:-]{1,64}$/.test(v) && !RESERVED.has(v);
const isText = (v: unknown, max: number): v is string => typeof v === 'string' && v.length <= max;
const isKey = (v: unknown, max: number): v is string => isText(v, max) && !!v.trim() && !RESERVED.has(v);

/** rec[id] only if it's the record's own property (never something inherited like __proto__). */
function own<T>(rec: Record<string, T> | undefined, id: unknown): T | undefined {
  return rec && typeof id === 'string' && Object.hasOwn(rec, id) ? rec[id] : undefined;
}

/** Card art must be an image uploaded to this room (no outside URLs that could track players). */
const isArt = (v: unknown, state: RoomState) =>
  typeof v === 'string' && v.length <= 300 && v.startsWith(`/assets/${state.id}/`) && /^\/assets\/[a-z0-9-]+\/[\w-]+\.(png|jpg|webp|gif|avif)$/.test(v);

const STROKE_SHAPES: StrokeShape[] = ['path', 'line', 'arrow', 'rect', 'ellipse', 'text'];

function checkStrokePoints(pts: unknown, shape: StrokeShape) {
  const need = shape === 'text' ? 2 : shape === 'path' ? 0 : 4;
  if (!Array.isArray(pts) || pts.length < 2 || pts.length % 2 || pts.length > MAX_STROKE_POINTS * 2) fail('Bad stroke points.');
  if (need && pts.length !== need) fail(`A ${shape} needs ${need / 2} point${need === 2 ? '' : 's'}.`);
  if (!pts.every((v) => Number.isInteger(v) && v > -5000 && v < 20000)) fail('Bad stroke points.');
}

function checkStrokeText(t: unknown) {
  if (typeof t !== 'string' || !t.trim() || t.length > 1000) fail('Text is 1–1000 characters.');
  if (t.split('\n').length > 40) fail('Text is at most 40 lines.');
}

const ZONE_KEYS = new Set(['id', 'kind', 'label', 'owner', 'slots', 'fields', 'map', 'template']);

function checkTemplate(t: SheetTemplate, id: string): SheetTemplate {
  if (!isId(id)) fail('Bad template id.');
  const errs = templateErrors(t);
  if (errs.length) fail(`Template problem: ${errs[0]}`);
  return normalizeTemplate(t, id);
}

function checkMap(m: unknown, state: RoomState) {
  const map = m as { image?: unknown; scale?: unknown; x?: unknown; y?: unknown };
  if (!map || typeof map !== 'object' || Object.keys(map).some((k) => !['image', 'scale', 'x', 'y'].includes(k))) fail('Bad map.');
  if (!own(state.images, map.image)) fail('That map image is not in the library.');
  if (!isNum(map.scale) || map.scale < 0.1 || map.scale > 10) fail('Map size must be between 10% and 1000%.');
  for (const v of [map.x, map.y]) {
    if (v !== undefined && !(Number.isInteger(v) && (v as number) >= 0 && (v as number) <= 20000)) fail('Bad map position.');
  }
}

/** Is an image in use (as a map or the spotlight)? Those can't be deleted. */
function imageInUse(state: RoomState, id: string) {
  return state.spotlight?.image === id || Object.values(state.zones).some((z) => z.map?.image === id);
}
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

function checkZone(z: Zone) {
  if (!z || typeof z !== 'object' || !isId(z.id)) fail('Zone needs an id.');
  const extra = Object.keys(z).find((k) => !ZONE_KEYS.has(k));
  if (extra) fail(`Unknown zone field ${extra}.`);
  if (!ZONE_KINDS.includes(z.kind)) fail(`Unknown zone kind "${z.kind}".`);
  if (!isText(z.label, 80)) fail('Zone label is too long.');
  if (z.owner !== undefined && !isText(z.owner, 40)) fail('Bad zone owner.');
  if (z.slots !== undefined) checkSlots(z.slots);
  if (z.map !== undefined && z.kind !== 'board') fail('Only a table can have a map.');
  if (z.template !== undefined && z.kind !== 'slots') fail('Only a sheet can use a template.');
  if (z.fields !== undefined) {
    if (!z.fields || typeof z.fields !== 'object' || Object.keys(z.fields).length > MAX_FIELDS) fail('Too many fields.');
    for (const [k, v] of Object.entries(z.fields)) checkField(k, v);
  }
}

function checkSlots(slots: unknown) {
  if (!Array.isArray(slots) || slots.length > 50 || !slots.every((l) => isText(l, 40))) fail('Bad slot labels.');
}

function checkField(key: unknown, value: unknown) {
  if (!isKey(key, 40)) fail('Field names are 1–40 characters.');
  if (!isText(value, 4000)) fail('Field values are at most 4000 characters.');
}

function checkCard(c: Partial<CardDef>, partial: boolean, state: RoomState) {
  if (!c || typeof c !== 'object') fail('Bad card.');
  for (const k of ['name', 'front', 'back', 'upgraded'] as const) {
    const v = c[k];
    if (v === undefined) {
      if (!partial && (k === 'name' || k === 'front')) fail(`Card needs a ${k}.`);
      continue;
    }
    if (k === 'name') {
      if (!isText(v, 120)) fail('Bad card name.');
    } else if (!(k !== 'front' && v === '') && !isArt(v, state)) {
      fail(`Card ${k} must be an image uploaded to this room.`);
    }
  }
  const extra = Object.keys(c).filter((k) => !['id', 'name', 'front', 'back', 'upgraded'].includes(k));
  if (extra.length) fail(`Unknown card field ${extra[0]}.`);
}

function checkPieceProps(set: Partial<PieceProps>, state: RoomState) {
  for (const [k, v] of Object.entries(set)) {
    const ok = (() => {
      switch (k) {
        case 'zone': return isId(v) && !!own(state.zones, v);
        case 'index': case 'x': case 'y': return isNum(v);
        case 'faceUp': case 'tapped': case 'upgraded': return typeof v === 'boolean';
        case 'note': return isText(v, 1000);
        case 'visibleTo': return VISIBILITY.includes(v as Visibility);
        case 'owner': return v === undefined || isText(v, 40);
        case 'scale': return isNum(v) && v >= 0.2 && v <= 20;
        case 'counters':
          return !!v && typeof v === 'object' && Object.keys(v).length <= 20 &&
            Object.entries(v).every(([name, n]) => isKey(name, 30) && isNum(n));
        default: return false;
      }
    })();
    if (!ok) fail(`Bad value for piece ${k}.`);
  }
}

/** Every field a piece must have, for piece.create. */
const PIECE_REQUIRED: (keyof PieceProps)[] = ['zone', 'index', 'x', 'y', 'faceUp', 'tapped', 'upgraded', 'counters', 'note', 'visibleTo'];

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
        const label = isText(op.label, 60) && op.label.trim() ? op.label : undefined;
        return { kind: 'roll', expr: op.expr, ...(label ? { label } : {}), result: roll(op.expr, ctx.rand) };
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
      if (op.label !== undefined && !isText(op.label, 60)) fail('Roll label is too long.');
      return null;

    case 'template.create': {
      const templates = (state.templates ??= {});
      const t = op.template ?? fail('Missing template.');
      if (own(templates, t.id)) fail('A template with that id already exists.');
      if (Object.keys(templates).length >= MAX_TEMPLATES) fail(`A room holds at most ${MAX_TEMPLATES} templates.`);
      templates[t.id] = checkTemplate(t, t.id);
      return { kind: 'template.delete', id: t.id };
    }

    case 'template.update': {
      const prev = own(state.templates, op.id) ?? fail('No such template.');
      state.templates![op.id] = checkTemplate(op.template, op.id);
      return { kind: 'template.update', id: op.id, template: prev };
    }

    case 'template.delete': {
      const t = own(state.templates, op.id) ?? fail('No such template.');
      if (Object.values(state.zones).some((z) => z.template === op.id)) fail(`"${t.name}" is used by a sheet.`);
      delete state.templates![op.id];
      return { kind: 'template.create', template: t };
    }

    case 'gm': {
      if (op.seat !== null && !isText(op.seat, 40)) fail('Bad GM seat.');
      const prev = state.gm;
      state.gm = op.seat;
      return { kind: 'gm', seat: prev };
    }

    case 'zone.create':
      checkZone(op.zone);
      if (op.zone.map !== undefined) checkMap(op.zone.map, state);
      if (op.zone.template !== undefined && !own(state.templates, op.zone.template)) fail('That sheet template is not in this room.');
      if (Object.keys(state.zones).length >= MAX_ZONES) fail(`A room holds at most ${MAX_ZONES} zones.`);
      if (own(state.zones, op.zone.id)) fail(`Zone ${op.zone.id} already exists.`);
      state.zones[op.zone.id] = { ...op.zone };
      return { kind: 'zone.delete', id: op.zone.id };

    case 'zone.delete': {
      const zone = own(state.zones, op.id) ?? fail(`No zone ${op.id}.`);
      if (Object.values(state.pieces).some((p) => p.zone === op.id)) fail(`Zone "${zone.label}" isn't empty.`);
      delete state.zones[op.id];
      return { kind: 'zone.create', zone };
    }

    case 'zone.update': {
      const zone = own(state.zones, op.id) ?? fail(`No zone ${op.id}.`);
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
      const zone = own(state.zones, op.zone) ?? fail(`No zone ${op.zone}.`);
      if (op.value !== null) checkField(op.key, op.value);
      else if (!isKey(op.key, 40)) fail('Bad field name.');
      const fields = (zone.fields ??= {});
      const has = Object.hasOwn(fields, op.key);
      const prev = has ? fields[op.key] : null;
      if (op.value === null) delete fields[op.key];
      else {
        if (!has && Object.keys(fields).length >= MAX_FIELDS) fail('Too many fields.');
        fields[op.key] = op.value;
      }
      if (!Object.keys(fields).length) delete zone.fields;
      return { kind: 'field.set', zone: op.zone, key: op.key, value: prev };
    }

    case 'card.create': {
      const c = op.card;
      if (!c || !isId(c.id)) fail('Bad card.');
      checkCard(c, false, state);
      if (Object.keys(state.cards).length >= MAX_CARDS) fail(`A room holds at most ${MAX_CARDS} cards.`);
      if (own(state.cards, c.id)) fail(`Card ${c.id} already exists.`);
      state.cards[c.id] = { ...c };
      return { kind: 'card.delete', id: c.id };
    }

    case 'card.update': {
      const c = own(state.cards, op.id) ?? fail(`No card ${op.id}.`);
      if (!op.set || typeof op.set !== 'object' || 'id' in op.set) fail('Bad card update.');
      checkCard(op.set, true, state);
      // '' means "no image" for back/upgraded (JSON drops undefined).
      const prev = Object.fromEntries(Object.keys(op.set).map((k) => [k, c[k as keyof CardDef] ?? '']));
      Object.assign(c, op.set);
      for (const k of ['back', 'upgraded'] as const) if (!c[k]) delete c[k];
      if (!c.name || !c.front) fail('A card needs a name and a front image.');
      return { kind: 'card.update', id: op.id, set: prev };
    }

    case 'card.delete': {
      const c = own(state.cards, op.id) ?? fail(`No card ${op.id}.`);
      if (Object.values(state.pieces).some((p) => p.def === op.id)) fail(`"${c.name}" is still on the table.`);
      delete state.cards[op.id];
      return { kind: 'card.create', card: c };
    }

    case 'piece.create': {
      const p = op.piece;
      if (!p || !isId(p.id) || !isId(p.def)) fail('Bad piece.');
      if (own(state.pieces, p.id)) fail(`Piece ${p.id} already exists.`);
      const { id: _id, def: _def, ...props } = p;
      const missing = PIECE_REQUIRED.find((k) => props[k] === undefined);
      if (missing) fail(`Piece is missing ${missing}.`);
      checkPieceProps(props, state);
      if (Object.keys(state.pieces).length >= MAX_PIECES) fail(`A room holds at most ${MAX_PIECES} pieces.`);
      state.pieces[p.id] = structuredClone(p);
      return { kind: 'piece.delete', id: p.id };
    }

    case 'piece.delete': {
      const p = own(state.pieces, op.id) ?? fail(`No piece ${op.id}.`);
      delete state.pieces[op.id];
      return { kind: 'piece.create', piece: p };
    }

    case 'piece.update': {
      const p = own(state.pieces, op.id) ?? fail(`No piece ${op.id}.`);
      if (!op.set || typeof op.set !== 'object') fail('Nothing to update.');
      checkPieceProps(op.set, state);
      const set: Partial<PieceProps> = { ...op.set };
      // Moving to another zone without an index appends to the end of it.
      if (set.zone !== undefined && set.zone !== p.zone && set.index === undefined) set.index = nextIndex(state, set.zone);
      // JSON drops undefined, so optional fields go into the inverse as their defaults.
      const defaults: Partial<PieceProps> = { scale: 1, owner: '' };
      const prev = Object.fromEntries(
        Object.keys(set).map((k) => [k, structuredClone(p[k as keyof PieceProps] ?? defaults[k as keyof PieceProps])]),
      );
      Object.assign(p, structuredClone(set));
      if (p.scale === 1) delete p.scale;
      if (p.owner === '') delete p.owner;
      return { kind: 'piece.update', id: op.id, set: prev as Partial<PieceProps> };
    }

    case 'draw': {
      const from = own(state.zones, op.from) ?? fail(`No zone ${op.from}.`);
      const to = own(state.zones, op.to) ?? fail(`No zone ${op.to}.`);
      if (from.kind !== 'deck') fail(`"${from.label}" isn't a deck.`);
      if (!op.ids?.length) fail('Draw has no cards.');
      const undo: Op[] = [];
      for (const id of op.ids) {
        const p = own(state.pieces, id);
        if (!p || p.zone !== op.from) fail('Drawn card is no longer in the deck.');
        undo.push({ kind: 'piece.update', id, set: { zone: p.zone, index: p.index, faceUp: p.faceUp } });
        Object.assign(p, { zone: op.to, index: nextIndex(state, op.to), faceUp: to.kind !== 'deck' });
      }
      return { kind: 'batch', ops: undo.reverse() };
    }

    case 'image.create': {
      const img = op.image;
      const images = (state.images ??= {});
      if (!img || typeof img !== 'object' || !isId(img.id) || own(images, img.id)) fail('Bad or duplicate image.');
      const extra = Object.keys(img).find((k) => !['id', 'name', 'src', 'kind', 'hidden', 'by'].includes(k));
      if (extra) fail(`Unknown image field ${extra}.`);
      if (!isKey(img.name, 120)) fail('Image names are 1–120 characters.');
      if (!isArt(img.src, state)) fail('Images must be uploaded to this room.');
      if (img.kind !== 'map' && img.kind !== 'handout') fail('An image is a map or a handout.');
      if (typeof img.hidden !== 'boolean' || !isText(img.by, 40)) fail('Bad image.');
      if (Object.keys(images).length >= MAX_IMAGES) fail(`A room holds at most ${MAX_IMAGES} images.`);
      images[img.id] = { id: img.id, name: img.name, src: img.src, kind: img.kind, hidden: img.hidden, by: img.by };
      return { kind: 'image.delete', id: img.id };
    }

    case 'image.update': {
      const img = own(state.images, op.id) ?? fail('No such image.');
      if (!op.set || typeof op.set !== 'object') fail('Nothing to update.');
      const keys = Object.keys(op.set);
      if (!keys.length || keys.some((k) => !['name', 'kind', 'hidden'].includes(k))) fail('Only name, kind and hidden can change.');
      if (op.set.name !== undefined && !isKey(op.set.name, 120)) fail('Image names are 1–120 characters.');
      if (op.set.kind !== undefined && op.set.kind !== 'map' && op.set.kind !== 'handout') fail('An image is a map or a handout.');
      if (op.set.hidden !== undefined && typeof op.set.hidden !== 'boolean') fail('Bad hidden flag.');
      const prev = Object.fromEntries(keys.map((k) => [k, img[k as 'name' | 'kind' | 'hidden']]));
      Object.assign(img, op.set);
      return { kind: 'image.update', id: op.id, set: prev };
    }

    case 'image.delete': {
      const img = own(state.images, op.id) ?? fail('No such image.');
      if (imageInUse(state, op.id)) fail(`"${img.name}" is in use as a map or on screen.`);
      delete state.images![op.id];
      return { kind: 'image.create', image: img };
    }

    case 'zone.map': {
      const zone = own(state.zones, op.id) ?? fail(`No zone ${op.id}.`);
      if (zone.kind !== 'board') fail('Only a table can have a map.');
      if (op.map !== null) checkMap(op.map, state);
      const prev = zone.map ? { ...zone.map } : null;
      if (op.map) {
        zone.map = { image: op.map.image, scale: op.map.scale };
        if (op.map.x) zone.map.x = op.map.x;
        if (op.map.y) zone.map.y = op.map.y;
      }
      else delete zone.map;
      return { kind: 'zone.map', id: op.id, map: prev };
    }

    case 'spotlight': {
      const sp = op.spotlight;
      if (sp !== null) {
        if (!sp || typeof sp !== 'object' || !own(state.images, sp.image) || !isText(sp.by, 40)) fail('Bad spotlight.');
      }
      const prev = state.spotlight ?? null;
      state.spotlight = sp ? { image: sp.image, by: sp.by } : null;
      return { kind: 'spotlight', spotlight: prev };
    }

    case 'counter.color': {
      if (!isKey(op.name, 30)) fail('Bad counter name.');
      if (op.color !== null && (typeof op.color !== 'string' || !/^#[0-9a-f]{6}$/i.test(op.color))) fail('Bad counter color.');
      const colors = (state.counterColors ??= {});
      const prev = Object.hasOwn(colors, op.name) ? colors[op.name] : null;
      if (op.color === null) delete colors[op.name];
      else {
        if (prev === null && Object.keys(colors).length >= 100) fail('Too many counter colors.');
        colors[op.name] = op.color;
      }
      return { kind: 'counter.color', name: op.name, color: prev };
    }

    case 'stroke.add': {
      const k = op.stroke;
      const strokes = (state.strokes ??= {});
      if (!k || typeof k !== 'object' || !isId(k.id) || own(strokes, k.id)) fail('Bad or duplicate stroke.');
      const extra = Object.keys(k).find((x) => !['id', 'zone', 'color', 'width', 'points', 'by', 'shape', 'fill', 'text'].includes(x));
      if (extra) fail(`Unknown drawing field ${extra}.`);
      if (own(state.zones, k.zone)?.kind !== 'board') fail('Strokes go on a table.');
      if (typeof k.color !== 'string' || !/^#[0-9a-f]{6}$/i.test(k.color)) fail('Bad stroke color.');
      if (!isNum(k.width) || k.width < 1 || k.width > 40) fail('Bad stroke width.');
      if (!isText(k.by, 40)) fail('Bad stroke author.');
      const shape = k.shape ?? 'path';
      if (!STROKE_SHAPES.includes(shape)) fail(`Unknown drawing shape "${String(shape)}".`);
      checkStrokePoints(k.points, shape);
      if (k.fill !== undefined && (typeof k.fill !== 'boolean' || (shape !== 'rect' && shape !== 'ellipse'))) fail('Only boxes and circles can be filled.');
      if (shape === 'text') checkStrokeText(k.text);
      else if (k.text !== undefined) fail('Only text drawings have text.');
      if (Object.keys(strokes).length >= MAX_STROKES) fail('The table is full of drawings; clear some first.');
      strokes[k.id] = {
        id: k.id, zone: k.zone, color: k.color, width: k.width, points: [...k.points], by: k.by,
        ...(shape !== 'path' ? { shape } : {}),
        ...(k.fill ? { fill: true } : {}),
        ...(shape === 'text' ? { text: k.text } : {}),
      };
      return { kind: 'stroke.delete', id: k.id };
    }

    case 'stroke.update': {
      const k = own(state.strokes, op.id) ?? fail('That drawing is already gone.');
      if (!op.set || typeof op.set !== 'object') fail('Nothing to update.');
      const keys = Object.keys(op.set);
      if (!keys.length || keys.some((x) => x !== 'points' && x !== 'text')) fail('Only a drawing\'s position or text can change.');
      if (op.set.points !== undefined) {
        checkStrokePoints(op.set.points, k.shape ?? 'path');
        if (op.set.points.length !== k.points.length) fail('A moved drawing keeps its number of points.');
      }
      if (op.set.text !== undefined) {
        if (k.shape !== 'text') fail('Only text drawings have text.');
        checkStrokeText(op.set.text);
      }
      const prev: { points?: number[]; text?: string } = {};
      if (op.set.points !== undefined) {
        prev.points = k.points;
        k.points = [...op.set.points];
      }
      if (op.set.text !== undefined) {
        prev.text = k.text;
        k.text = op.set.text;
      }
      return { kind: 'stroke.update', id: op.id, set: prev };
    }

    case 'stroke.delete': {
      const k = own(state.strokes, op.id) ?? fail('That drawing is already gone.');
      delete state.strokes![op.id];
      return { kind: 'stroke.add', stroke: k };
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

/** Piece ids an op touches. */
function touched(op: Op): string[] {
  switch (op.kind) {
    case 'piece.create': return [op.piece.id];
    case 'piece.update': case 'piece.delete': return [op.id];
    case 'draw': return op.ids ?? [];
    case 'batch': return op.ops.flatMap(touched);
    case 'undo': return op.op ? touched(op.op) : [];
    default: return [];
  }
}

/** Names of the cards an op touched that everyone can see (face up, not hidden), for the log. */
export function publicNames(state: RoomState, op: Op): Record<string, string> | undefined {
  const names: Record<string, string> = {};
  for (const id of touched(op).slice(0, 50)) {
    const p = own(state.pieces, id);
    const card = p && own(state.cards, p.def);
    if (card && p.faceUp && p.visibleTo === 'all') names[id] = card.name;
  }
  return Object.keys(names).length ? names : undefined;
}

/** A new face-down piece for a card, ready for piece.create. */
export function newPiece(id: string, def: string, zone: string, extra: Partial<Piece> = {}): Piece {
  return {
    id, def, zone, index: 0, x: 0, y: 0, faceUp: false, tapped: false, upgraded: false,
    counters: {}, note: '', visibleTo: 'all', ...extra,
  };
}
