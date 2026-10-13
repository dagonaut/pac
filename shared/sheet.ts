// Sheet templates: the shape of a character sheet (sections of typed fields and card slots).
// Templates are plain JSON so they can be written by hand (see web/public/sheet.schema.json),
// exported from one room and imported into another. A sheet made from a template stores its
// values in the zone's `fields` (as strings) and its cards in the zone's slots.
import { roll } from './dice.ts';

export type FieldType = 'number' | 'text' | 'longtext' | 'checkbox' | 'select' | 'track' | 'die';
export const FIELD_TYPES: FieldType[] = ['number', 'text', 'longtext', 'checkbox', 'select', 'track', 'die'];
export const DICE = ['d4', 'd6', 'd8', 'd10', 'd12', 'd20'];

export interface FieldDef {
  /** Key for the value; unique within the template (lowercase letters, digits, _). */
  id: string;
  label?: string;
  /** Small help text shown under the field, e.g. "Awareness, understanding, smarts". */
  hint?: string;
  type: FieldType;
  /** Starting value: a number, text, true/false, an option, a box count or a die. */
  default?: string | number | boolean;
  /** number: limits for the +/- buttons. */
  min?: number;
  max?: number;
  /** number: dice rolled when the label is clicked, plus the field's value (e.g. "2d6" -> 2d6+2). */
  roll?: string;
  /** select: the choices. */
  options?: string[];
  /** track: how many boxes. */
  boxes?: number;
}

export interface SlotDef {
  id: string;
  label: string;
  /** How many slots of this kind (e.g. 3 Gear slots). Default 1. */
  count?: number;
}

export interface Section {
  title: string;
  /** Rules or instructions shown under the section title. */
  note?: string;
  fields?: FieldDef[];
  slots?: SlotDef[];
}

export interface SheetTemplate {
  id: string;
  name: string;
  sections: Section[];
}

/** The file format: a template without a room-specific id. */
export type SheetTemplateFile = Omit<SheetTemplate, 'id'> & { $schema?: string };

export const SCHEMA_URL = 'https://vtt.16watt.com/sheet.schema.json';

const KEY = /^[a-z][a-z0-9_]{0,31}$/;
const LIMITS = { sections: 20, fields: 200, slots: 50, options: 30, boxes: 20 };

