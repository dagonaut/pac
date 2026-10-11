// Card faces and piece elements. Hidden information is the honor system: everyone has the data,
// this decides what each person's screen shows.
import type { Piece, RoomState } from '../../shared/model.ts';
import { h } from './dom';

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
  const key = JSON.stringify([face, p.tapped, p.upgraded, p.counters, p.note, p.visibleTo]);
  if (el.dataset.key !== key) {
    el.dataset.key = key;
    const body = face.src
      ? h('img', { src: face.src, alt: face.front ? state.cards[p.def]?.name ?? '' : 'Card back', draggable: false })
      : h('div.back-default', {}, h('span', {}, 'PAC'));
    const badges = h('div.badges');
    for (const [name, n] of Object.entries(p.counters)) {
      badges.append(h('span.badge.counter', { title: name }, name.length <= 2 ? `${name}${n}` : `${n}`));
    }
    if (p.upgraded) badges.append(h('span.badge.upgraded', { title: 'Upgraded' }, '★'));
    if (p.note) badges.append(h('span.badge.note', { title: p.note }, '✎'));
    if (face.secret) badges.append(h('span.badge.secret', { title: 'Hidden from other players' }, '👁'));
    el.replaceChildren(body, badges);
  }
  el.style.setProperty('--scale', String(p.scale ?? 1));
  el.classList.toggle('tapped', p.tapped);
  el.classList.toggle('face-down', !face.front);
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
