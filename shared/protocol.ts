// Messages on the game-state WebSocket.
import type { LogEntry, Op, RoomState } from './model.ts';

export type ClientMessage =
  /** Sent after connecting (and reconnecting): asks for a full snapshot. */
  | { type: 'hello' }
  | { type: 'op'; cid: string; op: Op }
  | { type: 'ping' }
  /** Campaign notes (stored outside the room state): list every page... */
  | { type: 'notes' }
  /** ...create or change one (only while nobody else holds its editing lock; `lock` takes or
   *  renews it), or take/release the lock without changing the page. */
  | { type: 'note.save'; cid: string; page: NoteChange; lock?: boolean }
  | { type: 'note.lock'; cid: string; id: string; lock: boolean };

/** A page of the room's shared notes. */
export interface NotePage {
  id: string;
  title: string;
  body: string;
  created: string;
  createdBy: string;
  updated: string;
  updatedBy: string;
  /** Who is typing in it, until `editorUntil` (server ms). Others can't save meanwhile. */
  editor?: string;
  editorUntil?: number;
  /** In the "Deleted pages" list (restorable). */
  deleted?: boolean;
}

export type NoteChange = Pick<NotePage, 'id'> & Partial<Pick<NotePage, 'title' | 'body' | 'deleted'>>;

export const NOTE_TITLE_MAX = 120;
export const NOTE_BODY_MAX = 20_000;
/** How long an editing lock lasts without being renewed (ms). */
export const NOTE_LOCK_MS = 30_000;

export type ServerMessage =
  /** Full state plus recent log, for joining or catching up after a reconnect. */
  | { type: 'snapshot'; state: RoomState; log: LogEntry[]; now?: number }
  /** An applied op, broadcast to everyone in the room (including the sender). */
  | { type: 'op'; entry: LogEntry }
  /** Only to the sender, when its op was rejected. */
  | { type: 'error'; cid?: string; message: string }
  /** `now`: the server's clock (ms), so browsers can play music in sync. */
  | { type: 'pong'; now?: number }
  /** Every notes page (reply to `notes`). */
  | { type: 'notes'; pages: NotePage[] }
  /** A page that changed (broadcast to the room; `cid` echoes the sender's request). */
  | { type: 'note'; page: NotePage; cid?: string }
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
  /** Hidden from the lobby list (reversible). */
  archived?: boolean;
}

/** Session token contents, signed by the API and checked when the WebSocket connects. */
export interface SessionClaims {
  room: string;
  name: string;
  exp: number;
  /** Player id; absent for guests (table key + typed name). */
  pid?: string;
  /** May take the GM seat (players flagged GM). */
  gm?: boolean;
}

/** A player as everyone sees them. Their sign-in secret never leaves the server except to admins
 *  (as a link) and to the player's own browser. */
export interface PlayerInfo {
  id: string;
  name: string;
  /** #rrggbb, used for their name in the log and their video tile. */
  color: string;
  /** /assets/players/<id>/... image, shown when their camera is off and in the lobby. */
  portrait?: string;
  /** Manages the player list. */
  admin: boolean;
  /** May take the GM seat. */
  gm: boolean;
}

/** Player colors to pick from (a new player gets the next unused one). */
export const PLAYER_COLORS = ['#f4d35e', '#ee6352', '#59cd90', '#3fa7d6', '#b48ead', '#f29e4c', '#e5989b', '#80cbc4'];
