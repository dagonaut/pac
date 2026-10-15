// The room log: chat, rolls and a one-line description of every other action.
import { describeRoll } from '../../shared/dice.ts';
import type { LogEntry, Op, RoomState } from '../../shared/model.ts';
import { cardName } from './pieces';

const logEl = document.querySelector<HTMLOListElement>('#log')!;

function scrollToEnd() {
  logEl.scrollTop = logEl.scrollHeight;
}

/** First line of a multi-line text, with "…" if there's more. */
const firstLine = (t: string) => {
  const [line, ...rest] = t.split('\n');
  return rest.some((l) => l.trim()) ? `${line}…` : line;
};

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
    case 'field.set': {
      // Templated sheets: use the field's label and the owner's name ("set HP to 11 on Ana's sheet").
      const z = state.zones[op.zone];
      const tpl = z?.template ? state.templates?.[z.template] : undefined;
      const f = tpl?.sections.flatMap((s) => s.fields ?? []).find((x) => x.id === op.key);
      const key = f?.label ?? op.key;
      const where = z?.owner ? `${z.owner}'s sheet` : zone(op.zone);
      if (op.value === null) return `removed ${key} from ${where}`;
      const value = f?.type === 'checkbox' ? (op.value === 'true' ? 'on' : 'off') : f?.type === 'longtext' ? '…' : op.value;
      return `set ${key} to ${value} on ${where}`;
    }
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
      if (s.locked !== undefined) return `${s.locked ? 'locked' : 'unlocked'} ${card(op.id)}`;
      if (s.index !== undefined) {
        // The state is already updated: the piece is either on top of its zone or underneath.
        const p = state.pieces[op.id];
        const top = !!p && Object.values(state.pieces).every((q) => q.zone !== p.zone || q.index <= p.index);
        return `${top ? 'brought' : 'sent'} ${card(op.id)} to the ${top ? 'front' : 'back'}`;
      }
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
    case 'zone.map': return op.map ? `set the map to ${state.images?.[op.map.image]?.name ?? 'an image'} at ${Math.round(op.map.scale * 100)}%` : 'removed the map';
    case 'counter.color': return op.color ? `recolored every "${op.name}" counter` : `reset the "${op.name}" counter color`;
    case 'spotlight': return op.spotlight ? `is showing ${state.images?.[op.spotlight.image]?.name ?? 'an image'}` : 'closed the image on screen';
    case 'template.create': return `added the sheet template ${op.template.name}`;
    case 'template.update': return `edited the sheet template ${op.template.name}`;
    case 'template.delete': return 'deleted a sheet template';
    case 'stroke.add': {
      const k = op.stroke;
      if (k.shape === 'text') return `wrote "${firstLine(k.text ?? '')}" on the table`;
      const what = { line: 'a line', arrow: 'an arrow', rect: 'a box', ellipse: 'a circle', path: '', text: '' }[k.shape ?? 'path'];
      return what ? `drew ${what} on the table` : 'drew on the table';
    }
    case 'stroke.delete': return 'erased a drawing';
    case 'sound.create': return `added the ${op.sound.kind === 'music' ? 'track' : 'sound effect'} ${op.sound.name}`;
    case 'sound.update': return op.set.name ? `renamed a sound to ${op.set.name}` : `made ${state.sounds?.[op.id]?.name ?? 'a sound'} ${op.set.kind === 'music' ? 'music' : 'a sound effect'}`;
    case 'sound.delete': return 'deleted a sound';
    case 'music': {
      const s = op.set;
      const track = state.music && state.sounds?.[state.music.playlist[state.music.index]]?.name;
      if (s.index !== undefined && state.music?.playing) return `is playing ${track ?? 'music'}`;
      if (s.playing === true) return `started the music${track ? `: ${track}` : ''}`;
      if (s.playing === false) return s.position === 0 ? 'stopped the music' : 'paused the music';
      if (s.playlist) return 'changed the playlist';
      if (s.position !== undefined) return 'skipped ahead in the music';
      if (s.loop) return { all: 'set the music to repeat the playlist', one: 'set the music to repeat the track', off: 'turned off music repeat' }[s.loop];
      if (s.shuffle !== undefined) return s.shuffle ? 'turned on shuffle' : 'turned off shuffle';
      if (s.volume !== undefined) return `set the music volume to ${Math.round(s.volume * 100)}%`;
      return 'changed the music';
    }
    case 'sfx': return op.sound ? `played ${state.sounds?.[op.sound]?.name ?? 'a sound effect'}` : 'stopped the sound effects';
    case 'stroke.update': return op.set.text !== undefined ? `changed text to "${firstLine(op.set.text)}"` : 'moved a drawing';
    case 'batch': {
      if (op.ops.length && op.ops.every((o) => o.kind === 'stroke.delete')) return `cleared ${op.ops.length} drawing${op.ops.length === 1 ? '' : 's'}`;
      if (op.ops.length && op.ops.every((o) => o.kind === 'image.create')) return `uploaded ${op.ops.length} image${op.ops.length === 1 ? '' : 's'}`;
      // A side effect plus the main action (an image reveal + set map, a counter color + add counter):
      // describe the main action.
      if (op.ops.some((o) => o.kind === 'image.update' || o.kind === 'counter.color')) {
        const main = op.ops.filter((o) => o.kind !== 'image.update' && o.kind !== 'card.create' && o.kind !== 'counter.color');
        if (main.length === 1) return describe(main[0], state, me, names);
      }
      const fromImage = op.ops.find((o) => o.kind === 'card.create' && o.card.id.startsWith('card-img-'));
      if (fromImage && fromImage.kind === 'card.create') return `put ${fromImage.card.name} on the table`;
      const imported = op.ops.filter((o) => o.kind === 'card.create').length;
      if (imported) return `imported ${imported} card${imported === 1 ? '' : 's'}`;
      const sounds = op.ops.filter((o) => o.kind === 'sound.create');
      if (sounds.length) {
        const music = sounds.every((o) => o.kind === 'sound.create' && o.sound.kind === 'music');
        return `uploaded ${sounds.length} ${music ? `track${sounds.length === 1 ? '' : 's'}` : `sound effect${sounds.length === 1 ? '' : 's'}`}`;
      }
      if (op.ops[0]?.kind === 'zone.map') return 're-centered the map (and what was on it)';
      const moves = op.ops.filter((o) => o.kind === 'piece.update').length;
      if (moves === op.ops.length) return `moved ${moves} card${moves === 1 ? '' : 's'}`;
      return `made ${op.ops.length} changes`;
    }
    case 'undo': return 'undid their last action';
    default: return op.kind;
  }
}

/** Player name -> color, for names in the log (guests have none). */
let nameColors = new Map<string, string>();
export function setNameColors(colors: Map<string, string>) {
  nameColors = colors;
  for (const b of logEl.querySelectorAll<HTMLElement>('li > b')) b.style.color = nameColors.get(b.textContent ?? '') ?? '';
}

export function addEntry(entry: LogEntry, state: RoomState, me: string) {
  // A GM fading the music sends a stream of volume changes; they'd bury the log.
  if (entry.op.kind === 'music' && Object.keys(entry.op.set).every((k) => k === 'volume')) return;
  const li = document.createElement('li');
  li.title = new Date(entry.ts).toLocaleString();
  const who = document.createElement('b');
  who.textContent = entry.by;
  who.style.color = nameColors.get(entry.by) ?? '';
  li.append(who);
  const op = entry.op;
  if (op.kind === 'chat') {
    li.append(`: ${op.text}`);
  } else if (op.kind === 'roll' && op.result) {
    li.className = 'roll';
    li.append(` rolled ${op.label ? `${op.label} (${op.expr})` : op.expr}: `);
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
