// Tiny DOM helpers: h('div.a.b', {title: 'x', onclick}, child, 'text'...)

type Attrs = Record<string, unknown> & { dataset?: Record<string, string>; style?: Partial<CSSStyleDeclaration> };
type Child = Node | string | number | null | undefined | false;

export function h<K extends keyof HTMLElementTagNameMap>(
  spec: K | `${K}.${string}` | `${K}#${string}`,
  attrs: Attrs = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const [tagAndId, ...classes] = spec.split('.');
  const [tag, id] = tagAndId.split('#');
  const el = document.createElement(tag as K);
  if (id) el.id = id;
  if (classes.length) el.classList.add(...classes);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'className') el.classList.add(...String(v).split(/\s+/).filter(Boolean));
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k === 'style') Object.assign(el.style, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v as EventListener);
    else if (k in el && typeof v !== 'string') (el as unknown as Record<string, unknown>)[k] = v;
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : String(c));
  }
  return el;
}

export const $ = <T extends HTMLElement>(sel: string, root: ParentNode = document) => root.querySelector<T>(sel)!;

export const shortId = () => crypto.randomUUID().replace(/-/g, '').slice(0, 10);
