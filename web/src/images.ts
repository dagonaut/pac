// The room's image library: a pull-out drawer on the left of the table with maps and handouts.
// From there an image can become the table's background map, be shown big on everyone's screen
// (the spotlight), be put on the table as a movable piece, or just be viewed privately.
import { newPiece } from '../../shared/engine.ts';
import type { ImageDef, Op, RoomState, Slideshow } from '../../shared/model.ts';
import { h, shortId } from './dom';
import { uploadOne, uploadUrls } from './importer';
import { closeMenu, heading, item, openMenu } from './menu';

export interface ImagesCtx {
  me(): string;
  state(): RoomState | null;
  act(op: Op): Promise<boolean>;
  note(msg: string): void;
  token(): string;
  tableZone(): string | undefined;
  /** Middle of the visible table, in table coordinates. */
  visibleCenter(): { x: number; y: number };
  zoom(): number;
  tableSize: { w: number; h: number };
}

const TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/avif'];
const PER_BATCH = 40; // image.create ops per message (32 KB WebSocket frames)
const HANDOUT_SCALE = 2.5; // a handout put on the table starts ~275px wide
const MAP_MARGIN = 400; // free table kept around a map on every side
const MAX_FRAME = 24000; // bytes of ops per message, under the 32 KB WebSocket frame

type Filter = 'all' | 'map' | 'handout' | 'shows';

const nameFrom = (f: File) => f.name.replace(/\.[^.]+$/, '').replace(/_+/g, ' ').trim().slice(0, 120) || 'Image';

