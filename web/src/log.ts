// The room log: chat, rolls and a one-line description of every other action.
import { describeRoll } from '../../shared/dice.ts';
import type { LogEntry, Op, RoomState } from '../../shared/model.ts';

const logEl = document.querySelector<HTMLOListElement>('#log')!;

function scrollToEnd() {
  logEl.scrollTop = logEl.scrollHeight;
}

function describe(op: Op, state: RoomState): string {
  const card = (id: string) => state.cards[state.pieces[id]?.def]?.name ?? 'a card';
  const zone = (id: string) => state.zones[id]?.label ?? id;
  switch (op.kind) {
    case 'gm': return op.seat ? `took the GM seat` : 'left the GM seat';
    case 'zone.create': return `added ${op.zone.label}`;
    case 'zone.delete': return `removed a zone`;
    case 'card.create': return `imported ${op.card.name}`;
    case 'piece.create': return `added ${card(op.piece.id)}`;
    case 'piece.delete': return `removed a card`;
    case 'piece.update': {
      const s = op.set;
      if (s.zone) return `moved ${card(op.id)} to ${zone(s.zone)}`;
      if (s.faceUp !== undefined) return `flipped ${card(op.id)} ${s.faceUp ? 'face up' : 'face down'}`;
      if (s.tapped !== undefined) return `${s.tapped ? 'tapped' : 'untapped'} ${card(op.id)}`;
      return `changed ${card(op.id)}`;
    }
    case 'draw': return `drew ${op.count} from ${zone(op.from)} to ${zone(op.to)}`;
    case 'batch': return `did ${op.ops.length} things`;
    case 'undo': return 'undid their last action';
    default: return op.kind;
  }
}

export function addEntry(entry: LogEntry, state: RoomState) {
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
    li.append(` ${describe(op, state)}`);
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

export function resetLog(entries: LogEntry[], state: RoomState) {
  logEl.replaceChildren();
  entries.forEach((e) => addEntry(e, state));
}

export function clearLog() {
  logEl.replaceChildren();
}
