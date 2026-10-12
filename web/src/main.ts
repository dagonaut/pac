import type { RoomState } from '../../shared/model.ts';
import type { RoomSummary } from '../../shared/protocol.ts';
import { archiveRoom, createRoom, joinRoom, listRooms } from './api';
import type { AvSession, Participant, VideoTile } from './av';
import { createBoard } from './board';
import { joinChime } from './chime-av';
import { GameClient } from './game';
import { createImporter, uploadImage } from './importer';
import { addEntry, clearLog, note, resetLog } from './log';
import { cameraError, getPermissions, micError, pick, probeCamera } from './media';
import { systemName, systems } from './systems/index';

const $ = <T extends HTMLElement>(sel: string) => document.querySelector<T>(sel)!;

const lobby = $<HTMLElement>('#lobby');
const roomView = $<HTMLElement>('#room-view');
const whoForm = $<HTMLFormElement>('#who');
const roomsCard = $<HTMLElement>('#rooms');
const roomList = $<HTMLUListElement>('#room-list');
const newRoomForm = $<HTMLFormElement>('#new-room');
const lobbyError = $<HTMLParagraphElement>('#lobby-error');
const stage = $<HTMLElement>('#stage');
const micBtn = $<HTMLButtonElement>('#mic-btn');
const camBtn = $<HTMLButtonElement>('#cam-btn');
const gmBtn = $<HTMLButtonElement>('#gm-btn');
const micSelect = $<HTMLSelectElement>('#mic-select');
const camSelect = $<HTMLSelectElement>('#cam-select');
const spkSelect = $<HTMLSelectElement>('#spk-select');

// ---- Per-browser preferences (convenience only) -------------------------------------------

const prefs = {
  get(k: string) {
    try {
      return localStorage.getItem(`vtt.${k}`) ?? '';
    } catch {
      return '';
    }
  },
  set(k: string, v: string) {
    try {
      localStorage.setItem(`vtt.${k}`, v);
    } catch {
      /* private mode etc. */
    }
  },
};

const who = whoForm.elements as unknown as Record<'name' | 'key' | 'camera', HTMLInputElement>;
who.name.value = prefs.get('name');
who.key.value = prefs.get('key');
const invitedRoom = new URLSearchParams(location.search).get('room');

// ---- Lobby ----------------------------------------------------------------------------------

function showLobbyError(msg: string) {
  lobbyError.textContent = msg;
  lobbyError.hidden = !msg;
}

function ago(iso: string) {
  const mins = Math.round((Date.now() - Date.parse(iso)) / 60_000);
  if (mins < 60) return mins <= 1 ? 'just now' : `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours} h ago`;
  return new Date(iso).toLocaleDateString();
}

let showArchived = false;
let lastRooms: RoomSummary[] = [];

function renderRooms(all: RoomSummary[]) {
  lastRooms = all;
  // Invited room first; archived rooms only on request (or when the invite points at one).
  const rooms = all
    .filter((r) => showArchived || !r.archived || r.id === invitedRoom)
    .sort((a, b) => Number(b.id === invitedRoom) - Number(a.id === invitedRoom));
  const archivedCount = all.filter((r) => r.archived).length;
  roomList.replaceChildren(
    ...rooms.map((r) => {
      const li = document.createElement('li');
      li.classList.toggle('invited', r.id === invitedRoom);
      const info = document.createElement('div');
      const name = document.createElement('strong');
      name.textContent = r.name;
      const meta = document.createElement('small');
      meta.textContent = `${systemName(r.system)} · ${ago(r.updated)}`;
      info.append(name, meta);
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = 'Join';
      btn.addEventListener('click', () => void enterRoom(r.id, btn));
      const archive = document.createElement('button');
      archive.type = 'button';
      archive.className = 'archive-btn';
      archive.textContent = r.archived ? 'Restore' : 'Archive';
      archive.title = r.archived ? 'Show this room in the list again' : 'Hide this room from the list (nothing is deleted)';
      archive.addEventListener('click', async () => {
        archive.disabled = true;
        try {
          await archiveRoom(who.key.value, r.id, !r.archived);
          await loadRooms();
        } catch (e) {
          showLobbyError((e as Error).message);
          archive.disabled = false;
        }
      });
      li.classList.toggle('archived', !!r.archived);
      li.append(info, archive, btn);
      return li;
    }),
  );
  if (!rooms.length) {
    const empty = document.createElement('li');
    empty.className = 'muted';
    empty.textContent = archivedCount ? 'No active rooms.' : 'No rooms yet. Create one below.';
    roomList.append(empty);
  }
  if (archivedCount) {
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'archived-toggle';
    toggle.textContent = showArchived ? 'Hide archived rooms' : `Show archived rooms (${archivedCount})`;
    toggle.addEventListener('click', () => {
      showArchived = !showArchived;
      renderRooms(lastRooms);
    });
    const li = document.createElement('li');
    li.className = 'toggle-row';
    li.append(toggle);
    roomList.append(li);
  }
  const invite = $<HTMLParagraphElement>('#invite');
  invite.hidden = !invitedRoom || rooms.some((r) => r.id === invitedRoom);
  invite.textContent = invitedRoom ? `Couldn't find the room "${invitedRoom}" from your invite link.` : '';
}

