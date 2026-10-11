// Live drawing on the table. Finished strokes are saved as ops (so they persist and undo); while a
// stroke is being drawn, its points stream to everyone over the A/V data channel so they see it
// appear live. Pings (a quick "look here" marker) are live-only.
import type { Op, RoomState, Stroke } from '../../shared/model.ts';
import { h, shortId } from './dom';

export interface DrawCtx {
  me(): string;
  state(): RoomState | null;
  act(op: Op): Promise<boolean>;
  /** Send an unsaved real-time message to everyone else (A/V data channel). */
  live(data: unknown): void;
  zoom(): number;
  /** The board zone currently shown as the table. */
  tableZone(): string | undefined;
}

type Tool = 'select' | 'pen' | 'erase' | 'ping';
type Live =
  | { t: 'ink'; id: string; color: string; width: number; pts: number[] }
  | { t: 'ping'; x: number; y: number; color: string };

const SVG = 'http://www.w3.org/2000/svg';
const COLORS = ['#f4d35e', '#ee6352', '#59cd90', '#3fa7d6', '#fafafa', '#1b1b1b'];
const LIVE_EVERY_MS = 80;

function pathData(pts: number[]): string {
  if (pts.length < 2) return '';
  let d = `M${pts[0]} ${pts[1]}`;
  if (pts.length === 2) return `${d}l0.01 0`; // a dot
  for (let i = 2; i < pts.length; i += 2) d += `L${pts[i]} ${pts[i + 1]}`;
  return d;
}

