// Card faces and piece elements. Hidden information is the honor system: everyone has the data,
// this decides what each person's screen shows.
import type { Piece, RoomState } from '../../shared/model.ts';
import { h } from './dom';

/** Counter palette. A counter name keeps its color room-wide (RoomState.counterColors). */
export const COUNTER_COLORS = ['#f4d35e', '#ee6352', '#59cd90', '#3fa7d6', '#b48ead', '#f29e4c', '#fafafa', '#8a8a8a'];

export function counterColor(state: RoomState, name: string): string {
  const set = state.counterColors && Object.hasOwn(state.counterColors, name) ? state.counterColors[name] : undefined;
  if (set) return set;
  let hash = 0;
  for (const ch of name) hash = (hash * 31 + ch.charCodeAt(0)) | 0;
  return COUNTER_COLORS[Math.abs(hash) % COUNTER_COLORS.length];
}

/** Dark or light text, whichever reads better on `bg`. */
export function inkOn(bg: string): string {
  const n = parseInt(bg.slice(1), 16);
  const lum = 0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255);
  return lum > 150 ? '#1b150e' : '#fafafa';
}

/** Counter badges for a piece (on the card and in the large preview). */
export function counterBadges(p: Piece, state: RoomState): HTMLElement[] {
  return Object.entries(p.counters).map(([name, n]) => {
    const bg = counterColor(state, name);
    return h('span.badge.counter', { title: `${name}: ${n}`, style: { background: bg, color: inkOn(bg) } }, name.length <= 2 ? `${name}${n}` : `${n}`);
  });
}

export interface Face {
  /** Image to show, or null for the default card back. */
  src: string | null;
  front: boolean;
  /** You can see the front but (some) others can't. */
  secret: boolean;
}

export function faceOf(p: Piece, state: RoomState, me: string): Face {
  const card = state.cards[p.def];
  const back = card?.back ?? null;
  if (!card || !p.faceUp) return { src: back, front: false, secret: false };
  const allowed =
    p.visibleTo === 'all' ||
    (p.visibleTo === 'gm' && state.gm === me) ||
    (p.visibleTo === 'owner' && p.owner === me);
  if (!allowed) return { src: back, front: false, secret: false };
  const src = p.upgraded && card.upgraded ? card.upgraded : card.front;
  return { src, front: true, secret: p.visibleTo !== 'all' };
}

export function cardName(p: Piece, state: RoomState, me: string): string {
  return faceOf(p, state, me).front ? state.cards[p.def]?.name ?? 'Card' : 'Face-down card';
}

const els = new Map<string, HTMLElement>();

/** The (reused) element for a piece, updated to its current state. */
export function pieceEl(p: Piece, state: RoomState, me: string): HTMLElement {
  let el = els.get(p.id);
  if (!el) {
    el = h('div.piece', { dataset: { piece: p.id }, tabIndex: 0 });
    els.set(p.id, el);
  }
  const face = faceOf(p, state, me);
  const colors = Object.keys(p.counters).map((n) => counterColor(state, n));
  const key = JSON.stringify([face, p.tapped, p.upgraded, p.counters, colors, p.note, p.visibleTo, !!p.locked]);
  if (el.dataset.key !== key) {
    el.dataset.key = key;
    const body = face.src
      ? h('img', { src: face.src, alt: face.front ? state.cards[p.def]?.name ?? '' : 'Card back', draggable: false })
      : h('div.back-default', {}, h('span', {}, 'PAC'));
    const badges = h('div.badges', {}, ...counterBadges(p, state));
    if (p.upgraded) badges.append(h('span.badge.upgraded', { title: 'Upgraded' }, '★'));
    if (p.note) badges.append(h('span.badge.note', { title: p.note }, '✎'));
    if (face.secret) badges.append(h('span.badge.secret', { title: 'Hidden from other players' }, '👁'));
    if (p.locked) badges.append(h('span.badge.locked', { title: 'Locked in place' }, '🔒'));
    el.replaceChildren(body, badges);
  }
  el.style.setProperty('--scale', String(p.scale ?? 1));
  el.classList.toggle('tapped', p.tapped);
  el.classList.toggle('face-down', !face.front);
  el.classList.toggle('locked', !!p.locked);
  el.title = cardName(p, state, me);
  return el;
}

/** Forget elements for pieces that no longer exist (or are hidden in a deck). */
export function prunePieceEls(keep: Set<string>) {
  for (const [id, el] of els) {
    if (!keep.has(id)) {
      el.remove();
      els.delete(id);
    }
  }
}
