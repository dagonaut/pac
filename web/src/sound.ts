// Music and sound effects. The room state says what's playing and when it started (server time);
// every browser plays the file itself and keeps itself in sync. Effects are one-shot ops that play
// on top. Only the GM seat controls sound (the server enforces it); everyone has their own volume.
import { emptyMusic, musicPosition } from '../../shared/engine.ts';
import type { MusicLoop, MusicState, Op, RoomState, SoundDef } from '../../shared/model.ts';
import { h, shortId, toast } from './dom';
import { uploadOne, uploadUrls } from './importer';

export interface SoundCtx {
  me(): string;
  state(): RoomState | null;
  act(op: Op): Promise<boolean>;
  note(msg: string): void;
  token(): string;
  /** Server time (ms), by our clock plus the measured offset. */
  serverNow(): number;
}

const AUDIO_TYPES = ['audio/mpeg', 'audio/mp3', 'audio/ogg', 'audio/mp4', 'audio/x-m4a', 'audio/m4a', 'audio/wav', 'audio/x-wav', 'audio/wave', 'audio/webm', 'audio/aac'];
const PER_BATCH = 40;
const DRIFT_S = 1; // re-seek when we're this far off
const nameFrom = (f: File) => f.name.replace(/\.[^.]+$/, '').replace(/_+/g, ' ').trim().slice(0, 120) || 'Sound';

function pref(k: string, d: number) {
  try {
    const v = localStorage.getItem(`vtt.${k}`);
    return v === null ? d : Number(v);
  } catch {
    return d;
  }
}
function setPref(k: string, v: number) {
  try {
    localStorage.setItem(`vtt.${k}`, String(v));
  } catch { /* ignore */ }
}

// Transport icons as inline SVG: the ⏮ ⏯ ⏭ ⏹ characters are missing from some fonts.
const SVG_NS = 'http://www.w3.org/2000/svg';
const ICONS = {
  prev: 'M4 3h2v10H4zM14 3v10L7 8z',
  play: 'M4 2v12l10-6z',
  pause: 'M3 2h4v12H3zM9 2h4v12H9z',
  next: 'M10 3h2v10h-2zM2 3v10l7-5z',
  stop: 'M3 3h10v10H3z',
};
function icon(name: keyof typeof ICONS) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('width', '14');
  svg.setAttribute('height', '14');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', ICONS[name]);
  path.setAttribute('fill', 'currentColor');
  svg.append(path);
  return svg;
}

const clock = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

