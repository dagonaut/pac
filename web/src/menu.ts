// The one popup menu (cards, zones, library, images). Opens next to an anchor rectangle and
// closes on an outside click, Escape, or after an item runs.
import { h } from './dom';

const menu = h('div.menu', { hidden: true });
document.body.append(menu);

export function closeMenu() {
  menu.hidden = true;
  menu.replaceChildren();
  if (menu.parentElement !== document.body) document.body.append(menu);
}

export function openMenu(anchor: DOMRect, ...items: (Node | false | null | undefined)[]) {
  // A modal dialog sits in the top layer; the menu has to be inside it to appear above it.
  const dialog = document.querySelector('dialog[open]');
  if (dialog && menu.parentElement !== dialog) dialog.append(menu);
  menu.replaceChildren(...items.filter((i): i is Node => !!i));
  menu.hidden = false;
  const r = menu.getBoundingClientRect();
  const left = Math.min(anchor.right + 6, window.innerWidth - r.width - 8);
  const top = Math.min(anchor.top, window.innerHeight - r.height - 8);
  menu.style.left = `${Math.max(8, left)}px`;
  menu.style.top = `${Math.max(8, top)}px`;
}

document.addEventListener('pointerdown', (e) => {
  if (!menu.hidden && !menu.contains(e.target as Node)) closeMenu();
});
document.addEventListener('keydown', (e) => e.key === 'Escape' && closeMenu());

export const item = (label: string, run: () => unknown, opts: { hint?: string; danger?: boolean } = {}) =>
  h('button.menu-item', {
    type: 'button',
    className: `menu-item${opts.danger ? ' danger' : ''}`,
    onclick: () => {
      closeMenu();
      void run();
    },
  }, label, opts.hint ? h('kbd', {}, opts.hint) : null);

export const heading = (text: string) => h('div.menu-heading', {}, text);
