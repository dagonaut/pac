// Character sheets: zones owned by a seat, shown in a dock under the table with a tab per player.
// A sheet made from a template shows its sections of typed fields and card slots; older or
// template-less sheets show plain slots plus free-form fields. Cards drag in and out like any zone.
import type { Op, RoomState, Zone } from '../../shared/model.ts';
import { DICE, defaultValues, type FieldDef, type SheetTemplate, slotLabels } from '../../shared/sheet.ts';
import { h, shortId } from './dom';
import { heading, item, openMenu } from './menu';
import { pieceEl } from './pieces';
import { systems } from './systems/index';

export interface DockCtx {
  me: string;
  renderZone(z: Zone, state: RoomState): HTMLElement;
  zoneHeader(z: Zone, count: number): HTMLElement;
  act(op: Op): Promise<boolean>;
  addZone(anchor: DOMRect, owner: string): void;
  openTemplates(): void;
}

let tab: string | null = null; // whose sheet is showing
let collapsed = false;
try {
  collapsed = localStorage.getItem('vtt.dockCollapsed') === '1';
} catch { /* ignore */ }

const isNumber = (v: string) => /^-?\d+$/.test(v.trim());

// ---- Free-form fields (sheets without a template) -------------------------------------------

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

// ---- Templated sheets -----------------------------------------------------------------------

/** One field's control. `set` stores a value; `roll` sends a labelled roll to the table. */
export function fieldControl(f: FieldDef, value: string, set: (v: string) => void, roll: (expr: string, label: string) => void, key: string) {
  const label = f.label ?? f.id;
  const data = { dataset: { field: key } };
  switch (f.type) {
    case 'number': {
      const n = Number(value) || 0;
      const clamp = (v: number) => Math.min(f.max ?? Infinity, Math.max(f.min ?? -Infinity, v));
      const input = h('input.num', {
        ...data, value: String(n), inputMode: 'numeric',
        onchange: () => set(String(clamp(Math.round(Number(input.value) || 0)))),
        onkeydown: (e: KeyboardEvent) => e.key === 'Enter' && input.blur(),
      });
      const mod = n === 0 ? '' : n > 0 ? `+${n}` : `${n}`;
      const name = f.roll
        ? h('button.stat-roll', { type: 'button', title: `Roll ${f.roll}${mod}`, onclick: () => roll(`${f.roll}${mod}`, label) }, label, h('small', {}, ` ${f.roll}${mod}`))
        : h('label', {}, label);
      return h('div.sf.sf-number', {}, name,
        h('button.step', { type: 'button', disabled: f.min !== undefined && n <= f.min, onclick: () => set(String(clamp(n - 1))) }, '−'),
        input,
        h('button.step', { type: 'button', disabled: f.max !== undefined && n >= f.max, onclick: () => set(String(clamp(n + 1))) }, '+'));
    }
    case 'text': {
      const input = h('input', { ...data, value, maxLength: 500, onchange: () => set(input.value), onkeydown: (e: KeyboardEvent) => e.key === 'Enter' && input.blur() });
      return h('div.sf', {}, h('label', {}, label), input);
    }
    case 'longtext': {
      const area = h('textarea', { ...data, rows: 3, maxLength: 4000, onchange: () => set(area.value) });
      area.value = value;
      return h('div.sf.sf-long', {}, h('label', {}, label), area);
    }
    case 'checkbox': {
      const box = h('input', { ...data, type: 'checkbox', checked: value === 'true', onchange: () => set(box.checked ? 'true' : 'false') });
      return h('label.sf.sf-check', {}, box, ` ${label}`);
    }
    case 'select': {
      const sel = h('select', { ...data, onchange: () => set(sel.value) }, ...(f.options ?? []).map((o) => new Option(o, o, false, o === value)));
      return h('div.sf', {}, h('label', {}, label), sel);
    }
    case 'track': {
      const filled = Math.max(0, Math.min(f.boxes ?? 0, Number(value) || 0));
      const boxes = Array.from({ length: f.boxes ?? 0 }, (_, i) =>
        h('button.track-box', {
          type: 'button',
          className: i < filled ? 'filled' : '',
          title: `${label}: ${i + 1}`,
          // Clicking the last filled box empties it; any other box fills up to it.
          onclick: () => set(String(i + 1 === filled ? i : i + 1)),
        }));
      return h('div.sf.sf-track', {}, h('label', {}, label), h('span.track', {}, ...boxes));
    }
    case 'die': {
      const die = DICE.includes(value) ? value : 'd6';
      const sel = h('select', { ...data, onchange: () => set(sel.value) }, ...DICE.map((d) => new Option(d, d, false, d === die)));
      return h('div.sf', {},
        h('button.stat-roll', { type: 'button', title: `Roll ${die}`, onclick: () => roll(`1${die}`, label) }, label),
        sel);
    }
  }
}

