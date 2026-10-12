// The table model shared by the server (Lambda) and the browser. A room is a set of zones
// (deck, row, board, sheet slots, discard...) holding pieces (card instances, later tokens and
// images). Systems/plugins are configuration on top of this; the server never knows which one
// a room uses.

import type { SheetTemplate } from './sheet.ts';

export type ZoneKind = 'deck' | 'row' | 'board' | 'slots' | 'discard' | 'hand';
export type Visibility = 'all' | 'gm' | 'owner';

export interface Zone {
  id: string;
  kind: ZoneKind;
  label: string;
  /** Seat name for per-person zones (sheet slots, hand). */
  owner?: string;
  /** Named slots for a `slots` zone (e.g. Weapon, Armor). A piece's index is its slot number. */
  slots?: string[];
  /** Free-form values shown with the zone, e.g. a sheet's HP or Charge. */
  fields?: Record<string, string>;
  /** Background image for a board zone (an entry in RoomState.images), drawn under everything. */
  map?: { image: string; scale: number };
  /** Sheet template (an entry in RoomState.templates) this slots zone was made from. */
  template?: string;
}

/** A map or handout in the room's image library. */
export interface ImageDef {
  id: string;
  name: string;
  src: string;
  kind: 'map' | 'handout';
  /** Only the GM seat and the uploader see it in the drawer until it's revealed (honor system). */
  hidden: boolean;
  by: string;
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
  /** Size multiplier on the table (images, maps, tokens). Default 1. */
  scale?: number;
}

/** Fields a piece.update may change (everything except identity). */
export type PieceProps = Omit<Piece, 'id' | 'def'>;

/** A freehand line drawn on a board zone, in table coordinates. */
export interface Stroke {
  id: string;
  zone: string;
  color: string;
  width: number;
  /** Flattened [x0, y0, x1, y1, ...], whole pixels. */
  points: number[];
  by: string;
}

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
  /** Drawings on the table. Optional: rooms created before drawing existed don't have it. */
  strokes?: Record<string, Stroke>;
  /** Image library (maps, handouts). Optional for older rooms. */
  images?: Record<string, ImageDef>;
  /** The image currently shown big on everyone's screen. */
  spotlight?: { image: string; by: string } | null;
  /** Character sheet templates. Optional for older rooms. */
  templates?: Record<string, SheetTemplate>;
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
  /** `label` names what was rolled, e.g. "INT" for a click on a sheet stat. */
  | { kind: 'roll'; expr: string; label?: string; result?: RollResult }
  | { kind: 'template.create'; template: SheetTemplate }
  | { kind: 'template.update'; id: string; template: SheetTemplate }
  /** Only for templates no sheet uses. */
  | { kind: 'template.delete'; id: string }
  | { kind: 'gm'; seat: string | null }
  | { kind: 'zone.create'; zone: Zone }
  | { kind: 'zone.delete'; id: string }
  | { kind: 'zone.update'; id: string; set: { label?: string; slots?: string[] } }
  | { kind: 'field.set'; zone: string; key: string; value: string | null }
  | { kind: 'card.create'; card: CardDef }
  | { kind: 'card.update'; id: string; set: Partial<Omit<CardDef, 'id'>> }
  /** Only for cards with no pieces left on the table. */
  | { kind: 'card.delete'; id: string }
  | { kind: 'piece.create'; piece: Piece }
  | { kind: 'piece.delete'; id: string }
  | { kind: 'piece.update'; id: string; set: Partial<PieceProps> }
  /** Draw `count` random pieces from a deck; the server fills in `ids`. */
  | { kind: 'draw'; from: string; to: string; count: number; ids?: string[] }
  | { kind: 'image.create'; image: ImageDef }
  | { kind: 'image.update'; id: string; set: { name?: string; kind?: 'map' | 'handout'; hidden?: boolean } }
  /** Only for images not in use as a map or spotlight. */
  | { kind: 'image.delete'; id: string }
  /** Set (or clear, with null) a board zone's background map. */
  | { kind: 'zone.map'; id: string; map: { image: string; scale: number } | null }
  | { kind: 'spotlight'; spotlight: { image: string; by: string } | null }
  | { kind: 'stroke.add'; stroke: Stroke }
  | { kind: 'stroke.delete'; id: string }
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
  /** Names of face-up, unhidden cards the op touched, as of when it happened (for the log). */
  names?: Record<string, string>;
}

export function emptyRoom(id: string, name: string, system: string): RoomState {
  return { id, name, system, created: new Date().toISOString(), seq: 0, gm: null, zones: {}, pieces: {}, cards: {}, strokes: {}, images: {}, spotlight: null, templates: {} };
}
