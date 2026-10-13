// Sheet templates library and builder. Templates are JSON (see web/public/sheet.schema.json):
// build them here step by step or edit the JSON directly, export them to a .json file, and import
// them into any room.
import type { Op, RoomState } from '../../shared/model.ts';
import {
  DICE, FIELD_TYPES, type FieldDef, type FieldType, type Section, type SheetTemplate, type SheetTemplateFile,
  SCHEMA_URL, templateErrors, templateFile,
} from '../../shared/sheet.ts';
import { h } from './dom';
import { fieldControl } from './sheets';

export interface TemplatesCtx {
  state(): RoomState | null;
  act(op: Op): Promise<boolean>;
}

const TYPE_NAMES: Record<FieldType, string> = {
  number: 'Number (+/−, optional dice roll)',
  text: 'Text (one line)',
  longtext: 'Notes (several lines)',
  checkbox: 'Checkbox',
  select: 'Choice from a list',
  track: 'Track of boxes (harm, stress)',
  die: 'Die size (d4–d20, click to roll)',
  image: 'Picture (e.g. a portrait)',
};

const slug = (s: string, max = 32) => s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, max);
const keyFrom = (label: string) => {
  const k = slug(label);
  return /^[a-z]/.test(k) ? k : `f_${k}`.slice(0, 32);
};

