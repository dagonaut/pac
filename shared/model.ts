// The table model shared by the server (Lambda) and the browser. A room is a set of zones
// (deck, row, board, sheet slots, discard...) holding pieces (card instances, later tokens and
// images). Systems/plugins are configuration on top of this; the server never knows which one
// a room uses.

export type ZoneKind = 'deck' | 'row' | 'board' | 'slots' | 'discard' | 'hand';
export type Visibility = 'all' | 'gm' | 'owner';

export interface Zone {
  id: string;
  kind: ZoneKind;
  label: string;
  /** Seat name for per-person zones (sheet slots, hand). */
  owner?: string;
}

/** Imported card art. `back` falls back to the deck's back; `upgraded` replaces the front. */
export interface CardDef {
  id: string;
  name: string;
  front: string;
  back?: string;
  upgraded?: string;
}

export interface Piece {
  id: string;
  def: string;
  zone: string;
  /** Order within a row/slots/hand zone. */
  index: number;
  /** Position on a board zone. */
  x: number;
  y: number;
  faceUp: boolean;
  tapped: boolean;
  upgraded: boolean;
  counters: Record<string, number>;
  note: string;
  visibleTo: Visibility;
  owner?: string;
}

/** Fields a piece.update may change (everything except identity). */
export type PieceProps = Omit<Piece, 'id' | 'def'>;

export interface RoomState {
  id: string;
  name: string;
  system: string;
  created: string;
  seq: number;
  /** Seat name holding the GM seat, if anyone. */
  gm: string | null;
  zones: Record<string, Zone>;
  pieces: Record<string, Piece>;
  cards: Record<string, CardDef>;
}

export interface DiceTerm {
  count: number;
  sides: number;
  sign: 1 | -1;
  rolls: number[];
}

export interface RollResult {
  terms: DiceTerm[];
  modifier: number;
  total: number;
}

export type Op =
  | { kind: 'chat'; text: string }
  | { kind: 'roll'; expr: string; result?: RollResult }
  | { kind: 'gm'; seat: string | null }
  | { kind: 'zone.create'; zone: Zone }
  | { kind: 'zone.delete'; id: string }
  | { kind: 'card.create'; card: CardDef }
  | { kind: 'piece.create'; piece: Piece }
  | { kind: 'piece.delete'; id: string }
  | { kind: 'piece.update'; id: string; set: Partial<PieceProps> }
  /** Draw `count` random pieces from a deck; the server fills in `ids`. */
  | { kind: 'draw'; from: string; to: string; count: number; ids?: string[] }
  | { kind: 'batch'; ops: Op[] }
  /** Client sends `{kind:'undo'}`; the server fills in which entry and the op that reverses it. */
  | { kind: 'undo'; target?: number; op?: Op };

export interface LogEntry {
  seq: number;
  by: string;
  ts: string;
  op: Op;
  /** Client-chosen id so the sender can match the broadcast to its request. */
  cid?: string;
}

export function emptyRoom(id: string, name: string, system: string): RoomState {
  return { id, name, system, created: new Date().toISOString(), seq: 0, gm: null, zones: {}, pieces: {}, cards: {} };
}
