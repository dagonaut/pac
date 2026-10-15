// Players: who's signed in, the admin's Players dialog (add players, roles, sign-in links) and
// each player's Profile (color, portrait, their own link for other devices).
import { PLAYER_COLORS, type PlayerInfo } from '../../shared/protocol.ts';
import {
  addPlayer, type Auth, listPlayers, playerLink, type PlayerRow, removePlayer, resetLink, updatePlayer,
} from './api';
import { h, toast } from './dom';
import { uploadPortrait } from './importer';

/** A round face: the portrait if there is one, else the initial on the player's color. */
export function face(p: Pick<PlayerInfo, 'name' | 'color' | 'portrait'> | undefined, name = p?.name ?? '?') {
  const el = h('span.face', { title: name, style: { background: p?.color ?? '#5a4d3c' } });
  if (p?.portrait) el.append(h('img', { src: p.portrait, alt: '' }));
  else el.textContent = name.slice(0, 1).toUpperCase();
  return el;
}

async function copy(text: string, what: string) {
  try {
    await navigator.clipboard.writeText(text);
    toast(`Copied ${what}.`);
  } catch {
    prompt(`Copy ${what}:`, text);
  }
}

function modal(cls: string, ...children: (Node | false | null | undefined)[]) {
  const dialog = h('dialog.modal', { className: cls, onclose: () => dialog.remove() }, ...children);
  document.body.append(dialog);
  dialog.showModal();
  return dialog;
}

/** Admins: the player list, roles, links. */
export function openPlayers(auth: Auth, me: PlayerInfo, changed: () => void) {
  const list = h('ul.player-list');
  const error = h('p.error', { hidden: true });
  const fail = (e: unknown) => {
    error.textContent = (e as Error).message;
    error.hidden = false;
  };

  async function fill() {
    try {
      const { players } = await listPlayers(auth);
      list.replaceChildren(...players.map(row));
      error.hidden = true;
    } catch (e) {
      fail(e);
    }
  }

  function row(p: PlayerRow) {
    const self = p.id === me.id;
    const role = (label: string, key: 'gm' | 'admin', title: string) => {
      const box = h('input', { type: 'checkbox', checked: p[key], disabled: self && key === 'admin' });
      box.addEventListener('change', async () => {
        try {
          await updatePlayer(auth, p.id, { [key]: box.checked });
          changed();
        } catch (e) {
          box.checked = !box.checked;
          fail(e);
        }
      });
      return h('label.role', { title }, box, label);
    };
    return h('li', {},
      face(p),
      h('strong', {}, p.name, self ? h('small.muted', {}, ' (you)') : null),
      role('GM', 'gm', 'Can take the GM seat'),
      role('Admin', 'admin', self ? "You can't remove your own admin role" : 'Can manage players'),
      h('span.row-actions', {},
        p.link && h('button', { type: 'button', title: 'Copy their sign-in link to send them', onclick: () => copy(playerLink(p.link!), `${p.name}'s link`) }, 'Copy link'),
        h('button', {
          type: 'button',
          title: 'Make a new link; the old one stops working (e.g. it was shared by mistake)',
          onclick: async () => {
            if (!confirm(`Make a new link for ${p.name}? Their old link stops working, and they'll need the new one on every device.`)) return;
            try {
              const { link } = await resetLink(auth, p.id);
              await copy(playerLink(link), `${p.name}'s new link`);
              if (self) location.href = playerLink(link); // re-sign in with it
            } catch (e) {
              fail(e);
            }
          },
        }, 'New link'),
        !self && h('button.danger', {
          type: 'button',
          onclick: async () => {
            if (!confirm(`Remove ${p.name}? Their link stops working. Their sheets and cards stay in the rooms.`)) return;
            try {
              await removePlayer(auth, p.id);
              await fill();
              changed();
            } catch (e) {
              fail(e);
            }
          },
        }, 'Remove')));
  }

  const name = h('input', { required: true, maxLength: 40, placeholder: 'Name, as it shows at the table' });
  const gm = h('input', { type: 'checkbox' });
  const admin = h('input', { type: 'checkbox' });
  const add = h('form.add-player', {
    onsubmit: async (e: Event) => {
      e.preventDefault();
      try {
        const { player, link } = await addPlayer(auth, name.value.trim(), { gm: gm.checked, admin: admin.checked });
        add.reset();
        await fill();
        changed();
        await copy(playerLink(link), `${player.name}'s sign-in link (send it to them)`);
      } catch (err) {
        fail(err);
      }
    },
  }, name, h('label.role', {}, gm, 'GM'), h('label.role', {}, admin, 'Admin'), h('button', { type: 'submit' }, 'Add player'));

  modal('players-dialog',
    h('h3', {}, 'Players'),
    h('p.muted', {}, 'Each player signs in with their own link: send it to them privately. Opening it once signs that browser in. Guests can still join with the table key, but not with a player\'s name.'),
    list, add, error,
    h('form', { method: 'dialog' }, h('div.dialog-buttons', {}, h('button', {}, 'Close'))));
  void fill();
}

/** Your own color, portrait and sign-in link. */
export function openProfile(credential: string, me: PlayerInfo, saved: (p: PlayerInfo) => void) {
  const auth = { player: credential };
  let current = me;
  const preview = h('div.profile-face');
  const error = h('p.error', { hidden: true });
  const paint = () => preview.replaceChildren(face(current), h('strong', {}, current.name));
  paint();
  const save = async (set: { color?: string; portrait?: string }) => {
    try {
      current = (await updatePlayer(auth, me.id, set)).player;
      paint();
      swatches.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.dataset.color === current.color));
      saved(current);
      error.hidden = true;
    } catch (e) {
      error.textContent = (e as Error).message;
      error.hidden = false;
    }
  };
  const swatches = h('div.swatches', {}, ...PLAYER_COLORS.map((c) => h('button.swatch', {
    type: 'button', title: c, dataset: { color: c }, className: c === me.color ? 'active' : '', style: { background: c },
    onclick: () => save({ color: c }),
  })));
  const file = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp,image/gif,image/avif', hidden: true });
  file.addEventListener('change', async () => {
    const f = file.files?.[0];
    if (!f) return;
    try {
      await save({ portrait: await uploadPortrait(credential, f) });
    } catch (e) {
      error.textContent = (e as Error).message;
      error.hidden = false;
    }
  });
  modal('profile-dialog',
    h('h3', {}, 'Profile'),
    preview,
    h('label', {}, 'Color', swatches),
    h('div.portrait-row', {},
      h('span.muted', {}, 'Portrait (shown when your camera is off)'),
      h('button', { type: 'button', onclick: () => file.click() }, 'Upload…'),
      h('button', { type: 'button', onclick: () => save({ portrait: '' }) }, 'Remove')),
    file,
    h('div.portrait-row', {},
      h('span.muted', {}, 'Your sign-in link, for your other devices. Keep it private: it is you.'),
      h('button', { type: 'button', onclick: () => copy(playerLink(credential), 'your sign-in link') }, 'Copy my link')),
    error,
    h('form', { method: 'dialog' }, h('div.dialog-buttons', {}, h('button', {}, 'Done'))));
}
