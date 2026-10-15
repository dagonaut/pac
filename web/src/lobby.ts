// A room's lobby: the screen between the room list and the table. The room's background image and
// music set the mood, you can see who's already at the table and who else is waiting, check your
// camera, and then join. The GM picks the image (Images drawer) and music (Sound panel).
import type { PlayerInfo } from '../../shared/protocol.ts';
import { type Auth, type LobbyInfo, lobbyInfo } from './api';
import { h } from './dom';
import { cameraError } from './media';
import { face } from './players';
import { systemName } from './systems/index';

export interface LobbyCtx {
  auth(): Auth;
  /** Guest name (players are known from their link). */
  guestName(): string | undefined;
  players(): Promise<Map<string, PlayerInfo>>;
  camera: HTMLInputElement;
  /** Join the table; resolves false (with the error shown) if that failed. */
  join(room: string, button: HTMLButtonElement): Promise<boolean>;
  /** Back to the room list. */
  back(): void;
}

const POLL_MS = 5000;

function musicVolume() {
  try {
    const v = localStorage.getItem('vtt.musicVol');
    return v === null ? 0.6 : Number(v);
  } catch {
    return 0.6;
  }
}

export function createLobby(root: HTMLElement, ctx: LobbyCtx) {
  const bg = h('div.lobby-bg');
  const title = h('h1');
  const sub = h('p.muted');
  const here = h('div.faces');
  const waiting = h('div.faces');
  const error = h('p.error', { hidden: true });
  const video = h('video.lobby-preview', { autoplay: true, muted: true, playsInline: true });
  const noCam = h('div.lobby-preview.no-cam', {}, 'Camera off');
  const nowPlaying = h('span.muted');
  const audio = h('audio', { loop: true, preload: 'auto' });
  let muted = false;
  const muteBtn = h('button', { type: 'button', title: 'Mute the lobby music (just for you)' }, '♪ On');
  const joinBtn = h('button.primary', { type: 'button' }, 'Join table');
  const backBtn = h('button', { type: 'button' }, 'Back to rooms');
  // Mirrors the room list's "Camera on" box (which is what joining uses).
  const camBox = h('input', { type: 'checkbox' });
  const camLabel = h('label.check', {}, camBox, ' Camera on');
  const musicRow = h('div.lobby-music', {}, muteBtn, nowPlaying);

  audio.hidden = true;
  root.replaceChildren(bg, audio, h('div.lobby-card', {},
    title, sub,
    h('div.lobby-cols', {},
      h('div.lobby-people', {},
        h('h3', {}, 'At the table'), here,
        h('h3', {}, 'Waiting here'), waiting),
      h('div.lobby-self', {}, video, noCam, camLabel)),
    musicRow,
    error,
    h('div.lobby-buttons', {}, backBtn, joinBtn)));

  let room = '';
  let timer: ReturnType<typeof setInterval> | undefined;
  let stream: MediaStream | null = null;
  let players = new Map<string, PlayerInfo>();

  const people = (el: HTMLElement, names: string[], empty: string) =>
    el.replaceChildren(...(names.length
      ? names.map((n) => h('figure.person', {}, face(players.get(n), n), h('figcaption', {}, players.has(n) ? n : `${n} (guest)`)))
      : [h('p.muted', {}, empty)]));

  function paint(info: LobbyInfo) {
    title.textContent = info.room.name;
    sub.textContent = `${systemName(info.room.system)}${info.gm ? ` · GM: ${info.gm}` : ''}`;
    bg.style.backgroundImage = info.background ? `url("${info.background.src}")` : '';
    root.classList.toggle('has-bg', !!info.background);
    people(here, info.here, 'Nobody yet.');
    people(waiting, info.waiting, 'Just you.');
    musicRow.hidden = !info.music;
    if (info.music) {
      nowPlaying.textContent = info.music.name;
      if (audio.getAttribute('src') !== info.music.src) {
        audio.src = info.music.src;
        if (!muted) audio.play().catch(() => { /* blocked until a click; the button retries */ });
      }
    } else {
      audio.pause();
      audio.removeAttribute('src');
    }
    audio.volume = musicVolume();
  }

  async function poll() {
    try {
      paint(await lobbyInfo(ctx.auth(), room, ctx.guestName()));
      error.hidden = true;
    } catch (e) {
      showError((e as Error).message);
    }
  }

  function showError(msg: string) {
    error.textContent = msg;
    error.hidden = !msg;
  }

  async function preview() {
    stopPreview();
    noCam.hidden = false;
    video.hidden = true;
    if (!camBox.checked) return;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: true });
      video.srcObject = stream;
      video.hidden = false;
      noCam.hidden = true;
    } catch (e) {
      noCam.textContent = cameraError(e as Error);
    }
  }

  function stopPreview() {
    stream?.getTracks().forEach((t) => t.stop());
    stream = null;
    video.srcObject = null;
  }

  camBox.addEventListener('change', () => {
    ctx.camera.checked = camBox.checked;
    void preview();
  });

  muteBtn.addEventListener('click', () => {
    muted = !muted;
    muteBtn.textContent = muted ? '♪ Off' : '♪ On';
    if (muted) audio.pause();
    else void audio.play().catch(() => {});
  });

  /** Leave the lobby screen (for the table or the room list): no longer waiting. */
  function close() {
    clearInterval(timer);
    stopPreview();
    audio.pause();
    root.hidden = true;
    if (room) void lobbyInfo(ctx.auth(), room, ctx.guestName(), true).catch(() => {});
  }

  backBtn.addEventListener('click', () => {
    close();
    ctx.back();
  });

  joinBtn.addEventListener('click', async () => {
    // Hand the camera over to the call, and the music over to the room's own.
    stopPreview();
    audio.pause();
    clearInterval(timer);
    if (await ctx.join(room, joinBtn)) close();
    else {
      void preview();
      if (!muted && audio.getAttribute('src')) void audio.play().catch(() => {});
      timer = setInterval(() => void poll(), POLL_MS);
    }
  });

  async function open(id: string) {
    room = id;
    showError('');
    title.textContent = 'Loading…';
    sub.textContent = '';
    here.replaceChildren();
    waiting.replaceChildren();
    root.hidden = false;
    camBox.checked = ctx.camera.checked;
    players = await ctx.players();
    await poll();
    void preview();
    clearInterval(timer);
    timer = setInterval(() => void poll(), POLL_MS);
  }

  return { open, close, showError };
}
