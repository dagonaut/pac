// The room log: chat, rolls and a one-line description of every other action.
import { describeRoll } from '../../shared/dice.ts';
import type { LogEntry, Op, RoomState } from '../../shared/model.ts';
import { cardName } from './pieces';

const logEl = document.querySelector<HTMLOListElement>('#log')!;

function scrollToEnd() {
  logEl.scrollTop = logEl.scrollHeight;
}

function describe(op: Op, state: RoomState, me: string, names: Record<string, string> = {}): string {
  // Names recorded when it happened (public cards only), else what you can see now. Face-down or
  // hidden cards aren't spoiled either way.
  const card = (id: string) => {
    if (names[id]) return names[id];
    const p = state.pieces[id];
    if (!p) return 'a card';
    const name = cardName(p, state, me);
    return name === 'Face-down card' ? 'a face-down card' : name;
  };
  const zone = (id: string) => state.zones[id]?.label ?? id;
  switch (op.kind) {
    case 'gm': return op.seat ? `took the GM seat` : 'left the GM seat';
    case 'zone.create': return `added ${op.zone.label}`;
    case 'zone.delete': return `removed a zone`;
    case 'zone.update': return op.set.label ? `renamed a zone to ${op.set.label}` : `changed ${zone(op.id)}`;
    case 'field.set': return op.value === null ? `removed ${op.key} from ${zone(op.zone)}` : `set ${op.key} to ${op.value} on ${zone(op.zone)}`;
    case 'card.create': return `imported ${op.card.name}`;
    case 'card.update': return `changed the art of ${state.cards[op.id]?.name ?? 'a card'}`;
    case 'card.delete': return 'removed a card from the library';
    case 'piece.create': return `added ${card(op.piece.id)}`;
    case 'piece.delete': return `removed a card`;
    case 'piece.update': {
      const s = op.set;
      if (s.zone) return `moved ${card(op.id)} to ${zone(s.zone)}`;
      if (s.faceUp !== undefined) return `flipped ${card(op.id)} ${s.faceUp ? 'face up' : 'face down'}`;
      if (s.tapped !== undefined) return `${s.tapped ? 'tapped' : 'untapped'} ${card(op.id)}`;
      if (s.upgraded !== undefined) return `${s.upgraded ? 'upgraded' : 'un-upgraded'} ${card(op.id)}`;
      if (s.visibleTo !== undefined) return s.visibleTo === 'all' ? `revealed ${card(op.id)}` : 'hid a card from players';
      if (s.counters !== undefined) return `changed counters on ${card(op.id)}`;
      if (s.note !== undefined) return `wrote a note on ${card(op.id)}`;
      if (s.scale !== undefined) return `resized ${card(op.id)}`;
      if (s.x !== undefined) return `moved ${card(op.id)}`;
      return `changed ${card(op.id)}`;
    }
    case 'draw': return `drew ${op.count} from ${zone(op.from)} to ${zone(op.to)}`;
    case 'image.create': return op.image.hidden ? 'uploaded a hidden image' : `uploaded ${op.image.name}`;
    case 'image.update': {
      const img = state.images?.[op.id];
      const name = img && (!img.hidden || state.gm === me || img.by === me) ? img.name : 'an image';
      if (op.set.hidden === false) return `revealed ${name}`;
      if (op.set.hidden === true) return 'hid an image';
      return op.set.name ? `renamed an image to ${op.set.name}` : `changed ${name}`;
    }
    case 'image.delete': return 'deleted an image';
    case 'zone.map': return op.map ? `set the map to ${state.images?.[op.map.image]?.name ?? 'an image'}` : 'removed the map';
    case 'spotlight': return op.spotlight ? `is showing ${state.images?.[op.spotlight.image]?.name ?? 'an image'}` : 'closed the image on screen';
    case 'stroke.add': return 'drew on the table';
    case 'stroke.delete': return 'erased a drawing';
    case 'batch': {
      if (op.ops.length && op.ops.every((o) => o.kind === 'stroke.delete')) return `cleared ${op.ops.length} drawing${op.ops.length === 1 ? '' : 's'}`;
      if (op.ops.length && op.ops.every((o) => o.kind === 'image.create')) return `uploaded ${op.ops.length} image${op.ops.length === 1 ? '' : 's'}`;
      // An image reveal plus the action that used it (map, spotlight, put on table): describe the action.
      if (op.ops.some((o) => o.kind === 'image.update')) {
        const main = op.ops.filter((o) => o.kind !== 'image.update' && o.kind !== 'card.create');
        if (main.length === 1) return describe(main[0], state, me, names);
      }
      const fromImage = op.ops.find((o) => o.kind === 'card.create' && o.card.id.startsWith('card-img-'));
      if (fromImage && fromImage.kind === 'card.create') return `put ${fromImage.card.name} on the table`;
      const imported = op.ops.filter((o) => o.kind === 'card.create').length;
      if (imported) return `imported ${imported} card${imported === 1 ? '' : 's'}`;
      return `moved ${op.ops.length} cards`;
    }
    case 'undo': return 'undid their last action';
    default: return op.kind;
  }
}

export function addEntry(entry: LogEntry, state: RoomState, me: string) {
  const li = document.createElement('li');
  li.title = new Date(entry.ts).toLocaleString();
  const who = document.createElement('b');
  who.textContent = entry.by;
  li.append(who);
  const op = entry.op;
  if (op.kind === 'chat') {
    li.append(`: ${op.text}`);
  } else if (op.kind === 'roll' && op.result) {
    li.className = 'roll';
    li.append(` rolled ${op.expr}: `);
    const r = op.result;
    const single = r.terms.length === 1 && r.terms[0].count === 1 && !r.modifier;
    if (!single) li.append(describeRoll(r).replace(/ = -?\d+$/, ' = '));
    const total = document.createElement('span');
    total.textContent = String(r.total);
    if (single && r.total === r.terms[0].sides) total.className = 'max';
    if (single && r.total === 1) total.className = 'min';
    li.append(total);
  } else {
    li.className = 'action';
    li.append(` ${describe(op, state, me, entry.names)}`);
  }
  logEl.append(li);
  scrollToEnd();
}

/** Local-only notice (errors, hints). Not sent to the table. */
export function note(text: string) {
  const li = document.createElement('li');
  li.className = 'note';
  li.textContent = text;
  logEl.append(li);
  scrollToEnd();
}

export function resetLog(entries: LogEntry[], state: RoomState, me: string) {
  logEl.replaceChildren();
  entries.forEach((e) => addEntry(e, state, me));
}

export function clearLog() {
  logEl.replaceChildren();
}