async function loadRooms() {
  if (!whoForm.reportValidity()) return;
  showLobbyError('');
  try {
    const { rooms } = await listRooms(who.key.value);
    prefs.set('name', who.name.value.trim());
    prefs.set('key', who.key.value);
    renderRooms(rooms);
    roomsCard.hidden = false;
  } catch (e) {
    roomsCard.hidden = true;
    showLobbyError((e as Error).message);
  }
}

whoForm.addEventListener('submit', (e) => {
  e.preventDefault();
  void loadRooms();
});

const systemSelect = newRoomForm.elements.namedItem('system') as HTMLSelectElement;
systemSelect.replaceChildren(...systems.map((s) => {
  const o = new Option(s.name, s.id);
  o.title = s.description;
  return o;
}));
const systemHint = document.createElement('small');
systemHint.className = 'muted';
const showHint = () => (systemHint.textContent = systems.find((s) => s.id === systemSelect.value)?.description ?? '');
systemSelect.addEventListener('change', showHint);
systemSelect.parentElement!.append(systemHint);
showHint();

newRoomForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const submit = newRoomForm.querySelector('button')!;
  submit.disabled = true;
  try {
    const name = (newRoomForm.elements.namedItem('name') as HTMLInputElement).value.trim();
    const system = systems.find((s) => s.id === systemSelect.value)!;
    const { room } = await createRoom(who.key.value, name, system.id, system.setup());
    newRoomForm.reset();
    await enterRoom(room.id, submit);
  } catch (err) {
    showLobbyError((err as Error).message);
  } finally {
    submit.disabled = false;
  }
});

// Returning players skip straight to the room list.
if (who.name.value && who.key.value) void loadRooms();

// ---- Room: video ----------------------------------------------------------------------------

let session: AvSession | null = null;
let game: GameClient | null = null;
let me = '';
let roomId = '';
let token = '';
let muted = false;
let cameraOn = false;

interface Card {
  el: HTMLElement;
  video: HTMLVideoElement;
  label: HTMLElement;
  tileId: number | null;
}
const cards = new Map<string, Card>();

function card(participantId: string): Card {
  let c = cards.get(participantId);
  if (!c) {
    const el = document.createElement('figure');
    el.className = 'tile';
    const video = document.createElement('video');
    video.autoplay = true;
    video.playsInline = true;
    video.muted = true; // audio comes through the shared <audio> element
    const label = document.createElement('figcaption');
    label.textContent = 'Joining…';
    el.append(video, label);
    stage.append(el);
    c = { el, video, label, tileId: null };
    cards.set(participantId, c);
  }
  return c;
}

function renderRoster(participants: Participant[]) {
  const present = new Set(participants.map((p) => p.id));
  for (const [id, c] of cards) {
    if (!present.has(id)) {
      c.el.remove();
      cards.delete(id);
    }
  }
  for (const p of participants) {
    const c = card(p.id);
    c.label.textContent = p.local ? `${p.name} (you)` : p.name;
    c.el.classList.toggle('local', p.local);
    c.el.classList.toggle('muted', p.muted);
    c.el.classList.toggle('speaking', p.speaking && !p.muted);
  }
}

