// The room's image library: a pull-out drawer on the left of the table with maps and handouts.
// From there an image can become the table's background map, be shown big on everyone's screen
// (the spotlight), be put on the table as a movable piece, or just be viewed privately.
import { newPiece } from '../../shared/engine.ts';
import type { ImageDef, Op, RoomState } from '../../shared/model.ts';
import { h, shortId } from './dom';
import { uploadOne, uploadUrls } from './importer';
import { heading, item, openMenu } from './menu';

export interface ImagesCtx {
  me(): string;
  state(): RoomState | null;
  act(op: Op): Promise<boolean>;
  note(msg: string): void;
  token(): string;
  tableZone(): string | undefined;
  /** Middle of the visible table, in table coordinates. */
  visibleCenter(): { x: number; y: number };
  tableSize: { w: number; h: number };
}

const TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/avif'];
const PER_BATCH = 40; // image.create ops per message (32 KB WebSocket frames)
const HANDOUT_SCALE = 2.5; // a handout put on the table starts ~275px wide

type Filter = 'all' | 'map' | 'handout';

const nameFrom = (f: File) => f.name.replace(/\.[^.]+$/, '').replace(/_+/g, ' ').trim().slice(0, 120) || 'Image';

export function createImages(area: HTMLElement, surface: HTMLElement, ctx: ImagesCtx) {
  const st = () => ctx.state()!;
  const me = () => ctx.me();
  const isGm = () => st().gm === me();
  const canSee = (img: ImageDef) => !img.hidden || isGm() || img.by === me();

  // ---- Drawer ---------------------------------------------------------------------------------

  let open = false;
  let filter: Filter = 'all';
  let query = '';
  const grid = h('div.image-grid');
  const search = h('input', { type: 'search', placeholder: 'Search', oninput: () => { query = search.value.toLowerCase(); fill(); } });
  const filters = h('div.image-filters', {}, ...(['all', 'map', 'handout'] as Filter[]).map((f) =>
    h('button', { type: 'button', dataset: { filter: f }, onclick: () => { filter = f; fill(); } }, f === 'all' ? 'All' : f === 'map' ? 'Maps' : 'Handouts')));
  const drawer = h('aside.drawer', { hidden: true },
    h('div.drawer-head', {},
      h('strong', {}, 'Images'),
      h('button', { type: 'button', onclick: () => openUpload() }, 'Upload'),
      h('button.drawer-close', { type: 'button', title: 'Close', onclick: () => toggle(false) }, '×')),
    filters, search, grid);
  const tab = h('button.drawer-tab', { type: 'button', title: 'Maps and handouts', onclick: () => toggle() }, 'Images');
  area.append(tab, drawer);

  function toggle(force?: boolean) {
    open = force ?? !open;
    drawer.hidden = !open;
    tab.classList.toggle('active', open);
    if (open) fill();
  }

  function fill() {
    if (!open || !ctx.state()) return;
    for (const b of filters.querySelectorAll<HTMLElement>('button')) b.classList.toggle('active', b.dataset.filter === filter);
    const state = st();
    const zone = ctx.tableZone();
    const currentMap = zone ? state.zones[zone]?.map?.image : undefined;
    const list = Object.values(state.images ?? {})
      .filter(canSee)
      .filter((i) => filter === 'all' || i.kind === filter)
      .filter((i) => !query || i.name.toLowerCase().includes(query))
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    grid.replaceChildren(...list.map((img) => {
      const thumb = h('button.thumb', { type: 'button', title: img.name }, h('img', { src: img.src, alt: '', loading: 'lazy' }));
      thumb.addEventListener('click', () => imageMenu(img, thumb));
      const tags = [img.kind === 'map' ? 'Map' : 'Handout', img.hidden ? 'hidden' : '', img.id === currentMap ? 'on the table' : '', state.spotlight?.image === img.id ? 'on screen' : '']
        .filter(Boolean).join(' · ');
      return h('figure', { className: img.hidden ? 'hidden-image' : '' }, thumb, h('figcaption', {}, img.name), h('small', {}, tags));
    }));
    if (!list.length) {
      grid.append(h('p.muted', {}, Object.keys(state.images ?? {}).length ? 'Nothing matches.' : 'No images yet. Upload maps and handouts to share them.'));
    }
  }

  // ---- Image actions --------------------------------------------------------------------------

  /** Using an image in front of everyone reveals it. */
  const reveal = (img: ImageDef): Op[] => (img.hidden ? [{ kind: 'image.update', id: img.id, set: { hidden: false } }] : []);
  const send = (ops: Op[]) => ctx.act(ops.length === 1 ? ops[0] : { kind: 'batch', ops });

  function fitScale(thumbImg: HTMLImageElement | null) {
    const w = thumbImg?.naturalWidth || ctx.tableSize.w;
    const hgt = thumbImg?.naturalHeight || ctx.tableSize.h;
    return Math.round(Math.min(1, ctx.tableSize.w / w, ctx.tableSize.h / hgt) * 100) / 100 || 1;
  }

  function imageMenu(img: ImageDef, anchorEl: HTMLElement) {
    const state = st();
    const zone = ctx.tableZone();
    const isMap = !!zone && state.zones[zone]?.map?.image === img.id;
    const mine = isGm() || img.by === me();
    const inUse = isMap || state.spotlight?.image === img.id || Object.values(state.zones).some((z) => z.map?.image === img.id);
    openMenu(anchorEl.getBoundingClientRect(),
      heading(img.name),
      item('View', () => lightbox(img.src, img.name)),
      !!zone && (isMap
        ? item('Remove from the table', () => ctx.act({ kind: 'zone.map', id: zone, map: null }))
        : item('Set as map', () => send([...reveal(img), { kind: 'zone.map', id: zone, map: { image: img.id, scale: fitScale(anchorEl.querySelector('img')) } }]))),
      item('Show to everyone', () => send([...reveal(img), { kind: 'spotlight', spotlight: { image: img.id, by: me() } }])),
      !!zone && item('Put on the table', () => {
        const cardId = `card-img-${img.id}`.slice(0, 64);
        const ops: Op[] = [...reveal(img)];
        if (!state.cards[cardId]) ops.push({ kind: 'card.create', card: { id: cardId, name: img.name, front: img.src } });
        const pos = ctx.visibleCenter();
        ops.push({ kind: 'piece.create', piece: newPiece(`pc-${shortId()}`, cardId, zone, { faceUp: true, scale: HANDOUT_SCALE, ...pos }) });
        return send(ops);
      }),
      h('hr'),
      item(img.kind === 'map' ? 'Call it a handout' : 'Call it a map', () => ctx.act({ kind: 'image.update', id: img.id, set: { kind: img.kind === 'map' ? 'handout' : 'map' } })),
      mine && item(img.hidden ? 'Reveal to players' : 'Hide from players', () => ctx.act({ kind: 'image.update', id: img.id, set: { hidden: !img.hidden } })),
      item('Rename…', () => {
        const name = prompt('Image name:', img.name)?.trim().slice(0, 120);
        if (name) return ctx.act({ kind: 'image.update', id: img.id, set: { name } });
      }),
      !inUse && item('Delete', () => confirm(`Delete ${img.name}?`) && ctx.act({ kind: 'image.delete', id: img.id }), { danger: true }),
    );
  }

  // ---- Upload ---------------------------------------------------------------------------------

  function openUpload() {
    const files = h('input', { type: 'file', multiple: true, accept: TYPES.join(',') });
    const folder = h('input', { type: 'file', multiple: true });
    folder.setAttribute('webkitdirectory', '');
    const kind = h('select', {}, new Option('Handouts (shown as-is)', 'handout', false, filter !== 'map'), new Option('Maps (table backgrounds)', 'map', false, filter === 'map'));
    const hidden = h('input', { type: 'checkbox', checked: isGm() });
    const summary = h('p.muted', {}, 'No images chosen yet.');
    const progress = h('progress', { max: 1, value: 0, hidden: true });
    const error = h('p.error', { hidden: true });
    const go = h('button', { type: 'submit' }, 'Upload');
    let chosen: File[] = [];
    const refresh = () => {
      const all = [...(files.files ?? []), ...(folder.files ?? [])];
      chosen = all.filter((f) => TYPES.includes(f.type)).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
      summary.textContent = chosen.length
        ? `${chosen.length} image${chosen.length === 1 ? '' : 's'}: ${chosen.slice(0, 4).map(nameFrom).join(', ')}${chosen.length > 4 ? '…' : ''}`
        : 'No images chosen yet.';
    };
    files.addEventListener('change', refresh);
    folder.addEventListener('change', refresh);

    const form = h('form', {
      onsubmit: async (e: Event) => {
        e.preventDefault();
        if (!chosen.length) return;
        go.disabled = true;
        error.hidden = true;
        progress.hidden = false;
        try {
          const uploads = await uploadUrls(ctx.token(), chosen);
          progress.max = chosen.length;
          let done = 0;
          const queue = chosen.map((f, i) => [f, uploads[i]] as const);
          await Promise.all(Array.from({ length: 6 }, async () => {
            for (let next = queue.shift(); next; next = queue.shift()) {
              await uploadOne(next[0], next[1]);
              progress.value = ++done;
            }
          }));
          const ops: Op[] = chosen.map((f, i) => ({
            kind: 'image.create',
            image: { id: `img-${shortId()}`, name: nameFrom(f), src: uploads[i].path, kind: kind.value as 'map' | 'handout', hidden: hidden.checked, by: me() },
          }));
          for (let i = 0; i < ops.length; i += PER_BATCH) {
            if (!(await ctx.act({ kind: 'batch', ops: ops.slice(i, i + PER_BATCH) }))) throw new Error('The table rejected the upload; see the log.');
          }
          dialog.close();
        } catch (err) {
          error.textContent = (err as Error).message;
          error.hidden = false;
        } finally {
          go.disabled = false;
        }
      },
    },
      h('h3', {}, 'Upload images'),
      h('p.muted', {}, 'Maps become table backgrounds; handouts are shown as they are. PNG, JPEG, WebP, GIF or AVIF, up to 8 MB each.'),
      h('label', {}, 'Images ', files),
      h('label', {}, 'or a whole folder ', folder),
      h('label', {}, 'They are ', kind),
      h('label.check', {}, hidden, ' Hide from players until shown (only the GM seat and you see them)'),
      summary, progress, error,
      h('div.dialog-buttons', {}, h('button', { type: 'button', onclick: () => dialog.close() }, 'Cancel'), go),
    );
    const dialog = h('dialog.modal.import', { onclose: () => dialog.remove() }, form);
    document.body.append(dialog);
    dialog.showModal();
  }

  // ---- Lightbox and spotlight -----------------------------------------------------------------

  /** Private, local large view. */
  function lightbox(src: string, name: string) {
    const box = h('div.spotlight.local', { onclick: () => box.remove() },
      h('figure', {}, h('img', { src, alt: name }), h('figcaption', {}, name, h('small', {}, ' · only you see this · click to close'))));
    document.body.append(box);
  }

  const spot = h('div.spotlight', { hidden: true });
  const chip = h('button.spot-chip', { type: 'button', hidden: true });
  document.body.append(spot);
  area.append(chip);
  let minimizedKey = '';

  function renderSpotlight(state: RoomState) {
    const sp = state.spotlight;
    const img = sp ? state.images?.[sp.image] : undefined;
    if (!sp || !img) {
      spot.hidden = true;
      chip.hidden = true;
      return;
    }
    const key = `${sp.image}|${sp.by}`;
    const minimized = minimizedKey === key;
    const canClose = sp.by === me() || isGm();
    spot.replaceChildren(h('figure', {},
      h('img', { src: img.src, alt: img.name }),
      h('figcaption', {}, h('b', {}, img.name), ` · shown by ${sp.by}`,
        h('span.spot-buttons', {},
          h('button', { type: 'button', onclick: () => { minimizedKey = key; renderSpotlight(st()); } }, 'Minimize'),
          canClose && h('button', { type: 'button', onclick: () => void ctx.act({ kind: 'spotlight', spotlight: null }) }, 'Close for everyone')))));
    spot.hidden = minimized;
    chip.hidden = !minimized;
    chip.textContent = `On screen: ${img.name}`;
    chip.onclick = () => { minimizedKey = ''; renderSpotlight(st()); };
  }

  // ---- Map ------------------------------------------------------------------------------------

  const mapImg = h('img.map', { alt: '', draggable: false });
  surface.prepend(mapImg);
  const mapLabel = h('span', {}, '');
  const mapBox = h('div.map-controls', { hidden: true },
    mapLabel,
    h('button', { type: 'button', title: 'Smaller map', onclick: () => scaleMap(1 / 1.25) }, '−'),
    h('button', { type: 'button', title: 'Bigger map', onclick: () => scaleMap(1.25) }, '+'),
    h('button', { type: 'button', title: 'Remove the map', onclick: () => { const z = ctx.tableZone(); if (z) void ctx.act({ kind: 'zone.map', id: z, map: null }); } }, '×'));
  area.append(mapBox);

  function scaleMap(f: number) {
    const z = ctx.tableZone();
    const map = z ? st().zones[z]?.map : undefined;
    if (!z || !map) return;
    const scale = Math.round(Math.min(10, Math.max(0.1, map.scale * f)) * 100) / 100;
    void ctx.act({ kind: 'zone.map', id: z, map: { image: map.image, scale } });
  }

  function sizeMap(scale: number) {
    const w = mapImg.naturalWidth * scale;
    const hgt = mapImg.naturalHeight * scale;
    mapImg.style.width = `${w}px`;
    // Let the table grow to fit a big map.
    surface.style.width = `${Math.max(ctx.tableSize.w, Math.ceil(w))}px`;
    surface.style.height = `${Math.max(ctx.tableSize.h, Math.ceil(hgt))}px`;
  }

  function renderMap(state: RoomState) {
    const z = ctx.tableZone();
    const map = z ? state.zones[z]?.map : undefined;
    const img = map ? state.images?.[map.image] : undefined;
    if (!map || !img) {
      mapImg.hidden = true;
      mapImg.removeAttribute('src');
      mapBox.hidden = true;
      surface.style.width = `${ctx.tableSize.w}px`;
      surface.style.height = `${ctx.tableSize.h}px`;
      return;
    }
    mapImg.hidden = false;
    mapBox.hidden = false;
    mapLabel.textContent = `Map ${Math.round(map.scale * 100)}%`;
    mapImg.onload = () => sizeMap(map.scale);
    if (mapImg.getAttribute('src') !== img.src) mapImg.src = img.src;
    else if (mapImg.complete && mapImg.naturalWidth) sizeMap(map.scale);
  }

  function render(state: RoomState) {
    renderMap(state);
    renderSpotlight(state);
    fill();
  }

  return { render };
}