export function createImages(area: HTMLElement, surface: HTMLElement, ctx: ImagesCtx) {
  const st = () => ctx.state()!;
  const me = () => ctx.me();
  const isGm = () => st().gm === me();
  const canSee = (img: ImageDef) => !img.hidden || isGm() || img.by === me();
  /** Changing the table's map is the GM's job, or anyone's when nobody holds the GM seat. */
  const canMap = () => !st().gm || isGm();

  // ---- Drawer ---------------------------------------------------------------------------------

  let open = false;
  let filter: Filter = 'all';
  let query = '';
  const grid = h('div.image-grid');
  const search = h('input', { type: 'search', placeholder: 'Search', oninput: () => { query = search.value.toLowerCase(); fill(); } });
  const filters = h('div.image-filters', {}, ...(['all', 'map', 'handout', 'shows'] as Filter[]).map((f) =>
    h('button', { type: 'button', dataset: { filter: f }, onclick: () => { filter = f; fill(); } },
      { all: 'All', map: 'Maps', handout: 'Handouts', shows: 'Slideshows' }[f])));
  const drawer = h('aside.drawer', { hidden: true },
    h('div.drawer-head', {},
      h('strong', {}, 'Images'),
      h('button', { type: 'button', onclick: () => openUpload() }, 'Upload')),
    filters, search, grid);
  // The tab stays attached to the drawer's edge and opens/closes it (like the Chat & dice tab).
  const tab = h('button.drawer-tab', { type: 'button', title: 'Show maps and handouts', onclick: () => toggle() }, 'Images');
  area.append(tab, drawer);

  function toggle(force?: boolean) {
    open = force ?? !open;
    drawer.hidden = !open;
    tab.classList.toggle('active', open);
    area.classList.toggle('drawer-open', open); // moves the map controls out from under it
    tab.title = open ? 'Hide maps and handouts' : 'Show maps and handouts';
    if (open) fill();
  }

  function fill() {
    if (!open || !ctx.state()) return;
    for (const b of filters.querySelectorAll<HTMLElement>('button')) b.classList.toggle('active', b.dataset.filter === filter);
    if (filter === 'shows') return fillShows();
    grid.classList.remove('show-list');
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

  // ---- Slideshows -----------------------------------------------------------------------------
  // The GM lines up images ahead of time (a recap, a reveal sequence) and steps through them on
  // everyone's screen with ◀ ▶.

  const shows = () => Object.values(st().slideshows ?? {}).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));

  function fillShows() {
    const state = st();
    grid.classList.add('show-list');
    const list = shows().filter((sh) => !query || sh.name.toLowerCase().includes(query));
    grid.replaceChildren(...[
      ...list.map((sh) => {
        const first = state.images?.[sh.images[0]];
        const live = state.spotlight?.show === sh.id;
        return h('div.show-row', { className: live ? 'live' : '' },
          h('div.show-thumb', {}, first ? h('img', { src: first.src, alt: '', loading: 'lazy' }) : h('span', {}, '—')),
          h('div.show-info', {}, h('b', {}, sh.name), h('small.muted', {}, `${sh.images.length} image${sh.images.length === 1 ? '' : 's'}${live ? ' · on screen' : ''}`)),
          h('div.show-actions', {},
            h('button', { type: 'button', disabled: !sh.images.length, title: 'Show the first image to everyone, then step with ◀ ▶', onclick: () => void present(sh, 0) }, '▶ Present'),
            canMap() && h('button', { type: 'button', onclick: () => editShow(sh.id) }, 'Edit')));
      }),
      list.length ? null : h('p.muted', {}, canMap()
        ? 'No slideshows yet. Make one to line up images in order, like a recap of last session.'
        : 'No slideshows yet.'),
      canMap() ? h('button.new-show', { type: 'button', onclick: () => void newShow() }, '+ Slideshow') : null,
    ].filter((n) => n !== null));
  }

  async function newShow(images: string[] = []) {
    const name = prompt('Slideshow name:', `Recap, ${new Date().toLocaleDateString([], { month: 'short', day: 'numeric' })}`)?.trim().slice(0, 80);
    if (!name) return;
    const id = `show-${shortId()}`;
    if (await ctx.act({ kind: 'slideshow.create', show: { id, name, images } })) editShow(id);
  }

  /** Show slide `index` of a slideshow to everyone (revealing it if it was hidden). */
  function present(sh: Slideshow, index: number) {
    const img = st().images?.[sh.images[index]];
    if (!img) return;
    return send([...reveal(img), { kind: 'spotlight', spotlight: { image: img.id, by: me(), show: sh.id, index } }]);
  }

  /** Build a slideshow: its images in order (↑ ↓ ×) and the library to add from. */
  function editShow(id: string) {
    const dialog = h('dialog.modal.show-editor', { onclose: () => { dialog.remove(); fill(); } });
    const paint = () => {
      const state = st();
      const sh = state.slideshows?.[id];
      if (!sh) return dialog.close();
      const update = (set: { name?: string; images?: string[] }) => ctx.act({ kind: 'slideshow.update', id, set }).then(paint);
      const name = h('input', { value: sh.name, maxLength: 80, 'aria-label': 'Slideshow name' });
      name.addEventListener('change', () => name.value.trim() && void update({ name: name.value.trim() }));
      const slides = h('ol.slides', {}, ...sh.images.map((imgId, i) => {
        const img = state.images?.[imgId];
        const move = (to: number) => {
          const next = [...sh.images];
          next.splice(to, 0, ...next.splice(i, 1));
          void update({ images: next });
        };
        return h('li', {},
          h('span.slide-no', {}, String(i + 1)),
          img ? h('img', { src: img.src, alt: '', loading: 'lazy' }) : null,
          h('span.slide-name', {}, img?.name ?? '?', img?.hidden ? h('small.muted', {}, ' (hidden until shown)') : null),
          h('span.sound-actions', {},
            h('button', { type: 'button', title: 'Earlier', disabled: i === 0, onclick: () => move(i - 1) }, '↑'),
            h('button', { type: 'button', title: 'Later', disabled: i === sh.images.length - 1, onclick: () => move(i + 1) }, '↓'),
            h('button', { type: 'button', title: 'Take out of the slideshow', onclick: () => void update({ images: sh.images.filter((_, j) => j !== i) }) }, '×')));
      }));
      const library = Object.values(state.images ?? {}).filter(canSee).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
      const pick = h('div.image-grid.pick-grid', {}, ...library.map((img) =>
        h('figure', {},
          h('button.thumb', { type: 'button', title: `Add "${img.name}" to the end`, onclick: () => void update({ images: [...sh.images, img.id] }) },
            h('img', { src: img.src, alt: '', loading: 'lazy' })),
          h('figcaption', {}, img.name))));
      dialog.replaceChildren(
        h('h3', {}, 'Slideshow'),
        h('label', {}, 'Name ', name),
        sh.images.length ? slides : h('p.muted', {}, 'Empty. Click images below to add them in order.'),
        h('h4', {}, 'Add images (click to add to the end)'),
        library.length ? pick : h('p.muted', {}, 'No images yet. Upload some first.'),
        h('div.dialog-buttons', {},
          h('button.danger', { type: 'button', onclick: () => confirm(`Delete the slideshow "${sh.name}"? (The images stay.)`) && void ctx.act({ kind: 'slideshow.delete', id }).then(() => dialog.close()) }, 'Delete slideshow'),
          h('span.spacer'),
          h('button', { type: 'button', disabled: !sh.images.length, onclick: () => { dialog.close(); void present(sh, 0); } }, '▶ Present'),
          h('button', { type: 'button', onclick: () => dialog.close() }, 'Done')),
      );
    };
    document.body.append(dialog);
    paint();
    dialog.showModal();
  }

  // ---- Image actions --------------------------------------------------------------------------

  /** Using an image in front of everyone reveals it. */
  const reveal = (img: ImageDef): Op[] => (img.hidden ? [{ kind: 'image.update', id: img.id, set: { hidden: false } }] : []);
  const send = (ops: Op[]) => ctx.act(ops.length === 1 ? ops[0] : { kind: 'batch', ops });

  /** A new map: shrunk to fit the table if it's bigger, and centered on the table. */
  /** Where a newly set map goes: shrunk to fit inside a margin, centered on the table, so there's
   *  free table on all four sides for cards, tokens and notes. */
  function placeMap(image: string, thumbImg: HTMLImageElement | null) {
    const { w: W, h: H } = ctx.tableSize;
    const nw = thumbImg?.naturalWidth || W;
    const nh = thumbImg?.naturalHeight || H;
    const scale = Math.max(0.1, Math.floor(Math.min(1, (W - 2 * MAP_MARGIN) / nw, (H - 2 * MAP_MARGIN) / nh) * 100) / 100);
    return { image, scale, ...centeredAt(nw * scale, nh * scale) };
  }

  /** Top-left corner that centers a w×h map on the table, keeping at least the margin around it. */
  function centeredAt(w: number, hgt: number) {
    const { w: W, h: H } = ctx.tableSize;
    return { x: Math.round(Math.max(MAP_MARGIN, (W - w) / 2)), y: Math.round(Math.max(MAP_MARGIN, (H - hgt) / 2)) };
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
      !!zone && canMap() && (isMap
        ? item('Remove from the table', () => confirm(`Remove the map "${img.name}" from the table?`) && ctx.act({ kind: 'zone.map', id: zone, map: null }))
        : item('Set as map', () => send([...reveal(img), { kind: 'zone.map', id: zone, map: placeMap(img.id, anchorEl.querySelector('img')) }]))),
      item('Show to everyone', () => send([...reveal(img), { kind: 'spotlight', spotlight: { image: img.id, by: me() } }])),
      canMap() && (state.lobby?.image === img.id
        ? item('Stop using as lobby background', () => ctx.act({ kind: 'lobby', set: { image: null } }))
        : item('Use as lobby background', () => send([...reveal(img), { kind: 'lobby', set: { image: img.id } }]))),
      canMap() && heading('Add to slideshow'),
      ...(canMap() ? shows().map((sh) => item(`${sh.name}${sh.images.includes(img.id) ? ' (again)' : ''}`,
        () => ctx.act({ kind: 'slideshow.update', id: sh.id, set: { images: [...sh.images, img.id] } }))) : []),
      canMap() && item('New slideshow starting with this…', () => newShow([img.id])),
      !!zone && h('hr'),
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
      minimizedKey = ''; // closed: the next time anything is shown, it pops up again
      return;
    }
    // Minimizing applies to this one showing (this slide of this slideshow).
    const key = `${sp.image}|${sp.by}|${sp.show ?? ''}|${sp.index ?? ''}`;
    const minimized = minimizedKey === key;
    const canClose = sp.by === me() || isGm();
    const show = sp.show ? state.slideshows?.[sp.show] : undefined;
    // The presenter (or the GM) steps through a slideshow; everyone sees which slide it is.
    const stepper = show && sp.index !== undefined && h('span.slide-stepper', {},
      canClose && h('button', { type: 'button', title: 'Previous (←)', disabled: sp.index === 0, onclick: () => void present(show, sp.index! - 1) }, '◀'),
      h('span', {}, `${show.name} · ${sp.index + 1} / ${show.images.length}`),
      canClose && h('button', { type: 'button', title: 'Next (→)', disabled: sp.index >= show.images.length - 1, onclick: () => void present(show, sp.index! + 1) }, '▶'));
    spot.replaceChildren(h('figure', {},
      h('img', { src: img.src, alt: img.name }),
      h('figcaption', {}, h('b', {}, img.name), ` · shown by ${sp.by}`, stepper || null,
        h('span.spot-buttons', {},
          h('button', { type: 'button', onclick: () => { minimizedKey = key; renderSpotlight(st()); } }, 'Minimize'),
          canClose && h('button', { type: 'button', onclick: () => void ctx.act({ kind: 'spotlight', spotlight: null }) }, 'Close for everyone')))));
    spot.hidden = minimized;
    chip.hidden = !minimized;
    chip.textContent = `On screen: ${img.name}`;
    chip.onclick = () => { minimizedKey = ''; renderSpotlight(st()); };
  }

  // Arrow keys step through a slideshow being presented (presenter and GM only).
  document.addEventListener('keydown', (e) => {
    const sp = ctx.state()?.spotlight;
    const tag = (e.target as HTMLElement).tagName;
    if (!sp?.show || sp.index === undefined || spot.hidden || tag === 'INPUT' || tag === 'TEXTAREA' || (sp.by !== me() && !isGm())) return;
    const show = st().slideshows?.[sp.show];
    if (!show) return;
    const to = e.key === 'ArrowRight' ? sp.index + 1 : e.key === 'ArrowLeft' ? sp.index - 1 : -1;
    if (to < 0 || to >= show.images.length) return;
    e.preventDefault();
    void present(show, to);
  });

  // ---- Map ------------------------------------------------------------------------------------

  const mapImg = h('img.map', { alt: '', draggable: false });
  surface.prepend(mapImg);
  // Map size controls: labelled "Map size" so they aren't mistaken for table zoom, shown only to
  // whoever may change the map, and removing the map asks first.
  const mapPct = h('input.pct', { type: 'number', min: '10', max: '1000', step: '5', title: 'Map size in percent' });
  const commitPct = () => {
    const v = Number(mapPct.value);
    if (Number.isFinite(v) && v > 0) setMapScale(v / 100);
  };
  mapPct.addEventListener('keydown', (e) => e.key === 'Enter' && (e.preventDefault(), commitPct()));
  mapPct.addEventListener('change', commitPct);
  const mapBox = h('div.map-controls', { hidden: true },
    h('span', {}, 'Map size'),
    h('button', { type: 'button', title: 'Smaller map', onclick: () => scaleMap(1 / 1.25) }, '−'),
    mapPct, h('span.pct-sign', {}, '%'),
    h('button', { type: 'button', title: 'Bigger map', onclick: () => scaleMap(1.25) }, '+'),
    h('button', { type: 'button', title: 'Center the map on the table (cards and drawings on it move with it)', onclick: () => void centerMap() }, 'Center'),
    h('button.map-remove', { type: 'button', title: 'Remove the map from the table', onclick: () => removeMap() }, 'Remove'));
  area.append(mapBox);

  function removeMap() {
    const z = ctx.tableZone();
    const name = z ? st().images?.[st().zones[z]?.map?.image ?? '']?.name : undefined;
    if (z && confirm(`Remove the map${name ? ` "${name}"` : ''} from the table? (It stays in Images.)`)) void ctx.act({ kind: 'zone.map', id: z, map: null });
  }

  /** Move the map to the middle of the table (with a margin all round), taking everything on it
   *  along: the cards and tokens on top of the map and the drawings over it. */
  async function centerMap() {
    const z = ctx.tableZone();
    const map = z ? st().zones[z]?.map : undefined;
    if (!z || !map || !mapImg.naturalWidth) return;
    const w = mapImg.naturalWidth * map.scale;
    const hgt = mapImg.naturalHeight * map.scale;
    const x0 = map.x ?? 0;
    const y0 = map.y ?? 0;
    const { x, y } = centeredAt(w, hgt);
    const dx = x - x0;
    const dy = y - y0;
    if (!dx && !dy) return ctx.note('The map is already centered.');
    const on = (px: number, py: number) => px >= x0 && px <= x0 + w && py >= y0 && py <= y0 + hgt;
    const ops: Op[] = [{ kind: 'zone.map', id: z, map: { ...map, x, y } }];
    for (const p of Object.values(st().pieces)) {
      // `locked` is sent so locked tokens on the map come along too (the engine allows a move that
      // says what the lock should be).
      if (p.zone === z && on(p.x, p.y)) ops.push({ kind: 'piece.update', id: p.id, set: { x: p.x + dx, y: p.y + dy, ...(p.locked ? { locked: true } : {}) } });
    }
    for (const k of Object.values(st().strokes ?? {})) {
      if (k.zone !== z || !on(k.points[0], k.points[1])) continue;
      ops.push({ kind: 'stroke.update', id: k.id, set: { points: k.points.map((v, i) => v + (i % 2 ? dy : dx)) } });
    }
    // Split into messages that fit a WebSocket frame; the map moves in the first one.
    let chunk: Op[] = [];
    let size = 0;
    for (const op of ops) {
      const n = JSON.stringify(op).length;
      if (chunk.length && (size + n > MAX_FRAME || chunk.length >= 150)) {
        if (!(await ctx.act({ kind: 'batch', ops: chunk }))) return;
        chunk = [];
        size = 0;
      }
      chunk.push(op);
      size += n;
    }
    if (chunk.length) await ctx.act(chunk.length === 1 ? chunk[0] : { kind: 'batch', ops: chunk });
  }

  /** Right-click the map: the same size controls a card has, plus Center and Remove. */
  function mapMenu(at: { clientX: number; clientY: number }) {
    const z = ctx.tableZone();
    const map = z ? st().zones[z]?.map : undefined;
    if (!map) return;
    const pct = h('input.pct', { type: 'number', min: '10', max: '1000', step: '5', value: String(Math.round(map.scale * 100)), title: 'Map size in percent' });
    let committed = false;
    const commit = () => {
      const v = Number(pct.value);
      if (committed || !Number.isFinite(v) || v <= 0) return;
      committed = true;
      closeMenu();
      setMapScale(v / 100);
    };
    pct.addEventListener('keydown', (e) => e.key === 'Enter' && (e.preventDefault(), commit()));
    pct.addEventListener('change', commit);
    const step = (f: number) => () => { closeMenu(); scaleMap(f); };
    openMenu(new DOMRect(at.clientX, at.clientY, 0, 0),
      heading(`Map: ${st().images?.[map.image]?.name ?? ''}`),
      h('div.size-row', {},
        h('span', {}, 'Size'),
        h('button', { type: 'button', title: 'Smaller', onclick: step(1 / 1.25) }, '−'),
        pct, h('span.pct-sign', {}, '%'),
        h('button', { type: 'button', title: 'Bigger', onclick: step(1.25) }, '+'),
        h('button', { type: 'button', title: 'Actual size', onclick: () => { closeMenu(); setMapScale(1); } }, '1×')),
      item('Center on the table', () => centerMap()),
      h('hr'),
      item('Remove from the table…', () => removeMap(), { danger: true }),
    );
  }

  surface.addEventListener('contextmenu', (e) => {
    if (mapImg.hidden || !canMap() || (e.target as HTMLElement).closest('.piece')) return;
    const r = mapImg.getBoundingClientRect();
    if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) return;
    e.preventDefault();
    mapMenu(e);
  });

  function setMapScale(scale: number) {
    const z = ctx.tableZone();
    const map = z ? st().zones[z]?.map : undefined;
    if (!z || !map) return;
    const s = Math.round(Math.min(10, Math.max(0.1, scale)) * 100) / 100;
    if (s === map.scale) {
      mapPct.value = String(Math.round(map.scale * 100));
      return;
    }
    // Resize around the map's center, so it grows/shrinks in place instead of from its corner.
    const nw = mapImg.naturalWidth;
    const nh = mapImg.naturalHeight;
    const cx = (map.x ?? 0) + (nw * map.scale) / 2;
    const cy = (map.y ?? 0) + (nh * map.scale) / 2;
    const x = nw ? Math.max(0, Math.round(cx - (nw * s) / 2)) : map.x ?? 0;
    const y = nh ? Math.max(0, Math.round(cy - (nh * s) / 2)) : map.y ?? 0;
    void ctx.act({ kind: 'zone.map', id: z, map: { image: map.image, scale: s, x, y } });
  }

  function scaleMap(f: number) {
    const z = ctx.tableZone();
    const map = z ? st().zones[z]?.map : undefined;
    if (map) setMapScale(map.scale * f);
  }

  // The map image we last scrolled everyone's view to; a different one (a new map, or joining a
  // room that has one) brings the view to it. Resizing doesn't move anyone's view.
  let centeredOn = '';

  function sizeMap(map: { image: string; scale: number; x?: number; y?: number }) {
    const x = map.x ?? 0;
    const y = map.y ?? 0;
    const w = mapImg.naturalWidth * map.scale;
    const hgt = mapImg.naturalHeight * map.scale;
    mapImg.style.width = `${w}px`;
    mapImg.style.left = `${x}px`;
    mapImg.style.top = `${y}px`;
    // Let the table grow to fit a big (or far-placed) map, keeping free table past its far edges.
    const pad = x || y ? MAP_MARGIN : 0; // maps set before centering sit in the corner; leave those as they were
    surface.style.width = `${Math.max(ctx.tableSize.w, Math.ceil(x + w + pad))}px`;
    surface.style.height = `${Math.max(ctx.tableSize.h, Math.ceil(y + hgt + pad))}px`;
    if (centeredOn !== map.image && w > 0) {
      centeredOn = map.image;
      const wrap = surface.parentElement!;
      const z = ctx.zoom();
      wrap.scrollTo({ left: (x + w / 2) * z - wrap.clientWidth / 2, top: (y + hgt / 2) * z - wrap.clientHeight / 2, behavior: 'smooth' });
    }
  }

  function renderMap(state: RoomState) {
    const z = ctx.tableZone();
    const map = z ? state.zones[z]?.map : undefined;
    const img = map ? state.images?.[map.image] : undefined;
    if (!map || !img) {
      mapImg.hidden = true;
      mapImg.removeAttribute('src');
      mapBox.hidden = true;
      centeredOn = '';
      surface.style.width = `${ctx.tableSize.w}px`;
      surface.style.height = `${ctx.tableSize.h}px`;
      return;
    }
    mapImg.hidden = false;
    mapBox.hidden = !(!state.gm || state.gm === me());
    if (document.activeElement !== mapPct) mapPct.value = String(Math.round(map.scale * 100));
    mapImg.onload = () => sizeMap(map);
    if (mapImg.getAttribute('src') !== img.src) mapImg.src = img.src;
    else if (mapImg.complete && mapImg.naturalWidth) sizeMap(map);
  }

  function render(state: RoomState) {
    renderMap(state);
    renderSpotlight(state);
    fill();
  }

  return { render };
}