function renderTile(tile: VideoTile) {
  const c = card(tile.participantId);
  if (c.tileId !== tile.tileId) {
    c.tileId = tile.tileId;
    session?.bindVideo(tile.tileId, c.video);
  }
  c.el.classList.toggle('has-video', tile.active);
}

function removeTile(tileId: number) {
  for (const c of cards.values()) {
    if (c.tileId === tileId) {
      c.tileId = null;
      c.el.classList.remove('has-video');
    }
  }
}

// ---- Room: game state -----------------------------------------------------------------------

function renderState(state: RoomState) {
  $('#room-name').textContent = state.name;
  $('#room-system').textContent = systemName(state.system);
  $('#gm-status').textContent = state.gm ? `GM: ${state.gm}` : 'No GM';
  gmBtn.textContent = state.gm === me ? 'Leave GM seat' : 'Take GM seat';
}

async function act(op: Parameters<GameClient['send']>[0]): Promise<boolean> {
  try {
    if (!game) return false;
    await game.send(op);
    return true;
  } catch (e) {
    note((e as Error).message);
    return false;
  }
}

const board = createBoard($('#board'), {
  me: () => me,
  state: () => game?.state ?? null,
  act,
  note,
  openImport: createImporter({ token: () => token, state: () => game?.state ?? null, act }),
  upload: (file) => uploadImage(token, file),
  live: (data) => session?.send(data),
  token: () => token,
});

$('#dice').addEventListener('click', (e) => {
  const expr = (e.target as HTMLElement).dataset.expr;
  if (expr) void act({ kind: 'roll', expr });
});

$<HTMLFormElement>('#roll-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const input = (e.target as HTMLFormElement).elements.namedItem('expr') as HTMLInputElement;
  if (input.value.trim()) void act({ kind: 'roll', expr: input.value.trim() });
});

$<HTMLFormElement>('#chat-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const input = (e.target as HTMLFormElement).elements.namedItem('text') as HTMLInputElement;
  const text = input.value.trim();
  input.value = '';
  if (text) void act({ kind: 'chat', text });
});

gmBtn.addEventListener('click', () => {
  void act({ kind: 'gm', seat: game?.state?.gm === me ? null : me });
});

$('#undo-btn').addEventListener('click', () => void act({ kind: 'undo' }));

// ---- Chat & dice panel toggle ---------------------------------------------------------------

const sideTab = $<HTMLButtonElement>('#side-tab');
let unread = 0;
function setSide(collapsed: boolean) {
  roomView.classList.toggle('side-collapsed', collapsed);
  sideTab.title = collapsed ? 'Show chat and dice' : 'Hide chat and dice';
  if (!collapsed) unread = 0;
  if (unread) sideTab.dataset.unread = String(unread);
  else delete sideTab.dataset.unread;
  prefs.set('sideCollapsed', collapsed ? '1' : '');
}
sideTab.addEventListener('click', () => setSide(!roomView.classList.contains('side-collapsed')));
setSide(prefs.get('sideCollapsed') === '1');

/** Count chat and rolls from others while the panel is hidden. */
function countUnread(kind: string, by: string) {
  if (!roomView.classList.contains('side-collapsed') || by === me || (kind !== 'chat' && kind !== 'roll')) return;
  unread++;
  sideTab.dataset.unread = String(unread);
}

// ---- Devices --------------------------------------------------------------------------------

function fillSelect(select: HTMLSelectElement, devices: MediaDeviceInfo[], preferred: string) {
  select.replaceChildren(
    ...devices.map((d, i) => new Option(d.label || `Device ${i + 1}`, d.deviceId, false, d.deviceId === preferred)),
  );
  select.hidden = devices.length === 0;
}

async function refreshDevices() {
  if (!session) return;
  const d = await session.devices();
  fillSelect(micSelect, d.audioIn, prefs.get('mic'));
  fillSelect(camSelect, d.videoIn, prefs.get('cam'));
  fillSelect(spkSelect, d.audioOut, prefs.get('spk'));
}

navigator.mediaDevices?.addEventListener('devicechange', () => void refreshDevices());

