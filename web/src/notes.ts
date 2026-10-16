// Campaign notes: shared pages for the room (session recaps, NPCs, loose threads) that anyone can
// read and write. One person types in a page at a time: opening its text takes a short editing
// lock that saves renew, and everyone else watches it update live. Search covers every page.
import { NOTE_BODY_MAX, NOTE_TITLE_MAX, type NotePage } from '../../shared/protocol.ts';
import { h, shortId } from './dom';
import type { GameClient } from './game';

export interface NotesCtx {
  me(): string;
  game(): GameClient | null;
}

const SAVE_AFTER_MS = 800; // pause in typing before saving
const RENEW_MS = 10_000; // keep the lock while the text box has focus

function when(iso: string) {
  const d = new Date(iso);
  const today = new Date().toDateString() === d.toDateString();
  return today ? d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

/** Text around the first match, with the match marked. */
function snippet(text: string, q: string) {
  const i = text.toLowerCase().indexOf(q);
  if (i < 0) return null;
  const start = Math.max(0, i - 40);
  const end = Math.min(text.length, i + q.length + 60);
  return h('small.note-snippet', {},
    start > 0 ? '…' : '', text.slice(start, i), h('mark', {}, text.slice(i, i + q.length)), text.slice(i + q.length, end), end < text.length ? '…' : '');
}

export function createNotes(root: HTMLElement, ctx: NotesCtx) {
  const pages = new Map<string, NotePage>();
  let loaded = false;
  let current: string | null = null;
  let query = '';
  let showDeleted = false;

  // Editing state for the open page.
  let editing = false; // we hold the lock
  let dirty = false;
  let saveTimer: ReturnType<typeof setTimeout> | undefined;
  let renewTimer: ReturnType<typeof setInterval> | undefined;

  const now = () => ctx.game()?.serverNow() ?? Date.now();
  const lockedBy = (p: NotePage) => (p.editor && p.editor !== ctx.me() && (p.editorUntil ?? 0) > now() ? p.editor : null);

  // ---- List view ------------------------------------------------------------------------------

  const search = h('input', { type: 'search', placeholder: 'Search notes…', 'aria-label': 'Search notes' });
  search.addEventListener('input', () => {
    query = search.value.trim().toLowerCase();
    paintList();
  });
  const addBtn = h('button', { type: 'button', title: 'New page' }, '+ Page');
  addBtn.addEventListener('click', () => void newPage());
  const list = h('ul.note-list');
  const listView = h('div.notes-list-view', {}, h('div.notes-head', {}, search, addBtn), list);

  function paintList() {
    const all = [...pages.values()].sort((a, b) => b.created.localeCompare(a.created));
    const live = all.filter((p) => !p.deleted);
    const shown = query ? live.filter((p) => p.title.toLowerCase().includes(query) || p.body.toLowerCase().includes(query)) : live;
    const deleted = all.filter((p) => p.deleted);
    list.replaceChildren(...[
      ...shown.map((p) => {
        const busy = lockedBy(p);
        return h('li', {},
          h('button.note-item', { type: 'button', onclick: () => open(p.id, query) },
            h('span.note-title', {}, p.title),
            h('small.muted', {}, busy ? `✎ ${busy} is editing` : `${p.updatedBy}, ${when(p.updated)}`),
            query ? snippet(p.body, query) ?? snippet(p.title, query) : null));
      }),
      !loaded ? h('li.muted', {}, 'Loading…') : null,
      loaded && !shown.length ? h('li.muted', {}, query ? 'Nothing matches.' : 'No pages yet. Start one with + Page: a session recap, the NPCs, loose threads…') : null,
      deleted.length > 0 && !query ? h('li.deleted-toggle', {}, h('button.link-btn', { type: 'button', onclick: () => { showDeleted = !showDeleted; paintList(); } },
        showDeleted ? 'Hide deleted pages' : `Deleted pages (${deleted.length})`)) : null,
      ...(showDeleted && !query ? deleted.map((p) => h('li.deleted', {},
        h('span', {}, p.title),
        h('button', { type: 'button', onclick: () => void save({ id: p.id, deleted: false }) }, 'Restore'))) : []),
    ].filter((n): n is HTMLLIElement => !!n));
  }

  async function newPage() {
    const title = prompt('Page title:', `Session, ${new Date().toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' })}`)?.trim().slice(0, NOTE_TITLE_MAX);
    if (!title) return;
    const page = await save({ id: `pg-${shortId()}`, title, body: '' });
    if (page) open(page.id);
  }

  // ---- Page view ------------------------------------------------------------------------------

  const back = h('button', { type: 'button', title: 'All pages' }, '← Pages');
  const titleInput = h('input.note-title-input', { maxLength: NOTE_TITLE_MAX, 'aria-label': 'Page title' });
  const status = h('small.note-status.muted');
  const body = h('textarea.note-body', { maxLength: NOTE_BODY_MAX, placeholder: 'Write here. Everyone at the table sees it.', spellcheck: true });
  const del = h('button.link-btn', { type: 'button' }, 'Delete page');
  const pageView = h('div.notes-page-view', { hidden: true },
    h('div.notes-head', {}, back, titleInput), status, body, h('div.notes-foot', {}, del));
  root.replaceChildren(listView, pageView);

  function open(id: string, highlight = '') {
    current = id;
    listView.hidden = true;
    pageView.hidden = false;
    paintPage(true);
    if (highlight) {
      // Scroll the first match into view (the box isn't focused, so no editing lock is taken).
      const i = body.value.toLowerCase().indexOf(highlight);
      if (i >= 0) {
        const lines = body.value.slice(0, i).split('\n').length - 1;
        body.scrollTop = Math.max(0, lines * parseFloat(getComputedStyle(body).lineHeight || '18') - 40);
      }
    }
  }

  async function close() {
    if (editing) await stopEditing();
    current = null;
    pageView.hidden = true;
    listView.hidden = false;
    paintList();
  }
  back.addEventListener('click', () => void close());

  /** Fill the page view from the stored page (keeping our own unsaved typing). */
  function paintPage(fresh = false) {
    const p = current ? pages.get(current) : undefined;
    if (!p) return void close();
    if (document.activeElement !== titleInput) titleInput.value = p.title;
    if (fresh || !editing) body.value = p.body;
    const busy = lockedBy(p);
    body.readOnly = !!busy;
    titleInput.readOnly = !!busy;
    pageView.classList.toggle('locked', !!busy);
    if (busy) status.textContent = `✎ ${busy} is editing. You'll see it update as they type.`;
    else if (!editing) status.textContent = `Last edited by ${p.updatedBy}, ${when(p.updated)}.`;
  }

  async function save(change: Parameters<GameClient['saveNote']>[0], lock?: boolean): Promise<NotePage | null> {
    const game = ctx.game();
    if (!game) return null;
    try {
      const page = await game.saveNote(change, lock);
      pages.set(page.id, page);
      return page;
    } catch (e) {
      status.textContent = `Not saved: ${(e as Error).message}`;
      return null;
    }
  }

  async function startEditing() {
    const game = ctx.game();
    if (!current || !game || editing || body.readOnly) return;
    try {
      pages.set(current, await game.lockNote(current, true));
      editing = true;
      status.textContent = 'Editing. Others see your changes as you type.';
      clearInterval(renewTimer);
      renewTimer = setInterval(() => void (dirty ? flush() : game.lockNote(current!, true).catch(() => {})), RENEW_MS);
    } catch (e) {
      status.textContent = (e as Error).message;
      body.blur();
    }
  }

  /** Save unsaved typing on page `id` (the open one unless given: leaving a page may close the
   *  view before the save finishes). */
  async function flush(id = current) {
    clearTimeout(saveTimer);
    if (!id || !dirty) return;
    dirty = false;
    // While editing, saves renew the lock; the last one (on the way out) doesn't re-take it.
    const page = await save({ id, body: body.value }, editing ? true : undefined);
    if (!page) dirty = true; // try again on the next pause or renewal
    else if (editing) status.textContent = 'Saved. Others see your changes as you type.';
  }

  async function stopEditing() {
    if (!editing) return; // blur and "← Pages" both get here
    const id = current; // "← Pages" closes the view while we're still saving
    clearInterval(renewTimer);
    editing = false;
    await flush(id);
    const game = ctx.game();
    if (id && game) {
      try {
        pages.set(id, await game.lockNote(id, false));
      } catch { /* the lock runs out by itself */ }
    }
    if (current) paintPage();
  }

  body.addEventListener('focus', () => void startEditing());
  body.addEventListener('input', () => {
    if (!editing) return;
    dirty = true;
    status.textContent = 'Typing…';
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => void flush(), SAVE_AFTER_MS);
  });
  body.addEventListener('blur', () => void stopEditing());
  titleInput.addEventListener('change', () => {
    const t = titleInput.value.trim();
    if (current && t && t !== pages.get(current)?.title) void save({ id: current, title: t });
  });
  titleInput.addEventListener('keydown', (e) => e.key === 'Enter' && titleInput.blur());
  del.addEventListener('click', async () => {
    const p = current ? pages.get(current) : undefined;
    if (!p || !confirm(`Delete "${p.title}"? It goes to Deleted pages, where anyone can restore it.`)) return;
    if (editing) await stopEditing();
    if (await save({ id: p.id, deleted: true })) void close();
  });

  // Locks run out on their own; re-check so "X is editing" clears.
  setInterval(() => {
    if (!root.isConnected || root.closest('[hidden]')) return;
    if (current) paintPage();
    else paintList();
  }, 5000);

  // ---- From the server ------------------------------------------------------------------------

  function onPages(all: NotePage[]) {
    pages.clear();
    for (const p of all) pages.set(p.id, p);
    loaded = true;
    if (current) paintPage();
    else paintList();
  }

  function onPage(p: NotePage) {
    pages.set(p.id, p);
    if (current === p.id) {
      if (editing && p.editor !== ctx.me()) {
        // Someone took over after our lock ran out (e.g. we were offline).
        editing = false;
        clearInterval(renewTimer);
        status.textContent = `${p.editor} took over editing.`;
      }
      if (p.deleted) return void close();
      paintPage();
    } else if (!current) {
      paintList();
    }
  }

  /** The Notes tab was opened (or we reconnected while it's been used): load every page. */
  function load() {
    ctx.game()?.loadNotes();
    if (!current) paintList();
  }

  function reset() {
    pages.clear();
    loaded = false;
    current = null;
    editing = false;
    dirty = false;
    clearInterval(renewTimer);
    clearTimeout(saveTimer);
    pageView.hidden = true;
    listView.hidden = false;
    search.value = query = '';
    paintList();
  }

  return { load, onPages, onPage, reset, get loaded() { return loaded; } };
}
