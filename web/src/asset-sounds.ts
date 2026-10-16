// Sound effects linked to an image or a card: the GM plays them from its menu (a roar when the
// monster appears, another when it attacks), and one can play by itself when it's revealed.
import type { CardDef, ImageDef, Op, RoomState } from '../../shared/model.ts';
import { h } from './dom';
import { heading, item } from './menu';

export type AssetRef = { kind: 'image' | 'card'; id: string };

interface Ctx {
  me: string;
  state: RoomState;
  act(op: Op): Promise<boolean>;
}

/** A card put on the table from an image ("card-img-<image id>") uses that image's sounds unless it
 *  has its own. */
export function assetSounds(state: RoomState, ref: AssetRef): { sounds: string[]; onReveal?: string; owner: AssetRef } {
  if (ref.kind === 'image') {
    const img: ImageDef | undefined = state.images?.[ref.id];
    return { sounds: img?.sounds ?? [], onReveal: img?.onReveal, owner: ref };
  }
  const card: CardDef | undefined = state.cards[ref.id];
  if (card?.sounds?.length || !ref.id.startsWith('card-img-')) return { sounds: card?.sounds ?? [], onReveal: card?.onReveal, owner: ref };
  const imgId = Object.keys(state.images ?? {}).find((id) => `card-img-${id}`.slice(0, 64) === ref.id);
  return imgId ? assetSounds(state, { kind: 'image', id: imgId }) : { sounds: [], owner: ref };
}

/** Menu items: the asset's sounds (to play for everyone) and "Sounds…" to set them up. GM only:
 *  sound belongs to the GM seat. */
export function soundMenuItems(ctx: Ctx, ref: AssetRef): (Node | false)[] {
  if (ctx.state.gm !== ctx.me) return [];
  const { sounds, onReveal, owner } = assetSounds(ctx.state, ref);
  const sfx = Object.values(ctx.state.sounds ?? {}).filter((s) => s.kind === 'sfx');
  if (!sounds.length && !sfx.length) return [];
  return [
    heading('Sounds'),
    ...sounds.map((id) => {
      const s = ctx.state.sounds?.[id];
      return !!s && item(`♪ ${s.name}${id === onReveal ? ' (on reveal)' : ''}`, () => ctx.act({ kind: 'sfx', sound: id }));
    }),
    item(sounds.length ? 'Change sounds…' : 'Add sounds…', () => editAssetSounds(ctx, owner)),
  ];
}

/** Pick which sound effects go with an asset, and which one (if any) plays when it's revealed. */
export function editAssetSounds(ctx: Ctx, ref: AssetRef) {
  const state = ctx.state;
  const asset = ref.kind === 'image' ? state.images?.[ref.id] : state.cards[ref.id];
  if (!asset) return;
  const current = assetSounds(state, ref);
  const sfx = Object.values(state.sounds ?? {}).filter((s) => s.kind === 'sfx')
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  const chosen = new Set(current.sounds);
  let reveal = current.onReveal ?? '';
  const group = `reveal-${Math.random().toString(36).slice(2)}`;
  const list = h('ul.asset-sound-list');
  const paint = () => list.replaceChildren(...sfx.map((s) => {
    const on = chosen.has(s.id);
    const box = h('input', { type: 'checkbox', checked: on });
    box.addEventListener('change', () => {
      if (box.checked) chosen.add(s.id);
      else {
        chosen.delete(s.id);
        if (reveal === s.id) reveal = '';
      }
      paint();
    });
    const radio = h('input', { type: 'radio', name: group, checked: on && reveal === s.id, disabled: !on });
    radio.addEventListener('change', () => { reveal = s.id; });
    return h('li', {},
      h('label.check', {}, box, ` ${s.name}`),
      h('button', { type: 'button', title: 'Listen (just you)', onclick: () => void new Audio(s.src).play() }, '▶'),
      h('label.check.reveal', { title: 'Plays by itself when this is shown to everyone, put on the table or turned face up' }, radio, ' on reveal'));
  }));
  paint();
  const none = h('input', { type: 'radio', name: group, checked: !reveal });
  none.addEventListener('change', () => { reveal = ''; });
  const dialog = h('dialog.modal.asset-sounds', { onclose: () => dialog.remove() },
    h('h3', {}, `Sounds for ${asset.name}`),
    sfx.length
      ? h('p.muted', {}, 'Tick the effects that go with it; play them from its menu. One can play by itself when it\'s revealed.')
      : h('p.muted', {}, 'No sound effects yet. Upload some in the ♪ Sound panel first.'),
    list,
    sfx.length > 0 && h('label.check', {}, none, ' Nothing plays on reveal'),
    h('div.dialog-buttons', {},
      h('button', { type: 'button', onclick: () => dialog.close() }, 'Cancel'),
      h('button', {
        type: 'button',
        className: 'primary',
        disabled: !sfx.length,
        onclick: async () => {
          const sounds = sfx.filter((s) => chosen.has(s.id)).map((s) => s.id);
          if (await ctx.act({ kind: 'asset.sounds', asset: ref, sounds, onReveal: reveal && chosen.has(reveal) ? reveal : null })) dialog.close();
        },
      }, 'Save')));
  document.body.append(dialog);
  dialog.showModal();
}

/** The reveal sound an op triggers, if any: an image shown to everyone, or a card turned face up
 *  (including put on the table face up). `state` is after the op. */
export function revealSounds(state: RoomState, op: Op): string[] {
  switch (op.kind) {
    case 'batch': return op.ops.flatMap((o) => revealSounds(state, o));
    case 'spotlight': {
      const id = op.spotlight ? assetSounds(state, { kind: 'image', id: op.spotlight.image }).onReveal : undefined;
      return id ? [id] : [];
    }
    case 'piece.update': case 'piece.create': {
      const p = op.kind === 'piece.create' ? op.piece : state.pieces[op.id];
      const turned = op.kind === 'piece.create' ? op.piece.faceUp && state.zones[op.piece.zone]?.kind === 'board' : op.set.faceUp === true;
      if (!p || !turned) return [];
      const id = assetSounds(state, { kind: 'card', id: p.def }).onReveal;
      return id ? [id] : [];
    }
    default: return [];
  }
}
