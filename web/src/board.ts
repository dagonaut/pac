// The shared table: zone bar (decks, rows, discards), the free-placement table surface, the sheet
// dock, drag and drop between any of them, card/zone menus and the hover preview. Every change goes
// out as an op; the screen only changes when the server's broadcast comes back.
import { newPiece } from '../../shared/engine.ts';
import type { Op, Piece, PieceProps, RoomState, Zone, ZoneKind } from '../../shared/model.ts';
import { h, shortId } from './dom';
import { createDrawing } from './draw';
import { createImages } from './images';
import { cardName, COUNTER_COLORS, counterBadges, counterColor, faceOf, pieceEl, prunePieceEls } from './pieces';
import { closeMenu, heading, item, openMenu } from './menu';
import { renderDock } from './sheets';
import { systems } from './systems/index';

export interface TableCtx {
  me(): string;
  state(): RoomState | null;
  act(op: Op): Promise<boolean>;
  note(msg: string): void;
  openImport(zoneId?: string): void;
  /** Upload an image; resolves to its /assets/... path. */
  upload(file: File): Promise<string>;
  /** Unsaved real-time message to everyone else (live drawing, pings). */
  live(data: unknown): void;
  /** Session token, for uploads. */
  token(): string;
  /** The sheet templates library (build, import, export). */
  openTemplates(): void;
  /** Dice buttons and the roll box, shown at the left of the Dice & Cards pane. */
  dice?: HTMLElement;
}

const TABLE_W = 3200;
const TABLE_H = 2000;
const CARD_W = 110; // card width on the table, in table pixels

const byIndex = (a: Piece, b: Piece) => a.index - b.index;
const piecesIn = (state: RoomState, zone: string) => Object.values(state.pieces).filter((p) => p.zone === zone).sort(byIndex);
const zoneTitle = (z: Zone) => (z.owner && !z.label.includes(z.owner) ? `${z.owner}: ${z.label}` : z.label);