export function createSound(header: HTMLElement, ctx: SoundCtx) {
  const st = () => ctx.state();
  const isGm = () => st()?.gm === ctx.me();
  const music = () => st()?.music ?? emptyMusic();
  const sound = (id: string | undefined) => (id ? st()?.sounds?.[id] : undefined);
  const current = () => sound(music().playlist[music().index]);

  let musicVol = pref('musicVol', 0.6);
  let sfxVol = pref('sfxVol', 0.8);

  // ---- Playback -------------------------------------------------------------------------------

  // In the page (hidden) rather than detached, so the music and the effects playing right now can
  // be inspected (devtools, the browser test).
  const audio = h('audio#music-audio', { preload: 'auto', hidden: true });
  const sfxBox = h('div#sfx-audio', { hidden: true });
  document.body.append(audio, sfxBox);
  let blocked = false; // the browser refused to autoplay until the page gets a click

  const unblock = h('button.sound-unblock', { type: 'button', hidden: true, title: 'Your browser held the music back until you click' }, '🔇 Click to hear the music');
  unblock.addEventListener('click', () => {
    blocked = false;
    unblock.hidden = true;
    sync();
  });

  function tryPlay(el: HTMLAudioElement) {
    el.play().catch((e: Error) => {
      if (e.name === 'NotAllowedError') {
        blocked = true;
        unblock.hidden = false;
      }
    });
  }

  /** Where the music should be right now, in the current track. */
  function desired(m: MusicState) {
    let pos = musicPosition(m, ctx.serverNow());
    if (m.loop === 'one' && audio.duration > 0) pos %= audio.duration;
    return pos;
  }

  /** Make our <audio> match the room's music state. */
  function sync() {
    const m = music();
    const track = current();
    audio.volume = Math.min(1, musicVol * m.volume);
    audio.loop = m.loop === 'one';
    if (!track) {
      audio.pause();
      if (audio.getAttribute('src')) audio.removeAttribute('src');
      return;
    }
    if (audio.getAttribute('src') !== track.src) audio.src = track.src;
    const pos = desired(m);
    const seek = () => {
      if (Number.isFinite(audio.duration) && pos >= audio.duration) return; // over; the GM's browser moves on
      if (Math.abs(audio.currentTime - pos) > DRIFT_S) audio.currentTime = pos;
    };
    if (audio.readyState >= 1) seek();
    else audio.addEventListener('loadedmetadata', seek, { once: true });
    if (m.playing && !blocked) {
      if (audio.paused) tryPlay(audio);
    } else {
      audio.pause();
    }
  }

  /** The GM's browser picks what plays next when a track ends. */
  function nextIndex(m: MusicState, step = 1): number | null {
    const n = m.playlist.length;
    if (!n) return null;
    if (m.shuffle && n > 1 && step > 0) {
      let i = m.index;
      while (i === m.index) i = Math.floor(Math.random() * n);
      return i;
    }
    const i = m.index + step;
    if (i >= n || i < 0) return m.loop === 'off' && step > 0 ? null : (i + n) % n;
    return i;
  }

  let advancing = false;
  async function trackEnded() {
    const m = music();
    if (!isGm() || !m.playing || m.loop === 'one' || advancing) return;
    advancing = true;
    const next = nextIndex(m);
    await ctx.act({ kind: 'music', set: next === null ? { playing: false, index: 0, position: 0 } : { index: next, position: 0 } });
    advancing = false;
  }
  audio.addEventListener('ended', () => void trackEnded());

  // Keep in sync (seek if we drifted; the GM's browser also advances if its tab slept past the end).
  setInterval(() => {
    const m = music();
    if (!m.playing || !current()) return;
    if (Number.isFinite(audio.duration) && audio.duration > 0 && m.loop !== 'one' && musicPosition(m, ctx.serverNow()) > audio.duration + 1) {
      void trackEnded();
      return;
    }
    sync();
    if (panel.isConnected && !panel.hidden) paintProgress();
  }, 1000);

  // ---- Effects ------------------------------------------------------------------------------

  const playing = new Set<HTMLAudioElement>();
  function playSfx(id: string | null) {
    if (id === null) {
      for (const a of playing) {
        a.pause();
        a.remove();
      }
      playing.clear();
      return;
    }
    const snd = sound(id);
    if (!snd) return;
    const a = h('audio', { src: snd.src, dataset: { sound: id } });
    a.volume = sfxVol;
    playing.add(a);
    sfxBox.append(a);
    a.addEventListener('ended', () => {
      playing.delete(a);
      a.remove();
    });
    tryPlay(a);
  }

  // ---- Header button and panel ----------------------------------------------------------------

  const nowLabel = h('span.now-playing');
  const btn = h('button#sound-btn', { type: 'button', title: 'Music and sound effects' }, '♪ ', nowLabel);
  const panel = h('div.sound-panel', { hidden: true });
  btn.addEventListener('click', () => {
    panel.hidden = !panel.hidden;
    btn.classList.toggle('active', !panel.hidden);
    if (!panel.hidden) paint();
  });
  header.querySelector('.spacer')!.after(unblock, btn);
  document.body.append(panel);

  const progress = h('div.sound-progress', {}, h('div.sound-progress-bar'));
  const timeLabel = h('small.sound-time');
  progress.addEventListener('click', (e) => {
    if (!isGm() || !(audio.duration > 0)) return;
    const r = progress.getBoundingClientRect();
    void ctx.act({ kind: 'music', set: { position: Math.round(((e.clientX - r.left) / r.width) * audio.duration) } });
  });

  function paintProgress() {
    const m = music();
    const dur = audio.duration > 0 && Number.isFinite(audio.duration) ? audio.duration : 0;
    const pos = current() ? Math.min(desired(m), dur || Infinity) : 0;
    (progress.firstChild as HTMLElement).style.width = dur ? `${(pos / dur) * 100}%` : '0';
    timeLabel.textContent = current() ? `${clock(pos)}${dur ? ` / ${clock(dur)}` : ''}` : '';
  }

  const slider = (label: string, value: number, onChange: (v: number) => void, title = '') => {
    const input = h('input', { type: 'range', min: '0', max: '1', step: '0.05', value: String(value) });
    input.addEventListener('input', () => onChange(Number(input.value)));
    return h('label.sound-slider', { title }, h('span', {}, label), input);
  };

  const music$ = (set: Extract<Op, { kind: 'music' }>['set']) => ctx.act({ kind: 'music', set });

  function upload(kind: 'music' | 'sfx') {
    const input = h('input', { type: 'file', multiple: true, accept: 'audio/*,.mp3,.ogg,.m4a,.wav,.webm,.aac' });
    input.addEventListener('change', async () => {
      const files = [...(input.files ?? [])];
      const bad = files.find((f) => !AUDIO_TYPES.includes(f.type));
      if (bad) return ctx.note(`${bad.name} isn't MP3, OGG, M4A, WAV, WebM or AAC audio.`);
      if (!files.length) return;
      const busy = toast(`Uploading ${files.length} sound${files.length === 1 ? '' : 's'}…`, undefined, 600_000);
      try {
        const ups = await uploadUrls(ctx.token(), files);
        await Promise.all(files.map((f, i) => uploadOne(f, ups[i])));
        const ops: Op[] = files.map((f, i) => ({
          kind: 'sound.create',
          sound: { id: `snd-${shortId()}`, name: nameFrom(f), src: ups[i].path, kind, by: ctx.me() } satisfies SoundDef,
        }));
        // New music goes straight onto the end of the playlist.
        const m = music();
        if (kind === 'music') {
          const ids = ops.map((o) => (o as Extract<Op, { kind: 'sound.create' }>).sound.id);
          ops.push({ kind: 'music', set: { playlist: [...m.playlist, ...ids] } });
        }
        for (let i = 0; i < ops.length; i += PER_BATCH) {
          if (!(await ctx.act({ kind: 'batch', ops: ops.slice(i, i + PER_BATCH) }))) break;
        }
      } catch (e) {
        ctx.note((e as Error).message);
      } finally {
        busy.remove();
      }
    });
    input.click();
  }

  function soundActions(s: SoundDef) {
    const inLobby = st()?.lobby?.music === s.id;
    return h('span.sound-actions', {},
      s.kind === 'music' && h('button', {
        type: 'button',
        className: inLobby ? 'active' : '',
        title: inLobby ? 'Plays in the lobby (click to stop)' : 'Play this in the room\'s lobby, before people join',
        onclick: () => void ctx.act({ kind: 'lobby', set: { music: inLobby ? null : s.id } }),
      }, inLobby ? '★ Lobby' : 'Lobby'),
      h('button', { type: 'button', title: 'Rename', onclick: () => {
        const name = prompt('Name:', s.name)?.trim().slice(0, 120);
        if (name) void ctx.act({ kind: 'sound.update', id: s.id, set: { name } });
      } }, '✎'),
      h('button', { type: 'button', title: s.kind === 'music' ? 'Make it a sound effect' : 'Make it music', onclick: () =>
        void ctx.act({ kind: 'sound.update', id: s.id, set: { kind: s.kind === 'music' ? 'sfx' : 'music' } }) }, s.kind === 'music' ? '→ SFX' : '→ Music'),
      h('button.danger', { type: 'button', title: 'Delete from the library', onclick: () =>
        confirm(`Delete "${s.name}"?`) && void ctx.act({ kind: 'sound.delete', id: s.id }) }, '×'));
  }

  function paint() {
    if (panel.hidden) return;
    const state = st();
    if (!state) return;
    const m = music();
    const gm = isGm();
    const track = current();
    const sounds = Object.values(state.sounds ?? {}).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    const sfx = sounds.filter((s) => s.kind === 'sfx');
    const offList = sounds.filter((s) => s.kind === 'music' && !m.playlist.includes(s.id));

    const yours = h('section', {},
      h('h4', {}, 'Your volume'),
      slider('Music', musicVol, (v) => { musicVol = v; setPref('musicVol', v); sync(); }),
      slider('Effects', sfxVol, (v) => { sfxVol = v; setPref('sfxVol', v); for (const a of playing) a.volume = v; }));

    const transport = gm && h('div.transport', {},
      h('button', { type: 'button', title: 'Previous track', onclick: () => { const i = nextIndex(m, -1); if (i !== null) void music$({ index: i, position: 0 }); } }, icon('prev')),
      h('button.play', { type: 'button', title: m.playing ? 'Pause' : 'Play', disabled: !m.playlist.length, onclick: () => void music$({ playing: !m.playing }) }, icon(m.playing ? 'pause' : 'play')),
      h('button', { type: 'button', title: 'Next track', onclick: () => { const i = nextIndex(m); void music$(i === null ? { index: 0, position: 0, playing: false } : { index: i, position: 0 }); } }, icon('next')),
      h('button', { type: 'button', title: 'Stop (back to the start of the track)', onclick: () => void music$({ playing: false, position: 0 }) }, icon('stop')),
      h('select', { title: 'Repeat', onchange: (e: Event) => void music$({ loop: (e.target as HTMLSelectElement).value as MusicLoop }) },
        ...([['all', 'Repeat playlist'], ['one', 'Repeat track'], ['off', 'No repeat']] as const).map(([v, l]) => new Option(l, v, false, m.loop === v))),
      h('label.check', { title: 'Shuffle' }, h('input', { type: 'checkbox', checked: m.shuffle, onchange: (e: Event) => void music$({ shuffle: (e.target as HTMLInputElement).checked }) }), 'Shuffle'));

    let masterTimer: ReturnType<typeof setTimeout> | undefined;
    const master = gm && slider('Room', m.volume, (v) => {
      // Fades as you drag: everyone hears it (sent at most ~4 times a second).
      audio.volume = Math.min(1, musicVol * v);
      clearTimeout(masterTimer);
      masterTimer = setTimeout(() => void music$({ volume: v }), 250);
    }, 'Music volume for everyone (to fade in and out)');

    const playlist = h('ol.playlist', {}, ...m.playlist.map((id, i) => {
      const s = sound(id);
      return h('li', { className: i === m.index ? 'current' : '' },
        gm ? h('button.track', { type: 'button', title: 'Play this', onclick: () => void music$({ index: i, position: 0, playing: true }) }, s?.name ?? '?') : h('span.track', {}, s?.name ?? '?'),
        gm && h('span.sound-actions', {},
          h('button', { type: 'button', title: 'Move up', disabled: i === 0, onclick: () => { const p = [...m.playlist]; [p[i - 1], p[i]] = [p[i], p[i - 1]]; void music$({ playlist: p }); } }, '↑'),
          h('button', { type: 'button', title: 'Move down', disabled: i === m.playlist.length - 1, onclick: () => { const p = [...m.playlist]; [p[i + 1], p[i]] = [p[i], p[i + 1]]; void music$({ playlist: p }); } }, '↓'),
          h('button', { type: 'button', title: 'Take off the playlist (stays in the library)', onclick: () => void music$({ playlist: m.playlist.filter((_, j) => j !== i) }) }, '−'),
          s && soundActions(s)));
    }));

    const musicSection = h('section', {},
      h('h4', {}, 'Music'),
      h('div.now', {}, h('b', {}, track ? track.name : 'Nothing playing'), timeLabel),
      progress,
      transport, master,
      gm && h('h5', {}, `Playlist (${m.playlist.length})`),
      gm && (m.playlist.length ? playlist : h('p.muted', {}, 'Empty. Upload music, or add tracks from the library below.')),
      gm && offList.length > 0 && h('h5', {}, 'Not in the playlist'),
      gm && offList.length > 0 && h('ul.playlist', {}, ...offList.map((s) => h('li', {},
        h('span.track', {}, s.name),
        h('span.sound-actions', {},
          h('button', { type: 'button', title: 'Add to the playlist', onclick: () => void music$({ playlist: [...m.playlist, s.id] }) }, '+'),
          soundActions(s))))),
      gm && h('button', { type: 'button', onclick: () => upload('music') }, 'Upload music…'));

    const sfxSection = gm && h('section', {},
      h('h4', {}, 'Sound effects'),
      sfx.length
        ? h('div.sfx-board', {}, ...sfx.map((s) => h('div.sfx', {},
          h('button.sfx-play', { type: 'button', title: `Play "${s.name}" for everyone`, onclick: () => void ctx.act({ kind: 'sfx', sound: s.id }) }, s.name),
          soundActions(s))))
        : h('p.muted', {}, 'None yet. Effects play once, on top of the music.'),
      h('div.sfx-buttons', {},
        h('button', { type: 'button', onclick: () => upload('sfx') }, 'Upload effects…'),
        sfx.length > 0 && h('button', { type: 'button', title: 'Stop every effect that is still playing', onclick: () => void ctx.act({ kind: 'sfx', sound: null }) }, 'Stop effects')));

    panel.replaceChildren(...[
      h('div.sound-head', {}, h('h3', {}, 'Sound'), h('button', { type: 'button', title: 'Close', onclick: () => btn.click() }, '×')),
      musicSection, sfxSection, yours,
      !gm && h('p.muted', {}, 'The GM runs the music and effects.'),
    ].filter((n): n is HTMLElement => !!n));
    paintProgress();
  }

  /** Re-sync after every state change (and repaint the panel if it's open). */
  function render(state: RoomState) {
    const track = state.music && sound(state.music.playlist[state.music.index]);
    nowLabel.textContent = track && state.music?.playing ? track.name : track ? `${track.name} (paused)` : 'Sound';
    btn.classList.toggle('playing', !!state.music?.playing && !!track);
    sync();
    // Don't rebuild under a GM who's dragging the room-volume slider.
    if (!(panel.contains(document.activeElement) && (document.activeElement as HTMLInputElement).type === 'range')) paint();
  }

  /** A live op (not one from a snapshot): play effects as they happen. */
  function onOp(op: Op) {
    if (op.kind === 'sfx') playSfx(op.sound);
    else if (op.kind === 'batch') op.ops.forEach(onOp);
  }

  function stop() {
    audio.pause();
    audio.removeAttribute('src');
    playSfx(null);
    panel.hidden = true;
    btn.classList.remove('active');
  }

  return { render, onOp, stop };
}
