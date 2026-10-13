// Live drawing on the table: freehand lines, shapes (line, arrow, box, circle) and text labels.
// Finished drawings are saved as ops (so they persist and undo); while a line or shape is being
// drawn it streams to everyone over the A/V data channel so they see it appear live. Pings (a quick
// "look here" marker) are live-only.
import type { Op, RoomState, Stroke, StrokeShape } from '../../shared/model.ts';
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

type Tool = 'select' | 'pen' | 'shape' | 'text' | 'erase' | 'ping';
type ShapeKind = 'line' | 'arrow' | 'rect' | 'ellipse';
type Live =
  | { t: 'ink'; id: string; color: string; width: number; pts: number[] }
  | { t: 'shape'; id: string; shape: ShapeKind; color: string; width: number; fill: boolean; pts: number[] }
  | { t: 'ping'; x: number; y: number; color: string };

const SVG = 'http://www.w3.org/2000/svg';
const COLORS = ['#f4d35e', '#ee6352', '#59cd90', '#3fa7d6', '#fafafa', '#1b1b1b'];
const SHAPES: [ShapeKind, string][] = [['line', 'Line'], ['arrow', 'Arrow'], ['rect', 'Box'], ['ellipse', 'Circle']];
const LIVE_EVERY_MS = 80;
const isColor = (c: unknown): c is string => typeof c === 'string' && /^#[0-9a-f]{6}$/i.test(c);

/** Text size for a width step: 2 -> 16px ... 16 -> 58px. */
export const fontSize = (width: number) => Math.round(10 + width * 3);

function pathData(pts: number[]): string {
  if (pts.length < 2) return '';
  let d = `M${pts[0]} ${pts[1]}`;
  if (pts.length === 2) return `${d}l0.01 0`; // a dot
  for (let i = 2; i < pts.length; i += 2) d += `L${pts[i]} ${pts[i + 1]}`;
  return d;
}

