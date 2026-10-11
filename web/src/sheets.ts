// Character sheets: zones owned by a seat (slots for cards, plus fields like HP), shown in a dock
// under the table with a tab per player. Cards drag in and out like any other zone.
import type { Op, RoomState, Zone } from '../../shared/model.ts';
import { h, shortId } from './dom';
import { systems } from './systems/index';

export interface DockCtx {
  me: string;
  renderZone(z: Zone, state: RoomState): HTMLElement;
  act(op: Op): Promise<boolean>;
  addZone(anchor: DOMRect, owner: string): void;
}

let tab: string | null = null; // whose sheet is showing
let collapsed = false;
try {
  collapsed = localStorage.getItem('vtt.dockCollapsed') === '1';
} catch { /* ignore */ }

const isNumber = (v: string) => /^-?\d+$/.test(v.trim());

function fieldsEditor(z: Zone, ctx: DockCtx) {
  const set = (key: string, value: string | null) => ctx.act({ kind: 'field.set', zone: z.id, key, value });
  const rows = Object.entries(z.fields ?? {}).map(([key, value]) => {
    const input = h('input', {
      value,
      maxLength: 500,
      dataset: { field: `${z.id}/${key}` },
      onchange: () => void set(key, input.value),
      onkeydown: (e: KeyboardEvent) => e.key === 'Enter' && input.blur(),
    });
    const step = (d: number) => isNumber(value) && h('button.step', { type: 'button', onclick: () => set(key, String(Number(value) + d)) }, d > 0 ? '+' : '−');
    return h('div.field', {},
      h('label', {}, key),
      step(-1), input, step(1),
      h('button.step', { type: 'button', title: `Remove ${key}`, onclick: () => confirm(`Remove ${key}?`) && set(key, null) }, '×'),
    );
  });
  const add = h('button.add-field', {
    type: 'button',
    onclick: () => {
      const key = prompt('Field name (e.g. HP, Charge, Notes):')?.trim().slice(0, 40);
      if (key) void set(key, prompt(`Value for ${key}:`, '0') ?? '');
    },
  }, '+ Field');
  return h('div.fields', {}, ...rows, add);
}

function createSheet(state: RoomState, ctx: DockCtx) {
  const sheet = systems.find((s) => s.id === state.system)?.sheet;
  return ctx.act({
    kind: 'zone.create',
    zone: {
      id: `sheet-${shortId()}`,
      kind: 'slots',
      label: 'Sheet',
      owner: ctx.me,
      ...(sheet?.slots?.length ? { slots: sheet.slots } : {}),
      ...(sheet?.fields && Object.keys(sheet.fields).length ? { fields: { ...sheet.fields } } : {}),
    },
  });
}

export function renderDock(dock: HTMLElement, state: RoomState, ctx: DockCtx) {
  const owned = new Map<string, Zone[]>();
  for (const z of Object.values(state.zones)) {
    if (z.owner) owned.set(z.owner, [...(owned.get(z.owner) ?? []), z]);
  }
  const owners = [...owned.keys()].sort((a, b) => (a === ctx.me ? -1 : b === ctx.me ? 1 : a.localeCompare(b)));
  if (!tab || (!owned.has(tab) && tab !== ctx.me)) tab = ctx.me;

  const tabs = h('div.dock-tabs', {},
    ...owners.map((o) => h('button.dock-tab', {
      type: 'button',
      className: `dock-tab${o === tab ? ' active' : ''}`,
      onclick: () => {
        tab = o;
        collapsed = false;
        renderDock(dock, state, ctx);
      },
    }, o === ctx.me ? `${o} (you)` : o)),
    !owned.has(ctx.me) && h('button.dock-tab', {
      type: 'button',
      className: `dock-tab${tab === ctx.me ? ' active' : ''}`,
      onclick: () => {
        tab = ctx.me;
        collapsed = false;
        renderDock(dock, state, ctx);
      },
    }, 'My sheet'),
    h('span.spacer'),
    h('button.dock-toggle', {
      type: 'button',
      title: collapsed ? 'Show sheets' : 'Hide sheets',
      onclick: () => {
        collapsed = !collapsed;
        try {
          localStorage.setItem('vtt.dockCollapsed', collapsed ? '1' : '0');
        } catch { /* ignore */ }
        renderDock(dock, state, ctx);
      },
    }, collapsed ? '▴' : '▾'),
  );

  const body = h('div.dock-body', { hidden: collapsed });
  const zones = owned.get(tab!) ?? [];
  if (!zones.length) {
    body.append(tab === ctx.me
      ? h('div.dock-empty', {}, h('button', { type: 'button', onclick: () => void createSheet(state, ctx) }, 'Create my sheet'),
        h('span.muted', {}, ' Slots for your cards, plus fields like HP.'))
      : h('div.dock-empty.muted', {}, `${tab} has no sheet yet.`));
  }
  for (const z of zones) {
    body.append(h('div.sheet', {}, ctx.renderZone(z, state), fieldsEditor(z, ctx)));
  }
  if (zones.length) {
    const add = h('button.add-zone-btn', { type: 'button' }, '+ Zone');
    add.addEventListener('click', () => ctx.addZone(add.getBoundingClientRect(), tab!));
    body.append(add);
  }

  // Don't yank a field out from under someone who is typing in it.
  const focused = dock.querySelector<HTMLInputElement>('input:focus');
  dock.replaceChildren(tabs, body);
  if (focused?.dataset.field) {
    const fresh = dock.querySelector<HTMLInputElement>(`input[data-field="${CSS.escape(focused.dataset.field)}"]`);
    if (fresh) {
      fresh.replaceWith(focused);
      focused.focus();
    }
  }
}