micSelect.addEventListener('change', async () => {
  prefs.set('mic', micSelect.value);
  await session?.setMicrophone(micSelect.value);
});
camSelect.addEventListener('change', async () => {
  prefs.set('cam', camSelect.value);
  if (cameraOn) await session?.setCamera(camSelect.value);
});
spkSelect.addEventListener('change', async () => {
  prefs.set('spk', spkSelect.value);
  await session?.setSpeaker(spkSelect.value).catch(() => {});
});

function renderControls() {
  micBtn.textContent = muted ? 'Unmute' : 'Mute';
  micBtn.classList.toggle('off', muted);
  camBtn.textContent = cameraOn ? 'Camera off' : 'Camera on';
  camBtn.classList.toggle('off', !cameraOn);
}

micBtn.addEventListener('click', () => {
  muted = !muted;
  session?.setMuted(muted);
  renderControls();
});

camBtn.addEventListener('click', async () => {
  if (!session) return;
  camBtn.disabled = true;
  try {
    if (!cameraOn && !camSelect.value) {
      const err = await probeCamera();
      note(err ? cameraError(err) : 'Camera found. Rejoin to use it (device list was empty when you joined).');
      return;
    }
    await session.setCamera(cameraOn ? null : camSelect.value);
    cameraOn = !cameraOn;
  } catch (err) {
    note(cameraError(err as Error));
  } finally {
    camBtn.disabled = false;
    renderControls();
  }
});

$('#leave-btn').addEventListener('click', () => void session?.leave());

$('#copy-link').addEventListener('click', async (e) => {
  const url = `${location.origin}${location.pathname}?room=${encodeURIComponent(roomId)}`;
  await navigator.clipboard.writeText(url);
  (e.target as HTMLButtonElement).textContent = 'Copied!';
  setTimeout(() => ((e.target as HTMLButtonElement).textContent = 'Copy invite link'), 1500);
});

// ---- Enter / leave --------------------------------------------------------------------------

function leftRoom(reason: string) {
  session = null;
  game?.close();
  game = null;
  cards.clear();
  stage.replaceChildren();
  clearLog();
  roomView.hidden = true;
  lobby.hidden = false;
  history.replaceState(null, '', location.pathname);
  if (reason !== 'Left') showLobbyError(`Disconnected: ${reason}`);
  void loadRooms();
}

async function enterRoom(id: string, button: HTMLButtonElement) {
  if (!whoForm.reportValidity()) return;
  showLobbyError('');
  button.disabled = true;
  try {
    const perms = await getPermissions(who.camera.checked).catch((e: Error) => e);
    if (perms instanceof Error) return showLobbyError(micError(perms));

    const join = await joinRoom(who.key.value, id, who.name.value.trim());
    me = join.name;
    roomId = join.room.id;
    token = join.token;

    const devices = await navigator.mediaDevices.enumerateDevices();
    const cameraId = perms.camera ? pick(devices, 'videoinput', prefs.get('cam')) : undefined;
    muted = false;
    cameraOn = !!cameraId;

    game = new GameClient(join.wsUrl, join.token, {
      snapshot: (state, log) => {
        renderState(state);
        board.render(state);
        resetLog(log, state, me);
      },
      op: (entry, state) => {
        renderState(state);
        board.render(state);
        addEntry(entry, state, me);
        countUnread(entry.op.kind, entry.by);
      },
      status: (connected) => ($('#conn-status').hidden = connected),
      error: (message) => note(message),
    });

    session = await joinChime(join, {
      roster: renderRoster,
      tileUpdated: renderTile,
      tileRemoved: removeTile,
      message: (from, data) => board.onLive(from, data), // live drawing + pings (unsaved)
      ended: leftRoom,
    }, {
      micId: pick(devices, 'audioinput', prefs.get('mic')),
      cameraId,
      speakerId: pick(devices, 'audiooutput', prefs.get('spk')),
    });

    $('#room-name').textContent = join.room.name;
    history.replaceState(null, '', `?room=${encodeURIComponent(roomId)}`);
    lobby.hidden = true;
    roomView.hidden = false;
    renderControls();
    await refreshDevices();
    if (perms.cameraError) note(cameraError(perms.cameraError));
  } catch (err) {
    console.error(err);
    game?.close();
    game = null;
    showLobbyError(`Something went wrong: ${(err as Error).message}`);
  } finally {
    button.disabled = false;
  }
}