export function createBoard(root: HTMLElement, ctx: TableCtx) {
  const bar = h('div.board-bar');
  const surface = h('div.table-surface', { style: { width: `${TABLE_W}px`, height: `${TABLE_H}px` } });
  const wrap = h('div.table-wrap', {}, surface);
  const zoomLabel = h('span', {}, '100%');
  let snap = localStorage.getItem('vtt.snap') === '1';
  const snapBox = h('input', {
    type: 'checkbox',
    checked: snap,
    onchange: () => {
      snap = snapBox.checked;
      surface.classList.toggle('grid', snap);
      try {
        localStorage.setItem('vtt.snap', snap ? '1' : '0');
      } catch { /* ignore */ }
    },
  });
  surface.classList.toggle('grid', snap);
  const GRID = 40;
  const hint = h('div.table-hint', {},
    h('div', {}, 'Drag cards here from a row, sheet or pile.', h('br'), 'Drag empty space to pan · Ctrl+scroll to zoom · hover a card and press F / T / U / L'));
  const zoomBox = h('div.zoom',
    {},
    h('label', { title: 'Snap cards to a 40px grid when you drop them' }, snapBox, 'Grid'),
    h('button', { type: 'button', title: 'Zoom out', onclick: () => setZoom(zoom / 1.2) }, '−'),
    zoomLabel,
    h('button', { type: 'button', title: 'Zoom in', onclick: () => setZoom(zoom * 1.2) }, '+'),
  );
  const dock = h('div.sheet-dock');
  const preview = h('div.preview', { hidden: true });
  const area = h('div.table-area', {}, wrap, hint, zoomBox);
  // The zone bar (decks, rows, discards, card buttons) slides up out of the way; a tab on its
  // bottom edge opens/closes it, like the Sheets and Chat & dice tabs.
  let barCollapsed = false;
  try {
    barCollapsed = localStorage.getItem('vtt.barCollapsed') === '1';
  } catch { /* ignore */ }
  const barHandle = h('button.bar-handle', { type: 'button' }, 'Dice & Cards');
  const barPane = h('div.bar-pane', {}, h('div.bar-row', {}, ctx.dice ?? null, bar), barHandle);
  const setBar = (collapsed: boolean) => {
    barCollapsed = collapsed;
    barPane.classList.toggle('collapsed', collapsed);
    barHandle.title = collapsed ? 'Show dice, decks, rows and card tools' : 'Hide dice, decks, rows and card tools';
    try {
      localStorage.setItem('vtt.barCollapsed', collapsed ? '1' : '0');
    } catch { /* ignore */ }
  };
  barHandle.addEventListener('click', () => setBar(!barCollapsed));
  setBar(barCollapsed);
  root.replaceChildren(barPane, area, dock, preview);

  let zoom = Number(localStorage.getItem('vtt.zoom')) || 1;
  function setZoom(z: number) {
    zoom = Math.min(2, Math.max(0.3, z));
    surface.style.transform = `scale(${zoom})`;
    surface.parentElement!.style.setProperty('--zoom', String(zoom));
    zoomLabel.textContent = `${Math.round(zoom * 100)}%`;
    try {
      localStorage.setItem('vtt.zoom', String(zoom));
    } catch { /* ignore */ }
  }
  setZoom(zoom);
  wrap.addEventListener('wheel', (e) => {
    if (!e.ctrlKey) return;
    e.preventDefault();
    setZoom(zoom * (e.deltaY < 0 ? 1.1 : 1 / 1.1));
  }, { passive: false });

  const drawing = createDrawing(surface, area, {
    me: () => ctx.me(),
    state: () => ctx.state(),
    act: ctx.act,
    live: ctx.live,
    zoom: () => zoom,
    tableZone: () => surface.dataset.zone,
  });

  const images = createImages(area, surface, {
    me: () => ctx.me(),
    state: () => ctx.state(),
    act: ctx.act,
    note: ctx.note,
    token: ctx.token,
    tableZone: () => surface.dataset.zone,
    visibleCenter: () => visibleCenter(),
    zoom: () => zoom,
    tableSize: { w: TABLE_W, h: TABLE_H },
  });

  const st = () => ctx.state()!;
  const me = () => ctx.me();
  const isGm = () => st().gm === me();

  // ---- Moving pieces ----------------------------------------------------------------------------

  /** Where the middle of the visible table is, in table coordinates (for "send to table"). */
  function visibleCenter() {
    const x = (wrap.scrollLeft + wrap.clientWidth / 2) / zoom - CARD_W / 2;
    const y = (wrap.scrollTop + wrap.clientHeight / 2) / zoom - CARD_W * 0.7;
    const jitter = () => Math.round(Math.random() * 40 - 20);
    return { x: Math.round(x) + jitter(), y: Math.round(y) + jitter() };
  }

  /** The piece.update fields for moving a piece into `zone`. */
  function moveSet(p: Piece, zone: Zone, extra: Partial<PieceProps> = {}): Partial<PieceProps> {
    const set: Partial<PieceProps> = { zone: zone.id, ...extra };
    if (zone.kind === 'deck') Object.assign(set, { faceUp: false, tapped: false });
    if (zone.kind === 'discard') Object.assign(set, { faceUp: true, tapped: false });
    if (zone.kind === 'board' && extra.x === undefined) Object.assign(set, visibleCenter());
    if (p.zone !== zone.id && st().zones[p.zone]?.kind === 'deck' && zone.kind !== 'deck') set.faceUp ??= true;
    return set;
  }

  const update = (id: string, set: Partial<PieceProps>) => ctx.act({ kind: 'piece.update', id, set });

  // ---- Menus ----------------------------------------------------------------------------------

  function sendToItems(p: Piece) {
    const zones = Object.values(st().zones).filter((z) => z.id !== p.zone);
    return zones.map((z) => item(zoneTitle(z), () => update(p.id, moveSet(p, z))));
  }

  function counterRow(p: Piece, name: string, n: number) {
    const set = (v: number | null) => {
      const counters = { ...p.counters };
      if (v === null) delete counters[name];
      else counters[name] = v;
      closeMenu();
      void update(p.id, { counters });
    };
    const color = counterColor(st(), name);
    const palette = h('div.counter-palette', { hidden: true }, ...swatches(color, (c) => {
      closeMenu();
      void ctx.act({ kind: 'counter.color', name, color: c });
    }));
    const dot = h('button.counter-dot', {
      type: 'button',
      title: `Color for every "${name}" counter`,
      style: { background: color },
      onclick: () => (palette.hidden = !palette.hidden),
    });
    return h('div.counter-block', {},
      h('div.counter-row', {},
        dot,
        h('span', {}, name),
        h('button', { type: 'button', onclick: () => set(n - 1) }, '−'),
        h('b', {}, String(n)),
        h('button', { type: 'button', onclick: () => set(n + 1) }, '+'),
        h('button', { type: 'button', title: 'Remove counter', onclick: () => set(null) }, '×')),
      palette);
  }

  function swatches(current: string, pick: (c: string) => void) {
    return COUNTER_COLORS.map((c) => h('button.swatch', {
      type: 'button',
      title: c,
      className: c === current ? 'active' : '',
      style: { background: c },
      onclick: (e: Event) => {
        e.preventDefault();
        pick(c);
      },
    }));
  }

  /** "Add counter": a name (existing names are suggested) and a color, remembered per name. */
  function addCounterForm(p: Piece) {
    const state = st();
    const known = [...new Set([...Object.keys(state.counterColors ?? {}), ...Object.values(state.pieces).flatMap((q) => Object.keys(q.counters))])].sort();
    const listId = `counter-names-${shortId()}`;
    const name = h('input', { placeholder: 'Name, e.g. poison', maxLength: 30, required: true, list: listId });
    let chosen = '';
    const row = h('div.counter-palette');
    const paint = () => row.replaceChildren(...swatches(chosen || (name.value.trim() ? counterColor(st(), name.value.trim()) : ''), (c) => {
      chosen = c;
      paint();
    }));
    name.addEventListener('input', () => { chosen = ''; paint(); });
    paint();
    return h('form.add-counter', {
      onsubmit: (e: Event) => {
        e.preventDefault();
        const n = name.value.trim().slice(0, 30);
        if (!n) return;
        closeMenu();
        const ops: Op[] = [{ kind: 'piece.update', id: p.id, set: { counters: { ...p.counters, [n]: p.counters[n] ?? 1 } } }];
        const stored = st().counterColors?.[n];
        const color = chosen || counterColor(st(), n);
        if (stored !== color) ops.push({ kind: 'counter.color', name: n, color });
        void ctx.act(ops.length === 1 ? ops[0] : { kind: 'batch', ops });
      },
    },
      h('datalist', { id: listId }, ...known.map((k) => new Option(k, k))),
      h('div.add-counter-row', {}, name, h('button', { type: 'submit' }, 'Add')),
      row);
  }

  function sizeRow(p: Piece) {
    const scale = p.scale ?? 1;
    const set = (v: number) => {
      closeMenu();
      void update(p.id, { scale: Math.round(Math.min(20, Math.max(0.2, v)) * 100) / 100 });
    };
    const pct = h('input.pct', { type: 'number', min: '20', max: '2000', step: '5', value: String(Math.round(scale * 100)), title: 'Size in percent' });
    let committed = false; // Enter and the blur that follows both fire; send once
    const commit = () => {
      const v = Number(pct.value);
      if (committed || !Number.isFinite(v) || v <= 0 || Math.round(v) === Math.round(scale * 100)) return;
      committed = true;
      set(v / 100);
    };
    pct.addEventListener('keydown', (e) => e.key === 'Enter' && (e.preventDefault(), commit()));
    pct.addEventListener('change', commit);
    return h('div.size-row', {},
      h('span', {}, 'Size'),
      h('button', { type: 'button', title: 'Smaller', onclick: () => set(scale / 1.25) }, '−'),
      pct, h('span.pct-sign', {}, '%'),
      h('button', { type: 'button', title: 'Bigger', onclick: () => set(scale * 1.25) }, '+'),
      h('button', { type: 'button', title: 'Normal size', onclick: () => set(1) }, '1×'),
    );
  }

  /** Take a piece out of play. The card itself stays in the Library (add it back from there). */
  function removeItem(p: Piece) {
    const zone = st().zones[p.zone];
    const where = zone?.kind === 'board' ? 'the table' : zone?.kind === 'slots' || zone?.owner ? 'the sheet' : zoneTitle(zone!);
    const label = zone?.kind === 'board' ? 'Remove from table' : zone?.kind === 'slots' || zone?.owner ? 'Remove from sheet' : `Remove from ${zone?.label ?? 'here'}`;
    return item(label, () =>
      confirm(`Remove ${cardName(p, st(), me())} from ${where}? The card stays in the Library, so you can add it back.`) &&
      ctx.act({ kind: 'piece.delete', id: p.id }), { danger: true });
  }

  /** Move a table piece above (or below) everything else on the table. Stacking follows index. */
  function restack(p: Piece, to: 'front' | 'back') {
    const others = piecesIn(st(), p.zone).filter((q) => q.id !== p.id).map((q) => q.index);
    if (!others.length) return;
    const index = to === 'front' ? Math.max(...others) + 1 : Math.min(...others) - 1;
    if (index !== p.index) return update(p.id, { index });
  }

  function pieceMenu(p: Piece, anchor: DOMRect) {
    const card = st().cards[p.def];
    const face = faceOf(p, st(), me());
    const onBoard = st().zones[p.zone]?.kind === 'board';
    openMenu(anchor,
      heading(cardName(p, st(), me())),
      item(p.faceUp ? 'Flip face down' : 'Flip face up', () => update(p.id, { faceUp: !p.faceUp }), { hint: 'F' }),
      item(p.tapped ? 'Untap' : 'Tap', () => update(p.id, { tapped: !p.tapped }), { hint: 'T' }),
      item(p.upgraded ? 'Remove upgrade' : card?.upgraded ? 'Upgrade' : 'Mark upgraded', () => update(p.id, { upgraded: !p.upgraded }), { hint: 'U' }),
      heading('Counters'),
      ...Object.entries(p.counters).map(([name, n]) => counterRow(p, name, n)),
      addCounterForm(p),
      h('hr'),
      item(p.note ? 'Edit note…' : 'Add note…', () => {
        const note = prompt('Note on this card:', p.note);
        if (note !== null) return update(p.id, { note: note.slice(0, 1000) });
      }),
      isGm() && item(p.visibleTo === 'all' ? 'Hide from players' : 'Show to everyone',
        () => update(p.id, { visibleTo: p.visibleTo === 'all' ? 'gm' : 'all' })),
      face.front && item('Show large', () => showPreview(p, true)),
      onBoard && sizeRow(p),
      onBoard && item(p.locked ? 'Unlock' : 'Lock in place', () => update(p.id, { locked: !p.locked }), { hint: 'L' }),
      onBoard && item('Bring to front', () => restack(p, 'front')),
      onBoard && item('Send to back', () => restack(p, 'back')),
      p.locked ? h('p.menu-hint', {}, 'Locked: unlock it to move it or send it elsewhere.') : heading('Send to'),
      ...(p.locked ? [] : sendToItems(p)),
      h('hr'),
      removeItem(p),
    );
  }

  function zoneMenu(z: Zone, anchor: DOMRect) {
    const state = st();
    const pieces = piecesIn(state, z.id);
    const targets = Object.values(state.zones).filter((t) => t.kind !== 'deck' && t.id !== z.id);
    const decks = Object.values(state.zones).filter((t) => t.kind === 'deck' && t.id !== z.id);
    const discards = Object.values(state.zones).filter((t) => t.kind === 'discard' && t.id !== z.id);

    let drawBox: HTMLElement | null = null;
    if (z.kind === 'deck') {
      const count = h('input', { type: 'number', min: '1', max: '50', value: '1' });
      const dest = h('select', {}, ...targets.map((t) => new Option(zoneTitle(t), t.id, false, t.kind === 'row' && !t.owner)));
      drawBox = h('form.draw-box', {
        onsubmit: (e: Event) => {
          e.preventDefault();
          closeMenu();
          void ctx.act({ kind: 'draw', from: z.id, to: dest.value, count: Number(count.value) || 1 });
        },
      }, h('label', {}, 'Draw ', count), h('label', {}, 'to ', dest), h('button', { type: 'submit' }, 'Draw'));
      if (!pieces.length || !targets.length) drawBox = null;
    }

    const moveAll = (to: Zone) => ctx.act({ kind: 'batch', ops: pieces.map((p) => ({ kind: 'piece.update', id: p.id, set: moveSet(p, to) }) as Op) });

    openMenu(anchor,
      heading(`${zoneTitle(z)} (${pieces.length})`),
      drawBox,
      z.kind === 'deck' && !pieces.length && h('p.menu-hint', {}, 'Empty. Import cards or send cards here.'),
      z.kind === 'discard' && pieces.length > 0 && item('View cards', () => viewZone(z)),
      ...(pieces.length && z.kind !== 'deck' ? decks.map((d) => item(`Shuffle all into ${d.label}`, () => moveAll(d))) : []),
      ...(pieces.length && z.kind !== 'discard' && z.kind !== 'deck' ? discards.map((d) => item(`Move all to ${d.label}`, () => moveAll(d))) : []),
      z.kind === 'deck' && item('Import cards here…', () => ctx.openImport(z.id)),
      h('hr'),
      item('Rename…', () => {
        const label = prompt('Name:', z.label)?.trim().slice(0, 80);
        if (label) return ctx.act({ kind: 'zone.update', id: z.id, set: { label } });
      }),
      z.kind === 'slots' && item('Edit slots…', () => {
        const raw = prompt('Slot names, separated by commas (empty for a free row):', (z.slots ?? []).join(', '));
        if (raw !== null) {
          const slots = raw.split(',').map((s) => s.trim()).filter(Boolean).slice(0, 50);
          return ctx.act({ kind: 'zone.update', id: z.id, set: { slots } });
        }
      }),
      !pieces.length && item('Delete', () => ctx.act({ kind: 'zone.delete', id: z.id }), { danger: true }),
    );
  }

  function addZoneMenu(anchor: DOMRect, owner?: string) {
    const label = h('input', { required: true, maxLength: 80, placeholder: 'Name' });
    const kinds: [ZoneKind, string][] = owner
      ? [['slots', 'Sheet slots'], ['row', 'Row']]
      : [['deck', 'Deck (hidden, random draws)'], ['row', 'Row (face-up selection)'], ['discard', 'Discard pile']];
    const kind = h('select', {}, ...kinds.map(([k, l]) => new Option(l, k)));
    openMenu(anchor,
      heading(owner ? `New zone for ${owner}` : 'New zone'),
      h('form.add-zone', {
        onsubmit: (e: Event) => {
          e.preventDefault();
          closeMenu();
          void ctx.act({ kind: 'zone.create', zone: { id: `${kind.value}-${shortId()}`, kind: kind.value as ZoneKind, label: label.value.trim(), owner } });
        },
      }, label, kind, h('button', { type: 'submit' }, 'Add')),
    );
    label.focus();
  }

  function viewZone(z: Zone) {
    const state = st();
    const list = h('div.zone-view');
    for (const p of piecesIn(state, z.id).reverse()) {
      const face = faceOf(p, state, me());
      const thumb = h('button.thumb', { type: 'button', title: cardName(p, state, me()) },
        face.src ? h('img', { src: face.src, alt: '' }) : h('div.back-default', {}, h('span', {}, 'PAC')));
      thumb.addEventListener('click', () => {
        dialog.close();
        pieceMenu(p, thumb.getBoundingClientRect());
      });
      list.append(thumb);
    }
    const dialog = h('dialog.modal', { onclose: () => dialog.remove() },
      h('h3', {}, `${zoneTitle(z)} (${list.childElementCount})`), list,
      h('form', { method: 'dialog' }, h('button', {}, 'Close')));
    document.body.append(dialog);
    dialog.showModal();
  }

  // ---- Card library -----------------------------------------------------------------------------

  /** Every imported card: add copies to any zone, set upgraded art, delete unused cards. */
  function openLibrary() {
    const dialog = h('dialog.modal', { onclose: () => dialog.remove() });
    const fill = () => {
      const state = st();
      const cards = Object.values(state.cards).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
      const inUse = (id: string) => Object.values(state.pieces).filter((p) => p.def === id).length;
      const grid = h('div.library');
      for (const c of cards) {
        const thumb = h('button.thumb', { type: 'button', title: c.name }, h('img', { src: c.front, alt: '' }));
        thumb.addEventListener('click', () => cardMenu(c.id, thumb.getBoundingClientRect(), fill));
        const n = inUse(c.id);
        grid.append(h('figure', {}, thumb, h('figcaption', {}, c.name), h('small', {}, `${n} in play${c.upgraded ? ' · has upgrade art' : ''}`)));
      }
      dialog.replaceChildren(
        h('h3', {}, `Card library (${cards.length})`),
        cards.length ? grid : h('p.muted', {}, 'No cards yet. Use Import cards.'),
        h('form', { method: 'dialog' }, h('div.dialog-buttons', {}, h('button', {}, 'Close'))),
      );
    };
    fill();
    document.body.append(dialog);
    dialog.showModal();
  }

  function cardMenu(cardId: string, anchor: DOMRect, refresh: () => void) {
    const state = st();
    const c = state.cards[cardId];
    if (!c) return;
    const used = Object.values(state.pieces).some((p) => p.def === cardId);
    const after = (ok: boolean | Promise<boolean>) => Promise.resolve(ok).then(() => refresh());
    const pickImage = (then: (path: string) => Promise<boolean>) => {
      const input = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp,image/gif,image/avif' });
      input.addEventListener('change', async () => {
        const file = input.files?.[0];
        if (!file) return;
        try {
          await after(then(await ctx.upload(file)));
        } catch (e) {
          ctx.note((e as Error).message);
        }
      });
      input.click();
    };
    openMenu(anchor,
      heading(c.name),
      heading('Add a copy to'),
      ...Object.values(state.zones).map((z) => item(zoneTitle(z), () => {
        const index = Object.values(state.pieces).filter((q) => q.zone === z.id).reduce((m, q) => Math.max(m, q.index + 1), 0);
        const pos = z.kind === 'board' ? visibleCenter() : {};
        const piece = newPiece(`pc-${shortId()}`, cardId, z.id, { index, faceUp: z.kind !== 'deck', ...pos });
        return after(ctx.act({ kind: 'piece.create', piece }));
      })),
      h('hr'),
      item(c.upgraded ? 'Replace upgraded art…' : 'Add upgraded art…', () => pickImage((path) => ctx.act({ kind: 'card.update', id: cardId, set: { upgraded: path } }))),
      !!c.upgraded && item('Remove upgraded art', () => after(ctx.act({ kind: 'card.update', id: cardId, set: { upgraded: '' } }))),
      item(c.back ? 'Replace card back…' : 'Add card back…', () => pickImage((path) => ctx.act({ kind: 'card.update', id: cardId, set: { back: path } }))),
      item('Rename…', () => {
        const name = prompt('Card name:', c.name)?.trim().slice(0, 120);
        if (name) return after(ctx.act({ kind: 'card.update', id: cardId, set: { name } }));
      }),
      !used && item('Delete from library', () => confirm(`Delete ${c.name} from the library?`) && after(ctx.act({ kind: 'card.delete', id: cardId })), { danger: true }),
    );
  }

  // ---- Preview --------------------------------------------------------------------------------

  let previewFor: string | null = null;
  function showPreview(p: Piece, pinned = false) {
    const state = st();
    const face = faceOf(p, state, me());
    if (!face.front || !face.src) return hidePreview();
    previewFor = p.id;
    const counters = Object.entries(p.counters).map(([k, v]) => `${k}: ${v}`).join(' · ');
    preview.replaceChildren(
      h('div.preview-img', {}, h('img', { src: face.src, alt: '' }), h('div.badges.preview-badges', {}, ...counterBadges(p, state))),
      h('div.preview-caption', {}, h('b', {}, state.cards[p.def]?.name ?? ''), counters && h('div', {}, counters), p.note && h('div', {}, p.note)),
    );
    preview.classList.toggle('pinned', pinned);
    preview.hidden = false;
    if (pinned) preview.onclick = hidePreview;
  }
  function hidePreview() {
    previewFor = null;
    preview.hidden = true;
    preview.onclick = null;
  }

  // ---- Drag and drop --------------------------------------------------------------------------

  interface Drag {
    id: string;
    el: HTMLElement;
    startX: number;
    startY: number;
    offX: number;
    offY: number;
    ghost: HTMLElement | null;
    target: HTMLElement | null;
  }
  let drag: Drag | null = null;
  let hovered: string | null = null;

  root.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    const el = (e.target as HTMLElement).closest<HTMLElement>('.piece');
    if (el) {
      const r = el.getBoundingClientRect();
      drag = { id: el.dataset.piece!, el, startX: e.clientX, startY: e.clientY, offX: e.clientX - r.left, offY: e.clientY - r.top, ghost: null, target: null };
      el.setPointerCapture(e.pointerId);
      e.preventDefault();
      return;
    }
    // Drag empty table space to pan.
    if ((e.target as HTMLElement).closest('.table-surface')) {
      const sx = e.clientX, sy = e.clientY, sl = wrap.scrollLeft, stp = wrap.scrollTop;
      const move = (ev: PointerEvent) => {
        wrap.scrollLeft = sl - (ev.clientX - sx);
        wrap.scrollTop = stp - (ev.clientY - sy);
      };
      const up = () => {
        window.removeEventListener('pointermove', move);
        wrap.classList.remove('panning');
      };
      wrap.classList.add('panning');
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up, { once: true });
    }
  });

  root.addEventListener('pointermove', (e) => {
    if (!drag) return;
    if (!drag.ghost) {
      if (Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY) < 5) return;
      if (st().pieces[drag.id]?.locked) return; // locked: a click still opens the menu, no drag
      const r = drag.el.getBoundingClientRect();
      const tapped = drag.el.classList.contains('tapped');
      // The copy follows the pointer, so drop the table position it was cloned with (left/top
      // would otherwise offset it by wherever the card sits on the table) and draw it upright.
      const w = tapped ? r.height : r.width;
      drag.ghost = drag.el.cloneNode(true) as HTMLElement;
      drag.ghost.classList.add('ghost');
      drag.ghost.classList.remove('tapped');
      drag.ghost.style.left = drag.ghost.style.top = drag.ghost.style.zIndex = '';
      drag.ghost.style.width = `${w}px`;
      drag.ghost.style.setProperty('--card-w', `${w}px`);
      drag.offX = Math.min(drag.offX, w - 4);
      drag.offY = Math.min(drag.offY, (tapped ? r.width : r.height) - 4);
      document.body.append(drag.ghost);
      drag.el.classList.add('dragging');
      hidePreview();
      closeMenu();
    }
    drag.ghost.style.transform = `translate(${e.clientX - drag.offX}px, ${e.clientY - drag.offY}px)`;
    const under = document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null;
    const target = under?.closest<HTMLElement>('[data-zone]') ?? null;
    if (target !== drag.target) {
      drag.target?.classList.remove('drop-target');
      target?.classList.add('drop-target');
      drag.target = target;
    }
  });

  root.addEventListener('pointerup', (e) => {
    const d = drag;
    drag = null;
    if (!d) return;
    if (!d.ghost) {
      const p = st().pieces[d.id];
      if (p) pieceMenu(p, d.el.getBoundingClientRect());
      return;
    }
    d.ghost.remove();
    d.el.classList.remove('dragging');
    d.target?.classList.remove('drop-target');
    const p = st().pieces[d.id];
    const zone = d.target && st().zones[d.target.dataset.zone!];
    if (!p || !zone) return;
    void update(p.id, dropSet(p, zone, d.target!, e, d));
  });

  function dropSet(p: Piece, zone: Zone, target: HTMLElement, e: PointerEvent, d: Drag): Partial<PieceProps> {
    if (zone.kind === 'board') {
      const r = surface.getBoundingClientRect();
      const x = Math.round((e.clientX - d.offX - r.left) / zoom);
      const y = Math.round((e.clientY - d.offY - r.top) / zoom);
      const s = (v: number) => (snap ? Math.round(v / GRID) * GRID : v);
      // The table can be bigger than its default when a large map is set.
      const pos = { x: Math.max(0, Math.min(surface.offsetWidth - CARD_W, s(x))), y: Math.max(0, Math.min(surface.offsetHeight - CARD_W, s(y))) };
      return zone.id === p.zone ? pos : moveSet(p, zone, pos);
    }
    if (zone.kind === 'deck' || zone.kind === 'discard') return moveSet(p, zone);
    // Slots: the cell under the pointer is the index.
    const cell = (document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null)?.closest<HTMLElement>('[data-slot]');
    if (zone.slots?.length && cell) return moveSet(p, zone, { index: Number(cell.dataset.slot) });
    // Rows: insert between the neighbours either side of the pointer.
    const others = [...target.querySelectorAll<HTMLElement>('.piece')].filter((el) => el.dataset.piece !== p.id);
    const idx = (el: HTMLElement) => st().pieces[el.dataset.piece!]?.index ?? 0;
    const after = others.findIndex((el) => {
      const r = el.getBoundingClientRect();
      return e.clientX < r.left + r.width / 2;
    });
    let index: number;
    if (!others.length) index = 0;
    else if (after === -1) index = idx(others[others.length - 1]) + 1;
    else if (after === 0) index = idx(others[0]) - 1;
    else index = (idx(others[after - 1]) + idx(others[after])) / 2;
    return moveSet(p, zone, { index });
  }

  root.addEventListener('pointerover', (e) => {
    const el = (e.target as HTMLElement).closest<HTMLElement>('.piece');
    if (!el || drag) return;
    hovered = el.dataset.piece!;
    const p = st().pieces[hovered];
    if (p && !preview.classList.contains('pinned')) {
      showPreview(p);
      // Keep the preview on the side away from the pointer.
      preview.classList.toggle('left', e.clientX > window.innerWidth / 2);
    }
  });
  root.addEventListener('pointerout', (e) => {
    const el = (e.target as HTMLElement).closest<HTMLElement>('.piece');
    if (!el || el.contains(e.relatedTarget as Node)) return;
    hovered = null;
    if (!preview.classList.contains('pinned')) hidePreview();
  });

  // Keyboard shortcuts on the card under the pointer.
  document.addEventListener('keydown', (e) => {
    const tag = (e.target as HTMLElement).tagName;
    if (root.closest('[hidden]') || tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      void ctx.act({ kind: 'undo' });
      return;
    }
    const p = hovered ? st()?.pieces[hovered] : undefined;
    if (!p || e.ctrlKey || e.metaKey || e.altKey) return;
    const key = e.key.toLowerCase();
    if (key === 'f') void update(p.id, { faceUp: !p.faceUp });
    else if (key === 't') void update(p.id, { tapped: !p.tapped });
    else if (key === 'u') void update(p.id, { upgraded: !p.upgraded });
    else if (key === 'l' && st().zones[p.zone]?.kind === 'board') void update(p.id, { locked: !p.locked });
    else return;
    e.preventDefault();
  });

  // ---- Rendering ------------------------------------------------------------------------------

  function zoneHeader(z: Zone, count: number, inDock = false) {
    const more = h('button.zone-more', { type: 'button', title: 'Zone actions' }, '⋯');
    more.addEventListener('click', () => zoneMenu(z, more.getBoundingClientRect()));
    return h('div.zone-head', {}, h('span', {}, inDock ? z.label : zoneTitle(z)), h('small', {}, String(count)), more);
  }

  function renderPile(z: Zone, state: RoomState) {
    const pieces = piecesIn(state, z.id);
    const pile = h('div.zone.pile', { dataset: { zone: z.id, kind: z.kind } }, zoneHeader(z, pieces.length));
    const stack = h('div.pile-stack');
    if (z.kind === 'deck') {
      // Decks never show their cards: a back image (from the cards) or the default back.
      const back = pieces.map((p) => state.cards[p.def]?.back).find(Boolean);
      stack.append(pieces.length
        ? (back ? h('img.pile-back', { src: back, alt: '' }) : h('div.back-default', {}, h('span', {}, 'PAC')))
        : h('div.pile-empty', {}, 'empty'));
      stack.addEventListener('click', () => zoneMenu(z, stack.getBoundingClientRect()));
      stack.title = 'Draw…';
    } else {
      const top = pieces[pieces.length - 1];
      stack.append(top ? pieceEl(top, state, me()) : h('div.pile-empty', {}, 'empty'));
    }
    pile.append(stack);
    return pile;
  }

  function renderStrip(z: Zone, state: RoomState) {
    const pieces = piecesIn(state, z.id);
    // Sheet zones live in the dock under their owner's tab, so the owner prefix is redundant there.
    const strip = h('div.zone.strip', { dataset: { zone: z.id, kind: z.kind } }, zoneHeader(z, pieces.length, !!z.owner));
    const cards = h('div.strip-cards');
    if (z.slots?.length) {
      z.slots.forEach((label, i) => {
        const cell = h('div.slot', { dataset: { slot: String(i) } }, h('small.slot-label', {}, label));
        for (const p of pieces.filter((p) => Math.round(p.index) === i)) cell.append(pieceEl(p, state, me()));
        cards.append(cell);
      });
      // Pieces outside the named slots still need to be reachable.
      for (const p of pieces.filter((p) => !(Math.round(p.index) >= 0 && Math.round(p.index) < z.slots!.length))) {
        cards.append(pieceEl(p, state, me()));
      }
    } else {
      for (const p of pieces) cards.append(pieceEl(p, state, me()));
      if (!pieces.length) cards.append(h('div.strip-empty', {}, 'Drop cards here'));
    }
    strip.append(cards);
    return strip;
  }

  function renderZone(z: Zone, state: RoomState) {
    return z.kind === 'deck' || z.kind === 'discard' ? renderPile(z, state) : renderStrip(z, state);
  }

  function render(state: RoomState) {
    const zones = Object.values(state.zones);
    const table = zones.find((z) => z.kind === 'board');
    const shared = zones.filter((z) => !z.owner && z !== table);
    const order: ZoneKind[] = ['deck', 'row', 'slots', 'hand', 'discard', 'board'];
    shared.sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind));

    const addBtn = h('button.bar-btn', { type: 'button' }, '+ Zone');
    addBtn.addEventListener('click', () => addZoneMenu(addBtn.getBoundingClientRect()));
    const importBtn = h('button.bar-btn', { type: 'button', onclick: () => ctx.openImport() }, 'Import cards');
    const libraryBtn = h('button.bar-btn', { type: 'button', onclick: () => openLibrary() }, 'Library');
    const actions = (systems.find((s) => s.id === state.system)?.actions ?? []).map((a) =>
      h('button.bar-btn.system-action', {
        type: 'button',
        title: a.title ?? '',
        onclick: () => {
          const out = a.run({ state: st(), me: me() });
          if (typeof out === 'string') ctx.note(out);
          else if (out.length) void ctx.act(out.length === 1 ? out[0] : { kind: 'batch', ops: out });
        },
      }, a.label));
    bar.replaceChildren(
      ...shared.map((z) => renderZone(z, state)),
      h('div.bar-right', {},
        actions.length ? h('div.bar-actions', {}, ...actions) : null,
        h('div.bar-actions', {}, importBtn, libraryBtn, addBtn)),
    );
    hint.hidden = !!table && Object.values(state.pieces).some((p) => p.zone === table.id);

    const keep = new Set<string>();
    if (table) {
      surface.dataset.zone = table.id;
      const onTable = piecesIn(state, table.id);
      // Stacking follows index order (Bring to front / Send to back change it); the rank, not the
      // raw index, sets z-index so it never drops below the map and drawings.
      onTable.forEach((p, rank) => {
        const el = pieceEl(p, state, me());
        el.style.left = `${p.x}px`;
        el.style.top = `${p.y}px`;
        el.style.zIndex = String(rank + 10);
        if (el.parentElement !== surface) surface.append(el);
        keep.add(p.id);
      });
    } else {
      delete surface.dataset.zone;
    }
    drawing.render(state);
    images.render(state);

    renderDock(dock, state, {
      me: me(),
      upload: ctx.upload,
      renderZone,
      zoneHeader: (z, count) => zoneHeader(z, count, true),
      openTemplates: ctx.openTemplates,
      act: ctx.act,
      addZone: (anchor, owner) => addZoneMenu(anchor, owner),
    });

    // Elements for pieces in decks or deleted pieces are dropped; ones currently shown are kept.
    root.querySelectorAll<HTMLElement>('.piece').forEach((el) => keep.add(el.dataset.piece!));
    prunePieceEls(keep);
    for (const el of surface.querySelectorAll<HTMLElement>('.piece')) {
      if (state.pieces[el.dataset.piece!]?.zone !== table?.id) el.remove();
    }
    for (const el of root.querySelectorAll<HTMLElement>('.strip .piece, .pile .piece, .sheet-dock .piece')) {
      el.style.left = el.style.top = el.style.zIndex = '';
    }
    if (previewFor && !state.pieces[previewFor]) hidePreview();
  }

  return { render, onLive: drawing.onLive };
}