function download(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const a = h('a', { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function uniqueId(state: RoomState, name: string) {
  const base = `tpl-${slug(name, 40).replace(/_/g, '-') || 'sheet'}`;
  let id = base;
  for (let n = 2; state.templates?.[id]; n++) id = `${base}-${n}`;
  return id;
}

/** A read-only preview of a template, using the same controls as real sheets. */
function preview(t: SheetTemplateFile) {
  const noop = () => {};
  return h('div.zone.sheet-t.preview-sheet', {},
    h('div.zone-head', {}, h('span', {}, t.name || 'Untitled')),
    h('div.sheet-sections', {}, ...(Array.isArray(t.sections) ? t.sections : []).map((s) => h('section.sheet-section', {},
      s?.title && h('h4', {}, s.title),
      typeof s?.note === 'string' && s.note && h('p.sheet-note', {}, s.note),
      (s?.fields?.length ?? 0) > 0 && h('div.sheet-fields', {}, ...(s.fields ?? []).map((f) => {
        try {
          const d = f.default ?? (f.type === 'select' ? f.options?.[0] : f.type === 'die' ? 'd6' : '');
          return fieldControl(f, String(d ?? ''), noop, noop, `preview/${f.id}`) ?? h('span');
        } catch {
          return h('span.error', {}, f?.label ?? '?');
        }
      })),
      (s?.slots?.length ?? 0) > 0 && h('div.strip-cards', {}, ...(s.slots ?? []).flatMap((sl) =>
        Array.from({ length: Math.min(20, Math.max(1, Number(sl.count) || 1)) }, () => h('div.slot', {}, h('small.slot-label', {}, sl.label)))))))));
}

export function createTemplates(ctx: TemplatesCtx) {
  const st = () => ctx.state()!;

  // ---- Library ------------------------------------------------------------------------------

  function openLibrary() {
    const dialog = h('dialog.modal.templates', { onclose: () => dialog.remove() });
    const error = h('p.error', { hidden: true });
    const showError = (msg: string) => {
      error.textContent = msg;
      error.hidden = !msg;
    };

    const fill = () => {
      const state = st();
      const list = Object.values(state.templates ?? {}).sort((a, b) => a.name.localeCompare(b.name));
      const uses = (id: string) => Object.values(state.zones).filter((z) => z.template === id).length;
      const rows = list.map((t) => {
        const fields = t.sections.reduce((n, s) => n + (s.fields?.length ?? 0), 0);
        const slots = t.sections.reduce((n, s) => n + (s.slots ?? []).reduce((m, sl) => m + (sl.count ?? 1), 0), 0);
        const n = uses(t.id);
        return h('li', {},
          h('div', {}, h('strong', {}, t.name), h('small', {}, `${t.sections.length} sections · ${fields} fields · ${slots} card slots${n ? ` · used by ${n} sheet${n === 1 ? '' : 's'}` : ''}`)),
          h('button', { type: 'button', onclick: () => { dialog.close(); openEditor(t); } }, 'Edit'),
          h('button', { type: 'button', onclick: () => download(`${slug(t.name, 40).replace(/_/g, '-') || 'sheet'}.sheet.json`, JSON.stringify(templateFile(t), null, 2)) }, 'Export'),
          h('button', { type: 'button', onclick: async () => {
            await ctx.act({ kind: 'template.create', template: { ...t, id: uniqueId(state, `${t.name} copy`), name: `${t.name} copy`.slice(0, 60) } });
            fill();
          } }, 'Duplicate'),
          !n && h('button.danger-text', { type: 'button', onclick: async () => {
            if (confirm(`Delete the template "${t.name}"?`)) {
              await ctx.act({ kind: 'template.delete', id: t.id });
              fill();
            }
          } }, 'Delete'));
      });

      const file = h('input', { type: 'file', accept: '.json,application/json', hidden: true });
      file.addEventListener('change', async () => {
        showError('');
        for (const f of file.files ?? []) {
          let parsed: SheetTemplateFile;
          try {
            parsed = JSON.parse(await f.text());
          } catch (e) {
            return showError(`${f.name} isn't valid JSON: ${(e as Error).message}`);
          }
          const errs = templateErrors(parsed);
          if (errs.length) return showError(`${f.name}: ${errs.slice(0, 3).join(' ')}`);
          const { $schema: _s, id: _i, ...rest } = parsed as SheetTemplateFile & { id?: string };
          if (!(await ctx.act({ kind: 'template.create', template: { ...rest, id: uniqueId(st(), rest.name) } }))) return;
        }
        fill();
      });

      dialog.replaceChildren(
        h('h3', {}, 'Sheet templates'),
        h('p.muted', {}, 'A template is the shape of a character sheet. Build one here, or write the JSON yourself (VS Code checks it against ',
          h('a', { href: SCHEMA_URL, target: '_blank' }, 'the schema'), '), then Import. Export to move a template to another room.'),
        list.length ? h('ul.template-list', {}, ...rows) : h('p.muted', {}, 'No templates in this room yet.'),
        error,
        h('div.dialog-buttons', {},
          h('button', { type: 'button', onclick: () => file.click() }, 'Import .json…'),
          h('button', { type: 'button', onclick: () => { dialog.close(); openEditor(); } }, 'New template'),
          h('button', { type: 'button', onclick: () => dialog.close() }, 'Close')),
        file,
      );
    };
    fill();
    document.body.append(dialog);
    dialog.showModal();
  }

  // ---- Builder ------------------------------------------------------------------------------

  function openEditor(existing?: SheetTemplate) {
    let draft: SheetTemplateFile = existing
      ? structuredClone(templateFile(existing))
      : { name: 'New sheet', sections: [{ title: 'Stats', fields: [{ id: 'hp', label: 'HP', type: 'number', default: 10, min: 0 }] }] };
    delete draft.$schema;
    let mode: 'build' | 'json' = 'build';

    const dialog = h('dialog.modal.template-editor', { onclose: () => dialog.remove() });
    const builder = h('div.builder');
    const jsonArea = h('textarea.json-edit', { spellcheck: false, rows: 24 });
    const previewBox = h('div.preview-box');
    const errorsBox = h('ul.template-errors');
    const saveBtn = h('button', { type: 'submit' }, existing ? 'Save changes' : 'Create template');
    const modeBtns = h('div.mode-tabs', {},
      h('button', { type: 'button', dataset: { mode: 'build' }, onclick: () => switchMode('build') }, 'Builder'),
      h('button', { type: 'button', dataset: { mode: 'json' }, onclick: () => switchMode('json') }, 'JSON'));

    /** Drop empty optional values the form leaves behind. */
    function clean(t: SheetTemplateFile): SheetTemplateFile {
      return {
        name: t.name,
        sections: t.sections.map((s) => ({
          title: s.title,
          ...(s.note ? { note: s.note } : {}),
          ...(s.fields?.length ? { fields: s.fields.map((f) => Object.fromEntries(Object.entries(f).filter(([, v]) => v !== undefined && v !== '' && !(Array.isArray(v) && !v.length))) as unknown as FieldDef) } : {}),
          ...(s.slots?.length ? { slots: s.slots } : {}),
        })),
      };
    }

    function refresh() {
      const t = mode === 'json' ? (() => {
        try {
          return JSON.parse(jsonArea.value) as SheetTemplateFile;
        } catch (e) {
          return e as Error;
        }
      })() : clean(draft);
      const errs = t instanceof Error ? [`JSON: ${t.message}`] : templateErrors(t);
      errorsBox.replaceChildren(...errs.slice(0, 8).map((e) => h('li', {}, e)));
      errorsBox.hidden = !errs.length;
      saveBtn.disabled = errs.length > 0;
      if (!(t instanceof Error)) previewBox.replaceChildren(preview(t));
    }

    function switchMode(next: 'build' | 'json') {
      if (next === mode) return;
      if (next === 'build') {
        try {
          const parsed = JSON.parse(jsonArea.value) as SheetTemplateFile;
          if (!parsed || !Array.isArray(parsed.sections)) throw new Error('needs a "sections" list');
          draft = parsed;
          delete draft.$schema;
        } catch (e) {
          errorsBox.replaceChildren(h('li', {}, `Fix the JSON before switching: ${(e as Error).message}`));
          errorsBox.hidden = false;
          return;
        }
      } else {
        jsonArea.value = JSON.stringify({ $schema: SCHEMA_URL, ...clean(draft) }, null, 2);
      }
      mode = next;
      builder.hidden = mode !== 'build';
      jsonArea.hidden = mode !== 'json';
      for (const b of modeBtns.querySelectorAll<HTMLElement>('button')) b.classList.toggle('active', b.dataset.mode === mode);
      if (mode === 'build') renderBuilder();
      refresh();
    }

    jsonArea.addEventListener('input', refresh);

    // -- Form pieces. Typing updates the draft in place (no re-render, so focus stays); adding,
    //    removing, moving or changing a type re-renders the builder.

    const move = <T,>(list: T[], i: number, d: number) => {
      const j = i + d;
      if (j < 0 || j >= list.length) return;
      [list[i], list[j]] = [list[j], list[i]];
      renderBuilder();
    };
    const remove = <T,>(list: T[], i: number) => {
      list.splice(i, 1);
      renderBuilder();
    };
    const tools = <T,>(list: T[], i: number, what: string) => h('span.row-tools', {},
      h('button', { type: 'button', title: `Move ${what} up`, onclick: () => move(list, i, -1) }, '↑'),
      h('button', { type: 'button', title: `Move ${what} down`, onclick: () => move(list, i, 1) }, '↓'),
      h('button', { type: 'button', title: `Remove ${what}`, onclick: () => remove(list, i) }, '×'));

    const text = (value: string | undefined, on: (v: string) => void, attrs: Record<string, unknown> = {}) => {
      const input = h('input', { value: value ?? '', ...attrs });
      input.addEventListener('input', () => { on(input.value); refresh(); });
      return input;
    };
    const num = (value: number | undefined, on: (v: number | undefined) => void, attrs: Record<string, unknown> = {}) =>
      text(value === undefined ? '' : String(value), (v) => on(v.trim() === '' || Number.isNaN(Number(v)) ? undefined : Number(v)), { inputMode: 'decimal', className: 'small-num', ...attrs });
    const labeled = (label: string, el: HTMLElement) => h('label.opt', {}, h('span', {}, label), el);

    // Keys that follow their label until someone edits the key by hand.
    const autoKey = new WeakSet<object>();
    function followLabel(target: { id: string }, oldLabel: string, newLabel: string, idInput: HTMLInputElement) {
      if (!autoKey.has(target) && target.id && target.id !== keyFrom(oldLabel)) return;
      autoKey.add(target);
      target.id = '';
      target.id = freshId(newLabel || 'field');
      idInput.value = target.id;
    }

    function allIds() {
      return new Set(draft.sections.flatMap((s) => [...(s.fields ?? []).map((f) => f.id), ...(s.slots ?? []).map((sl) => sl.id)]));
    }
    function freshId(label: string) {
      const ids = allIds();
      const base = keyFrom(label) || 'field';
      let id = base;
      for (let n = 2; ids.has(id); n++) id = `${base}_${n}`.slice(0, 32);
      return id;
    }

    function fieldRow(s: Section, f: FieldDef, i: number) {
      const idInput = text(f.id, (v) => { f.id = v.trim(); autoKey.delete(f); }, { className: 'id-input', title: 'Key used to store the value (lowercase, digits, _)' });
      const label = text(f.label, (v) => {
        followLabel(f, f.label ?? '', v, idInput);
        f.label = v;
      }, { placeholder: 'Label, e.g. INT' });
      const type = h('select', {}, ...FIELD_TYPES.map((t) => new Option(TYPE_NAMES[t], t, false, t === f.type)));
      type.addEventListener('change', () => {
        f.type = type.value as FieldType;
        for (const k of ['default', 'min', 'max', 'roll', 'options', 'boxes'] as const) delete f[k];
        if (f.type === 'select') f.options = ['Option 1', 'Option 2'];
        if (f.type === 'track') f.boxes = 4;
        renderBuilder();
      });

      const opts: HTMLElement[] = [];
      switch (f.type) {
        case 'number':
          opts.push(
            labeled('Start', num(f.default as number | undefined, (v) => (f.default = v))),
            labeled('Min', num(f.min, (v) => (f.min = v))),
            labeled('Max', num(f.max, (v) => (f.max = v))),
            labeled('Roll when clicked', text(f.roll, (v) => (f.roll = v.trim() || undefined), { placeholder: 'e.g. 2d6 (adds the value)', className: 'roll-input' })));
          break;
        case 'text':
        case 'longtext':
          opts.push(labeled('Start', text(f.default as string | undefined, (v) => (f.default = v || undefined))));
          break;
        case 'checkbox': {
          const box = h('input', { type: 'checkbox', checked: f.default === true });
          box.addEventListener('change', () => { f.default = box.checked || undefined; refresh(); });
          opts.push(labeled('Checked to start', box));
          break;
        }
        case 'select': {
          const options = text((f.options ?? []).join(', '), (v) => {
            f.options = v.split(',').map((o) => o.trim()).filter(Boolean);
            if (f.default !== undefined && !f.options.includes(String(f.default))) delete f.default;
          }, { placeholder: 'Choices, separated by commas', className: 'wide' });
          opts.push(labeled('Choices', options));
          break;
        }
        case 'track':
          opts.push(
            labeled('Boxes', num(f.boxes, (v) => (f.boxes = v === undefined ? undefined : Math.round(v)))),
            labeled('Filled to start', num(f.default as number | undefined, (v) => (f.default = v === undefined ? undefined : Math.round(v)))));
          break;
        case 'die': {
          const die = h('select', {}, new Option('—', ''), ...DICE.map((d) => new Option(d, d, false, d === f.default)));
          die.addEventListener('change', () => { f.default = die.value || undefined; refresh(); });
          opts.push(labeled('Start', die));
          break;
        }
      }
      opts.push(labeled('Hint', text(f.hint, (v) => (f.hint = v || undefined), { placeholder: 'Help text shown under it (optional)', className: 'wide', maxLength: 300 })));
      return h('div.field-row', {}, h('div.field-main', {}, label, type, idInput, tools(s.fields!, i, 'field')), h('div.field-opts', {}, ...opts));
    }

    function slotRow(s: Section, sl: { id: string; label: string; count?: number }, i: number) {
      const idInput = text(sl.id, (v) => { sl.id = v.trim(); autoKey.delete(sl); }, { className: 'id-input' });
      return h('div.field-row', {}, h('div.field-main', {},
        text(sl.label, (v) => {
          followLabel(sl, sl.label, v, idInput);
          sl.label = v;
        }, { placeholder: 'Slot label, e.g. Weapon' }),
        labeled('How many', num(sl.count ?? 1, (v) => (sl.count = v === undefined ? undefined : Math.round(v)))),
        idInput,
        tools(s.slots!, i, 'slot')));
    }

    function renderBuilder() {
      const sections = draft.sections.map((s, si) => h('fieldset.section-box', {},
        h('div.section-head', {},
          text(s.title, (v) => (s.title = v), { placeholder: 'Section title', className: 'section-title' }),
          tools(draft.sections, si, 'section')),
        text(s.note, (v) => (s.note = v || undefined), { placeholder: 'Section note: rules or instructions (optional)', className: 'section-note', maxLength: 600 }),
        ...(s.fields ?? []).map((f, i) => fieldRow(s, f, i)),
        ...(s.slots ?? []).map((sl, i) => slotRow(s, sl, i)),
        h('div.add-row', {},
          h('button', { type: 'button', onclick: () => {
            const f: FieldDef = { id: freshId('field'), label: '', type: 'number' };
            autoKey.add(f);
            (s.fields ??= []).push(f);
            renderBuilder();
          } }, '+ Field'),
          h('button', { type: 'button', onclick: () => {
            const sl = { id: freshId('slot'), label: 'Slot' };
            autoKey.add(sl);
            (s.slots ??= []).push(sl);
            renderBuilder();
          } }, '+ Card slot'))));
      builder.replaceChildren(
        labeled('Template name', text(draft.name, (v) => (draft.name = v), { placeholder: 'e.g. Raider', className: 'wide' })),
        ...sections,
        h('button.add-section', { type: 'button', onclick: () => { draft.sections.push({ title: '', fields: [] }); renderBuilder(); } }, '+ Section'));
      refresh();
    }

    const form = h('form', {
      onsubmit: async (e: Event) => {
        e.preventDefault();
        let t: SheetTemplateFile;
        try {
          t = mode === 'json' ? JSON.parse(jsonArea.value) : clean(draft);
        } catch {
          return;
        }
        const { $schema: _s, id: _i, ...rest } = t as SheetTemplateFile & { id?: string };
        const ok = existing
          ? await ctx.act({ kind: 'template.update', id: existing.id, template: { ...rest, id: existing.id } })
          : await ctx.act({ kind: 'template.create', template: { ...rest, id: uniqueId(st(), rest.name) } });
        if (ok) {
          dialog.close();
          openLibrary();
        }
      },
    },
      h('div.editor-head', {}, h('h3', {}, existing ? `Edit template: ${existing.name}` : 'New sheet template'), modeBtns),
      h('div.editor-body', {},
        h('div.editor-left', {}, builder, jsonArea, errorsBox),
        h('div.editor-right', {}, h('h4', {}, 'Preview'), previewBox,
          existing && h('p.muted', {}, 'Saving updates every sheet made from this template. Values already filled in are kept.'))),
      h('div.dialog-buttons', {},
        h('button', { type: 'button', onclick: () => download(`${slug(draft.name || 'sheet', 40).replace(/_/g, '-')}.sheet.json`, mode === 'json' ? jsonArea.value : JSON.stringify({ $schema: SCHEMA_URL, ...clean(draft) }, null, 2)) }, 'Export .json'),
        h('button', { type: 'button', onclick: () => { dialog.close(); openLibrary(); } }, 'Cancel'),
        saveBtn),
    );
    jsonArea.hidden = true;
    dialog.append(form);
    document.body.append(dialog);
    for (const b of modeBtns.querySelectorAll<HTMLElement>('button')) b.classList.toggle('active', b.dataset.mode === mode);
    renderBuilder();
    dialog.showModal();
  }

  return { openLibrary };
}
