// Client side of the game-state channel: keeps a local copy of the room state in sync with the
// server by applying the ops it broadcasts, with the same engine the server uses.
import { apply } from '../../shared/engine.ts';
import type { LogEntry, Op, RoomState } from '../../shared/model.ts';
import { type ClientMessage, MAX_CLIENT_MESSAGE, type ServerMessage } from '../../shared/protocol.ts';

export interface GameEvents {
  /** Fresh full state (first connect, reconnect, or after a gap). Re-render everything. */
  snapshot(state: RoomState, log: LogEntry[]): void;
  /** One op applied to `state` (already updated). */
  op(entry: LogEntry, state: RoomState): void;
  /** Connection up/down, for a "reconnecting…" banner. */
  status(connected: boolean): void;
  /** Server messages not tied to an op of ours (e.g. session expired). */
  error(message: string): void;
}

const PING_MS = 5 * 60_000; // API Gateway drops idle sockets after 10 minutes

export class GameClient {
  state: RoomState | null = null;
  private ws: WebSocket | null = null;
  private closed = false;
  private retry = 0;
  private ping: ReturnType<typeof setInterval> | undefined;
  private buffered: LogEntry[] = [];
  private pending = new Map<string, { resolve(e: LogEntry): void; reject(err: Error): void }>();
  private chunks = new Map<string, string[]>();

  constructor(private url: string, private token: string, private events: GameEvents) {
    this.connect();
  }

  /** Send an op. Resolves once the server has applied and broadcast it; rejects with its reason. */
  send(op: Op): Promise<LogEntry> {
    const cid = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      if (this.ws?.readyState !== WebSocket.OPEN) return reject(new Error('Not connected; try again in a moment.'));
      const msg = JSON.stringify({ type: 'op', cid, op } satisfies ClientMessage);
      if (new Blob([msg]).size > MAX_CLIENT_MESSAGE) return reject(new Error('That action is too big to send; try fewer cards at once.'));
      this.pending.set(cid, { resolve, reject });
      this.ws.send(msg);
    });
  }

  close() {
    this.closed = true;
    clearInterval(this.ping);
    this.ws?.close();
  }

  private post(msg: ClientMessage) {
    this.ws?.send(JSON.stringify(msg));
  }

  private connect() {
    const ws = new WebSocket(`${this.url}?token=${encodeURIComponent(this.token)}`);
    this.ws = ws;
    ws.onopen = () => {
      this.retry = 0;
      this.post({ type: 'hello' });
      this.ping = setInterval(() => this.post({ type: 'ping' }), PING_MS);
    };
    ws.onmessage = (e) => this.receive(JSON.parse(e.data) as ServerMessage);
    ws.onclose = () => {
      clearInterval(this.ping);
      this.chunks.clear();
      this.events.status(false);
      for (const p of this.pending.values()) p.reject(new Error('Connection lost; try again.'));
      this.pending.clear();
      if (this.closed) return;
      // API Gateway closes sockets after 2 hours, and networks blip: reconnect with backoff.
      // A socket that never opens (rather than one that drops) usually means the session
      // expired (tokens last 12 hours). Say so instead of retrying silently forever.
      if (this.retry === 8) this.events.error('Still cannot reconnect. If this keeps up, leave and rejoin the room.');
      const delay = Math.min(10_000, 500 * 2 ** this.retry++);
      setTimeout(() => !this.closed && this.connect(), delay);
    };
  }

  private receive(msg: ServerMessage) {
    switch (msg.type) {
      case 'chunk': {
        const parts = this.chunks.get(msg.id) ?? new Array<string>(msg.n);
        parts[msg.i] = msg.data;
        this.chunks.set(msg.id, parts);
        if (parts.filter((p) => p !== undefined).length === msg.n) {
          this.chunks.delete(msg.id);
          this.receive(JSON.parse(parts.join('')) as ServerMessage);
        }
        break;
      }
      case 'snapshot': {
        this.state = msg.state;
        this.events.status(true);
        this.events.snapshot(msg.state, msg.log);
        const later = this.buffered.filter((e) => e.seq > msg.state.seq);
        this.buffered = [];
        later.forEach((e) => this.applyEntry(e));
        break;
      }
      case 'op':
        if (!this.state) this.buffered.push(msg.entry);
        else this.applyEntry(msg.entry);
        break;
      case 'error': {
        const p = msg.cid ? this.pending.get(msg.cid) : undefined;
        if (p) {
          this.pending.delete(msg.cid!);
          p.reject(new Error(msg.message));
        } else {
          this.events.error(msg.message);
        }
        break;
      }
    }
  }

  private applyEntry(entry: LogEntry) {
    const state = this.state!;
    if (entry.seq <= state.seq) return; // already have it
    if (entry.seq !== state.seq + 1) return this.resync(); // missed something
    try {
      apply(state, entry.op);
      state.seq = entry.seq;
    } catch (e) {
      console.error('Op failed locally; resyncing', e, entry);
      return this.resync();
    }
    this.events.op(entry, state);
    const p = entry.cid ? this.pending.get(entry.cid) : undefined;
    if (p) {
      this.pending.delete(entry.cid!);
      p.resolve(entry);
    }
  }

  private resync() {
    this.state = null;
    this.post({ type: 'hello' });
  }
}
