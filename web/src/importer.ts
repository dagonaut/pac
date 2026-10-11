// Bulk card import: images go straight to S3 (presigned POSTs), then one batch of ops creates a
// card definition and a piece for each image. Card names come from the file names.
import { newPiece } from '../../shared/engine.ts';
import type { Op, RoomState, ZoneKind } from '../../shared/model.ts';
import { h, shortId } from './dom';

export interface ImportCtx {
  token(): string;
  state(): RoomState | null;
  act(op: Op): Promise<boolean>;
}

const TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/avif'];
const URL_CHUNK = 50; // files per /api/assets request
const CARDS_PER_BATCH = 40; // ~400 bytes per card: keeps each batch under the 32 KB WebSocket frame limit
const PARALLEL_UPLOADS = 6;

interface Upload {
  url: string;
  fields: Record<string, string>;
  path: string;
}

async function uploadUrls(token: string, files: File[]): Promise<Upload[]> {
  const out: Upload[] = [];
  for (let i = 0; i < files.length; i += URL_CHUNK) {
    const chunk = files.slice(i, i + URL_CHUNK);
    const res = await fetch('/api/assets', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token, files: chunk.map((f) => ({ name: f.name, type: f.type, size: f.size })) }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error ?? `Upload request failed (${res.status}).`);
    out.push(...data.uploads);
  }
  return out;
}

async function uploadOne(file: File, u: Upload) {
  const form = new FormData();
  for (const [k, v] of Object.entries(u.fields)) form.append(k, v);
  form.append('file', file);
  const res = await fetch(u.url, { method: 'POST', body: form });
  if (!res.ok) throw new Error(`Uploading ${file.name} failed (${res.status}).`);
}

/** "S-01 Laser Rifle.png" -> "S-01 Laser Rifle" */
const cardNameFrom = (file: File) => file.name.replace(/\.[^.]+$/, '').replace(/[_]+/g, ' ').trim().slice(0, 120) || 'Card';

export function createImporter(ctx: ImportCtx) {
  return function open(zoneId?: string) {
    const state = ctx.state();
    if (!state) return;

    const files = h('input', { type: 'file', multiple: true, accept: TYPES.join(',') });
    const folder = h('input', { type: 'file', multiple: true });
    folder.setAttribute('webkitdirectory', '');
    const back = h('input', { type: 'file', accept: TYPES.join(',') });
    const targets = Object.values(state.zones).filter((z) => z.kind !== 'discard');
    const target = h('select', {},
      ...targets.map((z) => new Option(z.owner ? `${z.owner}: ${z.label}` : z.label, z.id, false, z.id === zoneId)),
      new Option('New deck…', '__new', false, !zoneId && !targets.some((z) => z.kind === 'deck')),
    );
    const deckName = h('input', { placeholder: 'Deck name', maxLength: 80, value: 'Cards' });
    const deckLabel = h('label', {}, 'New deck name ', deckName);
    const summary = h('p.muted', {}, 'No images chosen yet.');
    const progress = h('progress', { max: 1, value: 0, hidden: true });
    const error = h('p.error', { hidden: true });
    const go = h('button', { type: 'submit' }, 'Import');

    let chosen: File[] = [];
    const refresh = () => {
      const all = [...(files.files ?? []), ...(folder.files ?? [])];
      const seen = new Set<string>();
      chosen = all
        .filter((f) => TYPES.includes(f.type))
        .filter((f) => !seen.has(f.name) && seen.add(f.name))
        .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
      const skipped = all.length - chosen.length;
      summary.textContent = chosen.length
        ? `${chosen.length} card${chosen.length === 1 ? '' : 's'}: ${chosen.slice(0, 4).map(cardNameFrom).join(', ')}${chosen.length > 4 ? '…' : ''}${skipped ? ` (${skipped} skipped: not PNG/JPEG/WebP/GIF/AVIF, or duplicate names)` : ''}`
        : 'No images chosen yet.';
      deckLabel.hidden = target.value !== '__new';
    };
    files.addEventListener('change', refresh);
    folder.addEventListener('change', refresh);
    target.addEventListener('change', refresh);

    const form = h('form', {
      onsubmit: async (e: Event) => {
        e.preventDefault();
        if (!chosen.length) return;
        go.disabled = true;
        error.hidden = true;
        progress.hidden = false;
        try {
          await run();
          dialog.close();
        } catch (err) {
          error.textContent = (err as Error).message;
          error.hidden = false;
        } finally {
          go.disabled = false;
        }
      },
    },
      h('h3', {}, 'Import cards'),
      h('p.muted', {}, 'One card per image. Card names come from the file names. PNG, JPEG, WebP, GIF or AVIF, up to 8 MB each.'),
      h('label', {}, 'Images ', files),
      h('label', {}, 'or a whole folder ', folder),
      h('label', {}, 'Card back (optional) ', back),
      h('label', {}, 'Put them in ', target),
      deckLabel,
      summary,
      progress,
      error,
      h('div.dialog-buttons', {}, h('button', { type: 'button', onclick: () => dialog.close() }, 'Cancel'), go),
    );
    const dialog = h('dialog.modal.import', { onclose: () => dialog.remove() }, form);
    document.body.append(dialog);
    refresh();
    dialog.showModal();

    async function run() {
      const backFile = back.files?.[0];
      const all = backFile ? [backFile, ...chosen] : chosen;
      const uploads = await uploadUrls(ctx.token(), all);
      progress.max = all.length;
      let done = 0;
      const queue = all.map((f, i) => [f, uploads[i]] as const);
      await Promise.all(Array.from({ length: PARALLEL_UPLOADS }, async () => {
        for (let next = queue.shift(); next; next = queue.shift()) {
          await uploadOne(next[0], next[1]);
          progress.value = ++done;
        }
      }));
      const backPath = backFile ? uploads[0].path : undefined;
      const fronts = backFile ? uploads.slice(1) : uploads;

      const current = ctx.state()!;
      const ops: Op[] = [];
      let zone = current.zones[target.value];
      if (target.value === '__new') {
        zone = { id: `deck-${shortId()}`, kind: 'deck' as ZoneKind, label: deckName.value.trim() || 'Cards' };
        ops.push({ kind: 'zone.create', zone });
      }
      const start = Object.values(current.pieces).filter((p) => p.zone === zone.id).reduce((m, p) => Math.max(m, p.index + 1), 0);
      const faceUp = zone.kind !== 'deck';
      chosen.forEach((file, i) => {
        const cardId = `card-${shortId()}`;
        ops.push({ kind: 'card.create', card: { id: cardId, name: cardNameFrom(file), front: fronts[i].path, ...(backPath ? { back: backPath } : {}) } });
        const pos = zone.kind === 'board' ? { x: 80 + (i % 10) * 125, y: 80 + Math.floor(i / 10) * 185 } : {};
        ops.push({ kind: 'piece.create', piece: newPiece(`pc-${shortId()}`, cardId, zone.id, { index: start + i, faceUp, ...pos }) });
      });

      // Keep each card's two ops together; the zone (if new) goes in the first batch.
      const head = ops[0]?.kind === 'zone.create' ? 1 : 0;
      for (let i = 0; i < chosen.length; i += CARDS_PER_BATCH) {
        const slice = ops.slice(head + i * 2, head + (i + CARDS_PER_BATCH) * 2);
        const batch = i === 0 && head ? [ops[0], ...slice] : slice;
        if (!(await ctx.act({ kind: 'batch', ops: batch }))) throw new Error('The table rejected the import; see the log.');
      }
    }
  };
}