/** Ramer–Douglas–Peucker: drop points that don't change the shape by more than `eps` pixels. */
export function simplify(pts: number[], eps = 1.2): number[] {
  const n = pts.length / 2;
  if (n <= 2) return pts;
  const keep = new Uint8Array(n);
  keep[0] = keep[n - 1] = 1;
  const stack: [number, number][] = [[0, n - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    const [ax, ay, bx, by] = [pts[a * 2], pts[a * 2 + 1], pts[b * 2], pts[b * 2 + 1]];
    const len = Math.hypot(bx - ax, by - ay) || 1;
    let far = -1;
    let farDist = eps;
    for (let i = a + 1; i < b; i++) {
      const d = Math.abs((by - ay) * pts[i * 2] - (bx - ax) * pts[i * 2 + 1] + bx * ay - by * ax) / len;
      if (d > farDist) {
        far = i;
        farDist = d;
      }
    }
    if (far >= 0) {
      keep[far] = 1;
      stack.push([a, far], [far, b]);
    }
  }
  return pts.filter((_, i) => keep[i >> 1]);
}

export function createDrawing(surface: HTMLElement, area: HTMLElement, ctx: DrawCtx) {
  const svg = document.createElementNS(SVG, 'svg');
  svg.classList.add('ink');
  surface.append(svg);
  const paths = new Map<string, SVGPathElement>(); // saved strokes
  const pending = new Map<string, { el: SVGPathElement; timer: ReturnType<typeof setTimeout> }>(); // live/unsaved

  let tool: Tool = 'select';
  let color = COLORS[0];
  let width = 4;

  // ---- Toolbar ----------------------------------------------------------------------------------

  const toolBtn = (t: Tool, label: string, title: string) =>
    h('button.tool', { type: 'button', title, dataset: { tool: t }, onclick: () => setTool(t) }, label);
  const swatches = h('div.swatches', {}, ...COLORS.map((c) =>
    h('button.swatch', { type: 'button', title: c, style: { background: c }, dataset: { color: c }, onclick: () => {
      color = c;
      setTool('pen');
    } })));
  const widthSel = h('select', { title: 'Line width', onchange: () => (width = Number(widthSel.value)) },
    ...[2, 4, 8, 16].map((w) => new Option(`${w}px`, String(w), false, w === width)));
  const clearBtn = h('button.tool', { type: 'button', title: 'Clear drawings' }, 'Clear');
  clearBtn.addEventListener('click', () => void clear());
  const toolbar = h('div.draw-tools', {},
    toolBtn('select', 'Move', 'Move cards and pan (Esc)'),
    toolBtn('pen', 'Draw', 'Draw (D)'),
    toolBtn('erase', 'Erase', 'Erase a line: click or sweep across it (E)'),
    toolBtn('ping', 'Ping', 'Ping: show everyone a spot (P, or Alt+click)'),
    swatches, widthSel, clearBtn,
  );
  area.append(toolbar);

  function setTool(t: Tool) {
    tool = t;
    surface.dataset.tool = t;
    for (const b of toolbar.querySelectorAll<HTMLElement>('.tool[data-tool]')) b.classList.toggle('active', b.dataset.tool === t);
    for (const b of swatches.querySelectorAll<HTMLElement>('.swatch')) b.classList.toggle('active', b.dataset.color === color);
  }
  setTool('select');

  document.addEventListener('keydown', (e) => {
    const tag = (e.target as HTMLElement).tagName;
    if (surface.closest('[hidden]') || tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || e.ctrlKey || e.metaKey || e.altKey) return;
    const map: Record<string, Tool> = { d: 'pen', e: 'erase', p: 'ping', escape: 'select' };
    const t = map[e.key.toLowerCase()];
    if (t) setTool(t);
  });

  async function clear() {
    const state = ctx.state();
    const strokes = Object.values(state?.strokes ?? {});
    if (!strokes.length) return;
    const mine = strokes.filter((k) => k.by === ctx.me());
    const all = mine.length === strokes.length || confirm(`Clear ALL ${strokes.length} drawings? (Cancel clears only your ${mine.length}.)`);
    const doomed = all ? strokes : mine;
    if (!doomed.length) return;
    for (let i = 0; i < doomed.length; i += 150) {
      await ctx.act({ kind: 'batch', ops: doomed.slice(i, i + 150).map((k) => ({ kind: 'stroke.delete', id: k.id }) as Op) });
    }
  }

  // ---- Input ----------------------------------------------------------------------------------

  const toTable = (e: PointerEvent) => {
    const r = surface.getBoundingClientRect();
    return [Math.round((e.clientX - r.left) / ctx.zoom()), Math.round((e.clientY - r.top) / ctx.zoom())];
  };

  function newPath(c: string, w: number) {
    const el = document.createElementNS(SVG, 'path');
    el.setAttribute('stroke', c);
    el.setAttribute('stroke-width', String(w));
    svg.append(el);
    return el;
  }

  // Capture phase so drawing wins over dragging cards and panning (board.ts listens on bubble).
  surface.addEventListener('pointerdown', (e) => {
    const zone = ctx.tableZone();
    if (e.button !== 0 || !zone) return;
    if (e.altKey || tool === 'ping') {
      e.stopPropagation();
      e.preventDefault();
      const [x, y] = toTable(e);
      ping(x, y, color, ctx.me());
      ctx.live({ t: 'ping', x, y, color } satisfies Live);
      return;
    }
    if (tool === 'erase') {
      e.stopPropagation();
      e.preventDefault();
      eraseAt(e);
      const move = (ev: PointerEvent) => eraseAt(ev);
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', () => window.removeEventListener('pointermove', move), { once: true });
      return;
    }
    if (tool !== 'pen') return;
    e.stopPropagation();
    e.preventDefault();

    const id = `ink-${shortId()}`;
    const c = color;
    const w = width;
    const pts = toTable(e);
    const el = newPath(c, w);
    el.setAttribute('d', pathData(pts));
    let sent = 0;
    let lastSend = 0;
    const flush = (force = false) => {
      const now = performance.now();
      if (!force && now - lastSend < LIVE_EVERY_MS) return;
      lastSend = now;
      // Overlap one point so the remote line has no gaps between chunks.
      const from = Math.max(0, sent - 2);
      if (pts.length > from + 2 || (force && sent === 0)) ctx.live({ t: 'ink', id, color: c, width: w, pts: pts.slice(from) } satisfies Live);
      sent = pts.length;
    };
    flush(true);
    const move = (ev: PointerEvent) => {
      const [x, y] = toTable(ev);
      const lx = pts[pts.length - 2];
      const ly = pts[pts.length - 1];
      if (Math.hypot(x - lx, y - ly) < 2) return;
      pts.push(x, y);
      el.setAttribute('d', pathData(pts));
      flush();
    };
    const up = async () => {
      window.removeEventListener('pointermove', move);
      flush(true);
      const points = simplify(pts).slice(0, 2000);
      pending.set(id, { el, timer: setTimeout(() => dropPending(id), 15_000) });
      const ok = await ctx.act({ kind: 'stroke.add', stroke: { id, zone, color: c, width: w, points, by: ctx.me() } });
      if (!ok) dropPending(id);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', () => void up(), { once: true });
  }, { capture: true });

  const erasing = new Set<string>();
  function eraseAt(e: PointerEvent) {
    const el = document.elementFromPoint(e.clientX, e.clientY) as Element | null;
    const id = el?.closest('path[data-stroke]')?.getAttribute('data-stroke');
    if (!id || erasing.has(id)) return;
    erasing.add(id);
    void ctx.act({ kind: 'stroke.delete', id }).finally(() => erasing.delete(id));
  }

  // ---- Live messages from others -----------------------------------------------------------------

  function dropPending(id: string) {
    const p = pending.get(id);
    if (!p) return;
    clearTimeout(p.timer);
    p.el.remove();
    pending.delete(id);
  }

  function ping(x: number, y: number, c: string, who: string, remote = false) {
    const el = h('div.ping', { style: { left: `${x}px`, top: `${y}px`, borderColor: c } }, h('span', {}, who));
    surface.append(el);
    setTimeout(() => el.remove(), 2500);
    // Everyone's view of the table is scrolled differently: bring an off-screen ping into view.
    const wrap = surface.parentElement!;
    const z = ctx.zoom();
    const sx = x * z - wrap.scrollLeft;
    const sy = y * z - wrap.scrollTop;
    if (remote && (sx < 0 || sy < 0 || sx > wrap.clientWidth || sy > wrap.clientHeight)) {
      wrap.scrollTo({ left: x * z - wrap.clientWidth / 2, top: y * z - wrap.clientHeight / 2, behavior: 'smooth' });
    }
  }

  function onLive(from: string, data: unknown) {
    const m = data as Live;
    if (m?.t === 'ping' && Number.isFinite(m.x) && Number.isFinite(m.y)) {
      ping(m.x, m.y, /^#[0-9a-f]{6}$/i.test(m.color) ? m.color : COLORS[0], from, true);
    } else if (m?.t === 'ink' && typeof m.id === 'string' && Array.isArray(m.pts) && !paths.has(m.id)) {
      let p = pending.get(m.id);
      if (!p) {
        const el = newPath(/^#[0-9a-f]{6}$/i.test(m.color) ? m.color : COLORS[0], Math.min(40, Math.max(1, Number(m.width) || 4)));
        el.dataset.pts = '';
        p = { el, timer: setTimeout(() => dropPending(m.id), 15_000) };
        pending.set(m.id, p);
      }
      const pts = [...(p.el.dataset.pts ? p.el.dataset.pts.split(',').map(Number) : []), ...m.pts.filter(Number.isFinite)];
      p.el.dataset.pts = pts.join(',');
      p.el.setAttribute('d', pathData(pts));
    }
  }

  // ---- Rendering saved strokes ------------------------------------------------------------------

  function render(state: RoomState) {
    const zone = ctx.tableZone();
    const strokes = Object.values(state.strokes ?? {}).filter((k: Stroke) => k.zone === zone);
    const seen = new Set<string>();
    for (const k of strokes) {
      seen.add(k.id);
      if (pending.has(k.id)) dropPending(k.id);
      if (paths.has(k.id)) continue;
      const el = newPath(k.color, k.width);
      el.dataset.stroke = k.id;
      el.setAttribute('d', pathData(k.points));
      paths.set(k.id, el);
    }
    for (const [id, el] of paths) {
      if (!seen.has(id)) {
        el.remove();
        paths.delete(id);
      }
    }
  }

  return { render, onLive };
}