function renderTemplated(z: Zone, tpl: SheetTemplate, state: RoomState, ctx: DockCtx) {
  const defaults = defaultValues(tpl);
  const set = (key: string) => (value: string) => void ctx.act({ kind: 'field.set', zone: z.id, key, value });
  // Rolling someone else's stat (e.g. the GM rolling for a player) says whose it was.
  const roll = (expr: string, label: string) =>
    void ctx.act({ kind: 'roll', expr, label: z.owner && z.owner !== ctx.me ? `${z.owner}'s ${label}` : label });
  const pieces = Object.values(state.pieces).filter((p) => p.zone === z.id).sort((a, b) => a.index - b.index);

  let slotIndex = 0;
  const sections = tpl.sections.map((s) => {
    const fields = (s.fields ?? []).map((f) =>
      fieldControl(f, z.fields?.[f.id] ?? defaults[f.id] ?? '', set(f.id), roll, `${z.id}/${f.id}`));
    const cells = (s.slots ?? []).flatMap((sl) => Array.from({ length: sl.count ?? 1 }, () => {
      const i = slotIndex++;
      const cell = h('div.slot', { dataset: { slot: String(i) } }, h('small.slot-label', {}, sl.label));
      for (const p of pieces.filter((p) => Math.round(p.index) === i)) cell.append(pieceEl(p, state, ctx.me));
      return cell;
    }));
    return h('section.sheet-section', {},
      s.title && h('h4', {}, s.title),
      fields.length > 0 && h('div.sheet-fields', {}, ...fields),
      cells.length > 0 && h('div.strip-cards', {}, ...cells));
  });

  // Cards in slots the template no longer has stay reachable.
  const extra = pieces.filter((p) => !(Math.round(p.index) >= 0 && Math.round(p.index) < slotIndex));
  return h('div.zone.sheet-t', { dataset: { zone: z.id, kind: z.kind } },
    ctx.zoneHeader(z, pieces.length),
    h('div.sheet-sections', {}, ...sections),
    extra.length > 0 && h('div.strip-cards', {}, ...extra.map((p) => pieceEl(p, state, ctx.me))));
}

// ---- Creating a sheet -----------------------------------------------------------------------

function createSheet(state: RoomState, ctx: DockCtx, tpl?: SheetTemplate) {
  if (tpl) {
    return ctx.act({
      kind: 'zone.create',
      zone: { id: `sheet-${shortId()}`, kind: 'slots', label: tpl.name, owner: ctx.me, template: tpl.id, slots: slotLabels(tpl), fields: defaultValues(tpl) },
    });
  }
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

function chooseTemplate(anchor: DOMRect, state: RoomState, ctx: DockCtx) {
  const templates = Object.values(state.templates ?? {}).sort((a, b) => a.name.localeCompare(b.name));
  if (!templates.length) return void createSheet(state, ctx);
  openMenu(anchor,
    heading('Make my sheet from'),
    ...templates.map((t) => item(t.name, () => createSheet(state, ctx, t))),
    h('hr'),
    item('A plain sheet (slots + free fields)', () => createSheet(state, ctx)),
    item('Manage templates…', () => ctx.openTemplates()),
  );
}

// ---- Dock -----------------------------------------------------------------------------------

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
      className: o === tab ? 'active' : '',
      onclick: () => {
        tab = o;
        collapsed = false;
        renderDock(dock, state, ctx);
      },
    }, o === ctx.me ? `${o} (you)` : o)),
    !owned.has(ctx.me) && h('button.dock-tab', {
      type: 'button',
      className: tab === ctx.me ? 'active' : '',
      onclick: () => {
        tab = ctx.me;
        collapsed = false;
        renderDock(dock, state, ctx);
      },
    }, 'My sheet'),
    h('span.spacer'),
    h('button.dock-tab', { type: 'button', title: 'Sheet templates: build, import, export', onclick: () => ctx.openTemplates() }, 'Templates'),
  );

  // A tab on the dock's top edge opens/closes it (like the Chat & dice and Images tabs).
  const toggle = h('button.dock-handle', {
    type: 'button',
    title: collapsed ? 'Show sheets' : 'Hide sheets',
    onclick: () => {
      collapsed = !collapsed;
      try {
        localStorage.setItem('vtt.dockCollapsed', collapsed ? '1' : '0');
      } catch { /* ignore */ }
      renderDock(dock, state, ctx);
    },
  }, 'Sheets');
  dock.classList.toggle('collapsed', collapsed);
  if (collapsed) {
    dock.replaceChildren(toggle);
    return;
  }

  const body = h('div.dock-body');
  const zones = owned.get(tab!) ?? [];
  if (!zones.length) {
    if (tab === ctx.me) {
      const create = h('button', { type: 'button' }, 'Create my sheet');
      create.addEventListener('click', () => chooseTemplate(create.getBoundingClientRect(), state, ctx));
      const n = Object.keys(state.templates ?? {}).length;
      body.append(h('div.dock-empty', {}, create,
        h('span.muted', {}, n ? ` From one of ${n} template${n === 1 ? '' : 's'}, or a plain sheet.` : ' Slots for your cards, plus fields like HP.')));
    } else {
      body.append(h('div.dock-empty.muted', {}, `${tab} has no sheet yet.`));
    }
  }
  for (const z of zones) {
    const tpl = z.template ? state.templates?.[z.template] : undefined;
    body.append(tpl
      ? renderTemplated(z, tpl, state, ctx)
      : h('div.sheet', {}, ctx.renderZone(z, state), fieldsEditor(z, ctx)));
  }
  if (zones.length) {
    const add = h('button.add-zone-btn', { type: 'button' }, '+ Zone');
    add.addEventListener('click', () => ctx.addZone(add.getBoundingClientRect(), tab!));
    body.append(add);
  }

  // Don't yank a field out from under someone who is typing in it.
  const focused = dock.querySelector<HTMLInputElement | HTMLTextAreaElement>('input:focus, textarea:focus');
  dock.replaceChildren(toggle, tabs, body);
  if (focused?.dataset.field) {
    const fresh = dock.querySelector<HTMLElement>(`[data-field="${CSS.escape(focused.dataset.field)}"]`);
    if (fresh && fresh.tagName === focused.tagName) {
      fresh.replaceWith(focused);
      focused.focus();
    }
  }
}
