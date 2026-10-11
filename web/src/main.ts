import type { AvSession, Participant, VideoTile } from './av';
import { joinChime, type JoinInfo } from './chime-av';

const $ = <T extends HTMLElement>(sel: string) => document.querySelector<T>(sel)!;

const joinView = $<HTMLElement>('#join-view');
const roomView = $<HTMLElement>('#room-view');
const joinForm = $<HTMLFormElement>('#join-form');
const joinError = $<HTMLParagraphElement>('#join-error');
const stage = $<HTMLElement>('#stage');
const log = $<HTMLOListElement>('#log');
const micBtn = $<HTMLButtonElement>('#mic-btn');
const camBtn = $<HTMLButtonElement>('#cam-btn');
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

const fields = joinForm.elements as unknown as Record<'room' | 'name' | 'key' | 'camera', HTMLInputElement>;
fields.room.value = new URLSearchParams(location.search).get('room') ?? prefs.get('room');
fields.name.value = prefs.get('name');
fields.key.value = prefs.get('key');

// ---- Session state ------------------------------------------------------------------------

let session: AvSession | null = null;
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
  stage.dataset.count = String(participants.length);
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

// ---- Log: chat + dice (temporary; moves onto the game-state channel later) ----------------

type LogMessage = { type: 'chat'; text: string } | { type: 'roll'; sides: number; result: number };

function isLogMessage(d: unknown): d is LogMessage {
  const m = d as LogMessage;
  if (m?.type === 'chat') return typeof m.text === 'string';
  if (m?.type === 'roll') return Number.isInteger(m.sides) && Number.isInteger(m.result);
  return false;
}

function addLog(who: string, msg: LogMessage) {
  const li = document.createElement('li');
  const name = document.createElement('b');
  name.textContent = who;
  li.append(name);
  if (msg.type === 'chat') {
    li.append(`: ${msg.text.slice(0, 500)}`);
  } else {
    li.className = 'roll';
    li.append(` rolled d${msg.sides}: `);
    const n = document.createElement('span');
    n.textContent = String(msg.result);
    if (msg.result === msg.sides) n.className = 'max';
    if (msg.result === 1) n.className = 'min';
    li.append(n);
  }
  log.append(li);
  log.scrollTop = log.scrollHeight;
}

function sendLog(msg: LogMessage) {
  if (!session) return;
  session.send(msg);
  addLog(session.selfName, msg); // data messages aren't echoed to the sender
}

function roll(sides: number) {
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  return (buf[0] % sides) + 1;
}

$('#dice').addEventListener('click', (e) => {
  const sides = Number((e.target as HTMLElement).dataset.sides);
  if (sides) sendLog({ type: 'roll', sides, result: roll(sides) });
});

$<HTMLFormElement>('#chat-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const input = (e.target as HTMLFormElement).elements.namedItem('text') as HTMLInputElement;
  const text = input.value.trim();
  if (text) sendLog({ type: 'chat', text });
  input.value = '';
});

// ---- Devices ------------------------------------------------------------------------------

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
    await session.setCamera(cameraOn ? null : camSelect.value || null);
    cameraOn = !cameraOn && !!camSelect.value;
  } finally {
    camBtn.disabled = false;
    renderControls();
  }
});

$('#leave-btn').addEventListener('click', () => void session?.leave());

$('#copy-link').addEventListener('click', async (e) => {
  const url = `${location.origin}${location.pathname}?room=${encodeURIComponent(fields.room.value.toLowerCase())}`;
  await navigator.clipboard.writeText(url);
  (e.target as HTMLButtonElement).textContent = 'Copied!';
  setTimeout(() => ((e.target as HTMLButtonElement).textContent = 'Copy invite link'), 1500);
});

// ---- Join / leave -------------------------------------------------------------------------

/** Ask for mic (and camera) permission up front so device ids and labels are available. */
async function getPermissions(wantCamera: boolean): Promise<{ camera: boolean }> {
  let stream: MediaStream;
  let camera = wantCamera;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: wantCamera });
  } catch (e) {
    if (!wantCamera) throw e;
    stream = await navigator.mediaDevices.getUserMedia({ audio: true }); // camera blocked or missing
    camera = false;
  }
  stream.getTracks().forEach((t) => t.stop());
  return { camera };
}

function pick(devices: MediaDeviceInfo[], kind: MediaDeviceKind, preferred: string) {
  const ofKind = devices.filter((d) => d.kind === kind);
  return (ofKind.find((d) => d.deviceId === preferred) ?? ofKind[0])?.deviceId;
}

/** getUserMedia failures look alike to players; say which one it was. */
function micError(e: Error) {
  switch (e.name) {
    case 'NotAllowedError':
      return 'Microphone blocked. Allow it with the icon left of the address bar (and check your OS privacy settings), then try again.';
    case 'NotFoundError':
      return 'No microphone found. Plug one in or check that your OS sees it.';
    case 'NotReadableError':
      return 'Your microphone is busy or blocked by the OS (another app using it, or OS privacy settings).';
    default:
      return `Couldn't open your microphone (${e.name}: ${e.message}).`;
  }
}

function showError(msg: string) {
  joinError.textContent = msg;
  joinError.hidden = false;
}

joinForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  joinError.hidden = true;
  const submit = joinForm.querySelector('button')!;
  submit.disabled = true;
  try {
    const room = fields.room.value.trim().toLowerCase();
    const name = fields.name.value.trim();
    const key = fields.key.value;

    const perms = await getPermissions(fields.camera.checked).catch((e: Error) => e);
    if (perms instanceof Error) return showError(micError(perms));

    const res = await fetch('/api/join', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ room, name, key }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) return showError(body.error ?? `Join failed (${res.status}).`);

    prefs.set('room', room);
    prefs.set('name', name);
    prefs.set('key', key);

    const devices = await navigator.mediaDevices.enumerateDevices();
    const cameraId = perms.camera ? pick(devices, 'videoinput', prefs.get('cam')) : undefined;

    muted = false;
    cameraOn = !!cameraId;
    session = await joinChime(body as JoinInfo, {
      roster: renderRoster,
      tileUpdated: renderTile,
      tileRemoved: removeTile,
      message: (from, data) => isLogMessage(data) && addLog(from, data),
      ended: (reason) => {
        session = null;
        cards.clear();
        stage.replaceChildren();
        log.replaceChildren();
        roomView.hidden = true;
        joinView.hidden = false;
        if (reason !== 'Left') showError(`Disconnected: ${reason}`);
      },
    }, {
      micId: pick(devices, 'audioinput', prefs.get('mic')),
      cameraId,
      speakerId: pick(devices, 'audiooutput', prefs.get('spk')),
    });

    $('#room-name').textContent = room;
    history.replaceState(null, '', `?room=${encodeURIComponent(room)}`);
    joinView.hidden = true;
    roomView.hidden = false;
    renderControls();
    await refreshDevices();
  } catch (err) {
    console.error(err);
    showError(`Something went wrong: ${(err as Error).message}`);
  } finally {
    submit.disabled = false;
  }
});