/** A line from (x1,y1) to (x2,y2) with an arrowhead at the end, as path data. */
function arrowData(x1: number, y1: number, x2: number, y2: number, width: number): string {
  const len = 10 + width * 2.5;
  const a = Math.atan2(y2 - y1, x2 - x1);
  const head = (da: number) => `${Math.round(x2 - len * Math.cos(a + da))} ${Math.round(y2 - len * Math.sin(a + da))}`;
  return `M${x1} ${y1}L${x2} ${y2}M${head(0.45)}L${x2} ${y2}L${head(-0.45)}`;
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

/** Build (or rebuild) the SVG element for a drawing. */
function drawingEl(k: Pick<Stroke, 'color' | 'width' | 'points' | 'shape' | 'fill' | 'text'>): SVGElement {
  const shape: StrokeShape = k.shape ?? 'path';
  const p = k.points;
  const attrs: Record<string, string | number> = {};
  let tag = 'path';
  switch (shape) {
    case 'path':
      attrs.d = pathData(p);
      break;
    case 'line':
      attrs.d = `M${p[0]} ${p[1]}L${p[2]} ${p[3]}`;
      break;
    case 'arrow':
      attrs.d = arrowData(p[0], p[1], p[2], p[3], k.width);
      break;
    case 'rect':
      tag = 'rect';
      Object.assign(attrs, { x: Math.min(p[0], p[2]), y: Math.min(p[1], p[3]), width: Math.abs(p[2] - p[0]), height: Math.abs(p[3] - p[1]), rx: 3 });
      break;
    case 'ellipse':
      tag = 'ellipse';
      Object.assign(attrs, { cx: (p[0] + p[2]) / 2, cy: (p[1] + p[3]) / 2, rx: Math.abs(p[2] - p[0]) / 2, ry: Math.abs(p[3] - p[1]) / 2 });
      break;
    case 'text':
      tag = 'text';
      Object.assign(attrs, { x: p[0], y: p[1], 'font-size': fontSize(k.width), fill: k.color });
      break;
  }
  const el = document.createElementNS(SVG, tag) as SVGElement;
  for (const [a, v] of Object.entries(attrs)) el.setAttribute(a, String(v));
  if (shape === 'text') {
    el.classList.add('ink-text');
    // One <tspan> per line; each starts back at the left edge, one line-height down.
    (k.text ?? '').split('\n').forEach((line, i) => {
      const span = document.createElementNS(SVG, 'tspan');
      span.setAttribute('x', String(p[0]));
      if (i) span.setAttribute('dy', '1.2em');
      span.textContent = line || ' ';
      el.append(span);
    });
  } else {
    el.setAttribute('stroke', k.color);
    el.setAttribute('stroke-width', String(k.width));
    if (k.fill) {
      el.setAttribute('fill', k.color);
      el.setAttribute('fill-opacity', '0.3');
    }
  }
  return el;
}

export function createDrawing(surface: HTMLElement, area: HTMLElement, ctx: DrawCtx) {
  const svg = document.createElementNS(SVG, 'svg');
  svg.classList.add('ink');
  surface.append(svg);
  const saved = new Map<string, { el: SVGElement; key: string }>();
  const pending = new Map<string, { el: SVGElement; pts: number[]; timer: ReturnType<typeof setTimeout> }>(); // live/unsaved

  let tool: Tool = 'select';
  let color = COLORS[0];
  let width = 4;
  let shapeKind: ShapeKind = 'arrow';
  let fill = false;

  // ---- Toolbar ----------------------------------------------------------------------------------

  const toolBtn = (t: Tool, label: string, title: string) =>
    h('button.tool', { type: 'button', title, dataset: { tool: t }, onclick: () => setTool(t) }, label);
  const swatches = h('div.swatches', {}, ...COLORS.map((c) =>
    h('button.swatch', { type: 'button', title: c, style: { background: c }, dataset: { color: c }, onclick: () => {
      color = c;
      if (tool === 'select' || tool === 'erase' || tool === 'ping') setTool('pen');
      else setTool(tool);
    } })));
  const widthSel = h('select', { title: 'Line width / text size', onchange: () => (width = Number(widthSel.value)) },
    ...[2, 4, 8, 16].map((w) => new Option(`${w}px`, String(w), false, w === width)));
  const shapeSel = h('select', { title: 'Shape', onchange: () => { shapeKind = shapeSel.value as ShapeKind; setTool('shape'); } },
    ...SHAPES.map(([k, l]) => new Option(l, k, false, k === shapeKind)));
  const fillBox = h('input', { type: 'checkbox', onchange: () => { fill = fillBox.checked; } });
  const clearBtn = h('button.tool', { type: 'button', title: 'Clear drawings' }, 'Clear');
  clearBtn.addEventListener('click', () => void clear());
  const toolbar = h('div.draw-tools', {},
    toolBtn('select', 'Move', 'Move cards and pan (Esc)'),
    toolBtn('pen', 'Draw', 'Freehand (D)'),
    h('span.tool-group', {}, toolBtn('shape', 'Shape', 'Line, arrow, box or circle (S). Hold Shift for straight lines, squares and circles.'), shapeSel),
    h('label.fill-toggle', { title: 'Fill boxes and circles' }, fillBox, 'Fill'),
    toolBtn('text', 'Text', 'Click to add text (Enter = new line, click away to finish); double-click text to edit it; drag text to move it'),
    toolBtn('erase', 'Erase', 'Erase: click or sweep across a drawing (E)'),
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
    const map: Record<string, Tool> = { d: 'pen', s: 'shape', e: 'erase', p: 'ping', escape: 'select' };
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

  const toTable = (e: { clientX: number; clientY: number }) => {
    const r = surface.getBoundingClientRect();
    return [Math.round((e.clientX - r.left) / ctx.zoom()), Math.round((e.clientY - r.top) / ctx.zoom())];
  };

  function addPending(id: string, el: SVGElement, pts: number[]) {
    svg.append(el);
    pending.set(id, { el, pts, timer: setTimeout(() => dropPending(id), 15_000) });
  }

  /** Save a drawing; keep the local preview until the server's copy arrives. */
  async function save(stroke: Stroke, preview: SVGElement) {
    pending.set(stroke.id, { el: preview, pts: stroke.points, timer: setTimeout(() => dropPending(stroke.id), 15_000) });
    if (!(await ctx.act({ kind: 'stroke.add', stroke }))) dropPending(stroke.id);
  }

  /** Shift: lines snap to 45°, boxes and circles become square/round. */
  function constrain(x1: number, y1: number, x2: number, y2: number, shift: boolean): [number, number] {
    if (!shift) return [x2, y2];
    const dx = x2 - x1;
    const dy = y2 - y1;
    if (shapeKind === 'rect' || shapeKind === 'ellipse') {
      const s = Math.max(Math.abs(dx), Math.abs(dy));
      return [x1 + Math.sign(dx || 1) * s, y1 + Math.sign(dy || 1) * s];
    }
    const a = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
    const len = Math.hypot(dx, dy);
    return [Math.round(x1 + len * Math.cos(a)), Math.round(y1 + len * Math.sin(a))];
  }

  // Capture phase so drawing wins over dragging cards and panning (board.ts listens on bubble).
  surface.addEventListener('pointerdown', (e) => {
    const zone = ctx.tableZone();
    if (e.button !== 0 || !zone || (e.target as HTMLElement).closest('.text-editor')) return;
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
    if (tool === 'text') {
      e.stopPropagation();
      e.preventDefault();
      const hit = (e.target as Element).closest?.('text[data-stroke]');
      if (hit) moveText(hit.getAttribute('data-stroke')!, e);
      else {
        const [x, y] = toTable(e);
        editText(zone, x, y);
      }
      return;
    }
    if (tool === 'shape') {
      e.stopPropagation();
      e.preventDefault();
      drawShape(zone, e);
      return;
    }
    if (tool !== 'pen') return;
    e.stopPropagation();
    e.preventDefault();
    drawFreehand(zone, e);
  }, { capture: true });

  function drawFreehand(zone: string, e: PointerEvent) {
    const id = `ink-${shortId()}`;
    const c = color;
    const w = width;
    const pts = toTable(e);
    const el = drawingEl({ color: c, width: w, points: pts });
    svg.append(el);
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
      if (Math.hypot(x - pts[pts.length - 2], y - pts[pts.length - 1]) < 2) return;
      pts.push(x, y);
      el.setAttribute('d', pathData(pts));
      flush();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', () => {
      window.removeEventListener('pointermove', move);
      flush(true);
      void save({ id, zone, color: c, width: w, points: simplify(pts).slice(0, 1000), by: ctx.me() }, el);
    }, { once: true });
  }

  function drawShape(zone: string, e: PointerEvent) {
    const id = `ink-${shortId()}`;
    const shape = shapeKind;
    const c = color;
    const w = width;
    const f = fill && (shape === 'rect' || shape === 'ellipse');
    const [x1, y1] = toTable(e);
    let pts = [x1, y1, x1, y1];
    let el = drawingEl({ color: c, width: w, points: pts, shape, fill: f });
    svg.append(el);
    let lastSend = 0;
    const move = (ev: PointerEvent) => {
      const [mx, my] = toTable(ev);
      pts = [x1, y1, ...constrain(x1, y1, mx, my, ev.shiftKey)];
      const next = drawingEl({ color: c, width: w, points: pts, shape, fill: f });
      el.replaceWith(next);
      el = next;
      const now = performance.now();
      if (now - lastSend >= LIVE_EVERY_MS) {
        lastSend = now;
        ctx.live({ t: 'shape', id, shape, color: c, width: w, fill: f, pts } satisfies Live);
      }
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', () => {
      window.removeEventListener('pointermove', move);
      if (Math.hypot(pts[2] - pts[0], pts[3] - pts[1]) < 4) {
        el.remove(); // a click, not a drag
        return;
      }
      ctx.live({ t: 'shape', id, shape, color: c, width: w, fill: f, pts } satisfies Live);
      void save({ id, zone, color: c, width: w, points: pts, by: ctx.me(), shape, ...(f ? { fill: true } : {}) }, el);
    }, { once: true });
  }

  // ---- Text -----------------------------------------------------------------------------------

  /** An input on the table where the text will be. New text when `existing` is undefined. */
  function editText(zone: string, x: number, y: number, existing?: Stroke) {
    surface.querySelector('.text-editor')?.remove();
    const c = existing?.color ?? color;
    const w = existing?.width ?? width;
    const original = existing && saved.get(existing.id)?.el;
    if (original) original.style.visibility = 'hidden';
    const input = h('textarea.text-editor', {
      maxLength: 1000,
      rows: 1,
      placeholder: 'Type… (click away to finish)',
      style: { left: `${x}px`, top: `${y}px`, fontSize: `${fontSize(w)}px`, color: c },
    });
    input.value = existing?.text ?? '';
    // Grow with the text: as many rows as lines, as wide as the longest line.
    const fit = () => {
      const lines = input.value.split('\n');
      input.rows = Math.max(1, lines.length);
      input.cols = Math.max(12, ...lines.map((l) => l.length + 1));
    };
    input.addEventListener('input', fit);
    fit();
    let done = false;
    const finish = async (commit: boolean) => {
      if (done) return;
      done = true;
      const text = input.value.replace(/\s+$/, '').replace(/^\n+/, '');
      input.remove();
      if (original) original.style.visibility = '';
      if (!commit || !text || text === existing?.text) return;
      if (existing) await ctx.act({ kind: 'stroke.update', id: existing.id, set: { text } });
      else {
        const stroke: Stroke = { id: `ink-${shortId()}`, zone, color: c, width: w, points: [x, y], by: ctx.me(), shape: 'text', text };
        const el = drawingEl(stroke);
        svg.append(el);
        await save(stroke, el);
      }
    };
    input.addEventListener('keydown', (ev) => {
      ev.stopPropagation(); // keep F/T/U/D/E shortcuts out of the text
      // Enter is a new line; Ctrl/Cmd+Enter or clicking away finishes; Esc cancels.
      if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) void finish(true);
      if (ev.key === 'Escape') void finish(false);
    });
    input.addEventListener('blur', () => void finish(true));
    surface.append(input);
    // Focus right away: the pointerdown that placed it is prevented, so nothing steals focus, and
    // deferring it would drop the first keystrokes of a fast typist.
    input.focus();
  }

  /** Drag a text label to move it; a click without moving does nothing (double-click edits). */
  function moveText(id: string, e: PointerEvent) {
    const k = ctx.state()?.strokes?.[id];
    const el = saved.get(id)?.el;
    if (!k || !el) return;
    const [sx, sy] = toTable(e);
    let dx = 0;
    let dy = 0;
    // Each line (<tspan>) carries its own x, so move those along with the text.
    const place = (x: number, y: number) => {
      el.setAttribute('x', String(x));
      el.setAttribute('y', String(y));
      for (const span of el.querySelectorAll('tspan')) span.setAttribute('x', String(x));
    };
    const move = (ev: PointerEvent) => {
      const [x, y] = toTable(ev);
      dx = x - sx;
      dy = y - sy;
      place(k.points[0] + dx, k.points[1] + dy);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', () => {
      window.removeEventListener('pointermove', move);
      if (Math.hypot(dx, dy) < 3) return;
      void ctx.act({ kind: 'stroke.update', id, set: { points: [k.points[0] + dx, k.points[1] + dy] } }).then((ok) => {
        if (!ok) place(k.points[0], k.points[1]);
      });
    }, { once: true });
  }

  surface.addEventListener('dblclick', (e) => {
    if (tool !== 'text') return;
    const id = (e.target as Element).closest?.('text[data-stroke]')?.getAttribute('data-stroke');
    const k = id ? ctx.state()?.strokes?.[id] : undefined;
    if (k) editText(k.zone, k.points[0], k.points[1], k);
  });

  const erasing = new Set<string>();
  function eraseAt(e: PointerEvent) {
    const el = document.elementFromPoint(e.clientX, e.clientY) as Element | null;
    const id = el?.closest('[data-stroke]')?.getAttribute('data-stroke');
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
      ping(m.x, m.y, isColor(m.color) ? m.color : COLORS[0], from, true);
      return;
    }
    if (!m || typeof (m as { id?: unknown }).id !== 'string' || !Array.isArray((m as { pts?: unknown }).pts) || saved.has((m as { id: string }).id)) return;
    const w = Math.min(40, Math.max(1, Number((m as { width?: unknown }).width) || 4));
    const c = isColor((m as { color?: unknown }).color) ? (m as { color: string }).color : COLORS[0];
    const nums = (m as { pts: unknown[] }).pts.filter((v): v is number => Number.isFinite(v));
    if (m.t === 'ink') {
      const p = pending.get(m.id);
      const pts = [...(p?.pts ?? []), ...nums];
      const el = drawingEl({ color: c, width: w, points: pts });
      if (p) {
        p.el.replaceWith(el);
        p.el = el;
        p.pts = pts;
      } else addPending(m.id, el, pts);
    } else if (m.t === 'shape' && nums.length === 4 && SHAPES.some(([k]) => k === m.shape)) {
      const el = drawingEl({ color: c, width: w, points: nums, shape: m.shape, fill: !!m.fill });
      const p = pending.get(m.id);
      if (p) {
        p.el.replaceWith(el);
        p.el = el;
      } else addPending(m.id, el, nums);
    }
  }

  // ---- Rendering saved drawings -----------------------------------------------------------------

  function render(state: RoomState) {
    const zone = ctx.tableZone();
    const strokes = Object.values(state.strokes ?? {}).filter((k: Stroke) => k.zone === zone);
    const seen = new Set<string>();
    for (const k of strokes) {
      seen.add(k.id);
      if (pending.has(k.id)) dropPending(k.id);
      const key = `${k.points.join(',')}|${k.text ?? ''}`;
      const cur = saved.get(k.id);
      if (cur?.key === key) continue;
      const el = drawingEl(k);
      el.dataset.stroke = k.id;
      if (cur) cur.el.replaceWith(el);
      else svg.append(el);
      saved.set(k.id, { el, key });
    }
    for (const [id, { el }] of saved) {
      if (!seen.has(id)) {
        el.remove();
        saved.delete(id);
      }
    }
  }

  return { render, onLive };
}
