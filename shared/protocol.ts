// Messages on the game-state WebSocket.
import type { LogEntry, Op, RoomState } from './model.ts';

export type ClientMessage =
  /** Sent after connecting (and reconnecting): asks for a full snapshot. */
  | { type: 'hello' }
  | { type: 'op'; cid: string; op: Op }
  | { type: 'ping' };

export type ServerMessage =
  /** Full state plus recent log, for joining or catching up after a reconnect. */
  | { type: 'snapshot'; state: RoomState; log: LogEntry[] }
  /** An applied op, broadcast to everyone in the room (including the sender). */
  | { type: 'op'; entry: LogEntry }
  /** Only to the sender, when its op was rejected. */
  | { type: 'error'; cid?: string; message: string }
  | { type: 'pong' };

/** Room summary for the lobby list. */
export interface RoomSummary {
  id: string;
  name: string;
  system: string;
  updated: string;
}

/** Session token contents, signed by the API and checked when the WebSocket connects. */
export interface SessionClaims {
  room: string;
  name: string;
  exp: number;
}