/** Problems with a template, as readable messages (empty when it's valid). */
export function templateErrors(t: unknown): string[] {
  const errs: string[] = [];
  const tpl = t as SheetTemplateFile;
  if (!tpl || typeof tpl !== 'object' || Array.isArray(tpl)) return ['A template must be a JSON object.'];
  const top = Object.keys(tpl).filter((k) => !['$schema', 'id', 'name', 'sections'].includes(k));
  if (top.length) errs.push(`Unknown top-level key "${top[0]}".`);
  if (typeof tpl.name !== 'string' || !tpl.name.trim() || tpl.name.length > 60) errs.push('"name" must be 1–60 characters.');
  if (!Array.isArray(tpl.sections) || !tpl.sections.length) return [...errs, '"sections" must be a non-empty list.'];
  if (tpl.sections.length > LIMITS.sections) errs.push(`At most ${LIMITS.sections} sections.`);

  const ids = new Set<string>();
  let fields = 0;
  let slots = 0;
  tpl.sections.forEach((s, si) => {
    const where = `Section ${si + 1}`;
    if (!s || typeof s !== 'object') return void errs.push(`${where} must be an object.`);
    const extra = Object.keys(s).filter((k) => !['title', 'note', 'fields', 'slots'].includes(k));
    if (s.note !== undefined && (typeof s.note !== 'string' || s.note.length > 600)) errs.push(`${where}: "note" must be text (up to 600 characters).`);
    if (extra.length) errs.push(`${where}: unknown key "${extra[0]}".`);
    if (typeof s.title !== 'string' || s.title.length > 60) errs.push(`${where}: "title" must be text (up to 60 characters).`);
    if (s.fields !== undefined && !Array.isArray(s.fields)) errs.push(`${where}: "fields" must be a list.`);
    if (s.slots !== undefined && !Array.isArray(s.slots)) errs.push(`${where}: "slots" must be a list.`);

    const claim = (id: unknown, what: string) => {
      if (typeof id !== 'string' || !KEY.test(id)) errs.push(`${what}: "id" must be lowercase letters, digits or _ (starting with a letter).`);
      else if (ids.has(id)) errs.push(`${what}: id "${id}" is used twice.`);
      else ids.add(id);
    };

    for (const [fi, f] of (Array.isArray(s.fields) ? s.fields : []).entries()) {
      fields++;
      const w = `${where}, field ${fi + 1}${f && typeof f.label === 'string' ? ` (${f.label})` : ''}`;
      if (!f || typeof f !== 'object') { errs.push(`${w} must be an object.`); continue; }
      claim(f.id, w);
      const extra = Object.keys(f).filter((k) => !['id', 'label', 'hint', 'type', 'default', 'min', 'max', 'roll', 'options', 'boxes'].includes(k));
      if (f.hint !== undefined && (typeof f.hint !== 'string' || f.hint.length > 300)) errs.push(`${w}: "hint" must be text (up to 300 characters).`);
      if (extra.length) errs.push(`${w}: unknown key "${extra[0]}".`);
      if (!FIELD_TYPES.includes(f.type)) errs.push(`${w}: "type" must be one of ${FIELD_TYPES.join(', ')}.`);
      if (f.label !== undefined && (typeof f.label !== 'string' || f.label.length > 60)) errs.push(`${w}: "label" must be text (up to 60 characters).`);
      const num = (v: unknown) => typeof v === 'number' && Number.isFinite(v);
      if (f.min !== undefined && !num(f.min)) errs.push(`${w}: "min" must be a number.`);
      if (f.max !== undefined && !num(f.max)) errs.push(`${w}: "max" must be a number.`);
      if (num(f.min) && num(f.max) && f.min! > f.max!) errs.push(`${w}: "min" is bigger than "max".`);
      if (f.roll !== undefined) {
        if (f.type !== 'number') errs.push(`${w}: "roll" only applies to number fields.`);
        try {
          roll(String(f.roll), () => 1);
        } catch {
          errs.push(`${w}: "roll" must be dice like "2d6" or "d20".`);
        }
      }
      if (f.type === 'select') {
        if (!Array.isArray(f.options) || !f.options.length || f.options.length > LIMITS.options || !f.options.every((o) => typeof o === 'string' && o.length && o.length <= 40)) {
          errs.push(`${w}: a select needs "options": 1–${LIMITS.options} choices of up to 40 characters.`);
        }
      } else if (f.options !== undefined) errs.push(`${w}: "options" only applies to select fields.`);
      if (f.type === 'track') {
        if (!Number.isInteger(f.boxes) || f.boxes! < 1 || f.boxes! > LIMITS.boxes) errs.push(`${w}: a track needs "boxes": 1–${LIMITS.boxes}.`);
      } else if (f.boxes !== undefined) errs.push(`${w}: "boxes" only applies to track fields.`);
      if (f.default !== undefined && FIELD_TYPES.includes(f.type)) {
        const d = f.default;
        const ok =
          f.type === 'number' ? num(d) :
          f.type === 'checkbox' ? typeof d === 'boolean' :
          f.type === 'track' ? Number.isInteger(d) && (d as number) >= 0 && (d as number) <= (f.boxes ?? 0) :
          f.type === 'select' ? Array.isArray(f.options) && f.options.includes(d as string) :
          f.type === 'die' ? DICE.includes(d as string) :
          typeof d === 'string' && d.length <= (f.type === 'longtext' ? 4000 : 500);
        if (!ok) errs.push(`${w}: "default" doesn't fit a ${f.type} field.`);
      }
    }

    for (const [li, sl] of (Array.isArray(s.slots) ? s.slots : []).entries()) {
      const w = `${where}, slot ${li + 1}`;
      if (!sl || typeof sl !== 'object') { errs.push(`${w} must be an object.`); continue; }
      claim(sl.id, w);
      const extra = Object.keys(sl).filter((k) => !['id', 'label', 'count'].includes(k));
      if (extra.length) errs.push(`${w}: unknown key "${extra[0]}".`);
      if (typeof sl.label !== 'string' || !sl.label.trim() || sl.label.length > 40) errs.push(`${w}: "label" must be 1–40 characters.`);
      const count = sl.count ?? 1;
      if (!Number.isInteger(count) || count < 1 || count > 20) errs.push(`${w}: "count" must be 1–20.`);
      else slots += count;
    }
  });
  if (fields > LIMITS.fields) errs.push(`At most ${LIMITS.fields} fields in all.`);
  if (slots > LIMITS.slots) errs.push(`At most ${LIMITS.slots} card slots in all.`);
  return errs;
}

/** Slot labels in order, one per card slot (counts expanded). Slot index = position here. */
export function slotLabels(t: SheetTemplateFile): string[] {
  return t.sections.flatMap((s) => (s.slots ?? []).flatMap((sl) => Array.from({ length: sl.count ?? 1 }, () => sl.label)));
}

/** Starting values for a new sheet, as the strings stored in zone.fields. */
export function defaultValues(t: SheetTemplateFile): Record<string, string> {
  const out: Record<string, string> = {};
  for (const s of t.sections) {
    for (const f of s.fields ?? []) {
      const d = f.default ??
        (f.type === 'number' ? 0 : f.type === 'checkbox' ? false : f.type === 'track' ? 0 :
         f.type === 'select' ? f.options?.[0] ?? '' : f.type === 'die' ? 'd6' : '');
      out[f.id] = String(d);
    }
  }
  return out;
}

/** A clean copy with only known keys, in a stable order (for storing and exporting). */
export function normalizeTemplate(t: SheetTemplateFile, id: string): SheetTemplate {
  return {
    id,
    name: t.name.trim(),
    sections: t.sections.map((s) => ({
      title: s.title,
      ...(s.note ? { note: s.note } : {}),
      ...(s.fields?.length ? { fields: s.fields.map((f) => {
        const keep: FieldDef = { id: f.id, type: f.type };
        for (const k of ['label', 'hint', 'default', 'min', 'max', 'roll', 'options', 'boxes'] as const) {
          if (f[k] !== undefined) (keep as unknown as Record<string, unknown>)[k] = f[k];
        }
        return keep;
      }) } : {}),
      ...(s.slots?.length ? { slots: s.slots.map((sl) => ({ id: sl.id, label: sl.label, ...(sl.count && sl.count !== 1 ? { count: sl.count } : {}) })) } : {}),
    })),
  };
}

/** The exportable file for a template. */
export function templateFile(t: SheetTemplate): SheetTemplateFile {
  const { id: _id, ...rest } = normalizeTemplate(t, t.id);
  return { $schema: SCHEMA_URL, ...rest };
}
