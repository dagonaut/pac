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
  | { type: 'pong' }
  /** Piece `i` of `n` of a message too big for one WebSocket frame (API Gateway caps them at 128 KB).
   *  Join the `data` strings in order and parse the result as a ServerMessage. */
  | { type: 'chunk'; id: string; i: number; n: number; data: string };

/** Characters per chunk. API Gateway limits WebSocket frames to 32 KB, so even all-multi-byte
 *  UTF-8 (3 bytes/char) fits. */
export const CHUNK_CHARS = 10_000;

/** Largest message a client may send (one frame, 32 KB, with some headroom). */
export const MAX_CLIENT_MESSAGE = 30_000;

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
