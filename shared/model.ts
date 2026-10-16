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
  map?: MapPlacement;
  /** Sheet template (an entry in RoomState.templates) this slots zone was made from. */
  template?: string;
}

/** A board's background map: which image, its size, and where its top-left corner sits on the
 *  table (x/y default to 0 for maps set before placement existed). */
export interface MapPlacement {
  image: string;
  scale: number;
  x?: number;
  y?: number;
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
  /** Pinned in place: it can't be moved (or sent elsewhere) until unlocked. Default false. */
  locked?: boolean;
}

/** Fields a piece.update may change (everything except identity). */
export type PieceProps = Omit<Piece, 'id' | 'def'>;

export type StrokeShape = 'path' | 'line' | 'arrow' | 'rect' | 'ellipse' | 'text';

/** A drawing on a board zone, in table coordinates: a freehand line, a shape or a text label. */
export interface Stroke {
  id: string;
  zone: string;
  color: string;
  /** Line width; for text, the size step (font size is derived from it). */
  width: number;
  /** Flattened, whole pixels. path: [x0, y0, x1, y1, ...]; line/arrow: start and end; rect/ellipse:
   *  two opposite corners; text: its top-left corner. */
  points: number[];
  by: string;
  /** Default 'path' (freehand; also what every stroke drawn before shapes existed is). */
  shape?: StrokeShape;
  /** rect/ellipse: filled (translucent) instead of outlined. */
  fill?: boolean;
  /** text: the words (may contain line breaks). */
  text?: string;
}

/** A GM's ordered set of images to show one after another (e.g. a session recap). */
export interface Slideshow {
  id: string;
  name: string;
  /** Image ids, in order. */
  images: string[];
}

/** An audio file in the room's sound library. */
export interface SoundDef {
  id: string;
  name: string;
  /** /assets/<room>/<uuid>.<mp3|ogg|m4a|wav|webm|aac> */
  src: string;
  /** Music goes in the playlist; sfx are one-shots on the soundboard. */
  kind: 'music' | 'sfx';
  by: string;
}

export type MusicLoop = 'all' | 'one' | 'off';

/** What the room's music is doing. Every browser plays the file itself, in sync: while playing,
 *  the track started at server time `startedAt` (ms); while paused, it sits at `position` (s). */
export interface MusicState {
  playlist: string[];
  index: number;
  playing: boolean;
  startedAt: number;
  position: number;
  /** Playlist repeat (all), track repeat (one), or stop at the end (off). */
  loop: MusicLoop;
  shuffle: boolean;
  /** GM's master volume, 0..1 (for fades); each listener also has their own. */
  volume: number;
}

export interface Spotlight {
  image: string;
  by: string;
  /** Presenting slide `index` of slideshow `show`. */
  show?: string;
  index?: number;
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
  /** The image currently shown big on everyone's screen; `show`/`index` when it's a slide. */
  spotlight?: Spotlight | null;
  slideshows?: Record<string, Slideshow>;
  /** Character sheet templates. Optional for older rooms. */
  templates?: Record<string, SheetTemplate>;
  /** Counter name -> color, shared by every piece in the room (so "poison" always looks the same). */
  counterColors?: Record<string, string>;
  /** Sound library (music and effects). Optional for older rooms. */
  sounds?: Record<string, SoundDef>;
  music?: MusicState;
  /** The pre-join screen: a background image (from `images`) and looping music (from `sounds`). */
  lobby?: { image?: string; music?: string };
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
  | { kind: 'room.rename'; name: string }
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
  | { kind: 'zone.map'; id: string; map: MapPlacement | null }
  | { kind: 'spotlight'; spotlight: Spotlight | null }
  | { kind: 'slideshow.create'; show: Slideshow }
  | { kind: 'slideshow.update'; id: string; set: { name?: string; images?: string[] } }
  | { kind: 'slideshow.delete'; id: string }
  /** Set (or clear, with null) the color for a counter name, room-wide. */
  | { kind: 'counter.color'; name: string; color: string | null }
  | { kind: 'stroke.add'; stroke: Stroke }
  | { kind: 'stroke.delete'; id: string }
  /** Move a drawing (new points) or change a text label's words. */
  | { kind: 'stroke.update'; id: string; set: { points?: number[]; text?: string } }
  | { kind: 'sound.create'; sound: SoundDef }
  | { kind: 'sound.update'; id: string; set: { name?: string; kind?: 'music' | 'sfx' } }
  /** Also drops it from the playlist. */
  | { kind: 'sound.delete'; id: string }
  /** Change the music. The server stamps `at` (its clock, ms) so everyone agrees when a track
   *  started; `position` (s) seeks, and changing `index` starts that track from the top. */
  | { kind: 'music'; set: { playlist?: string[]; index?: number; playing?: boolean; position?: number; loop?: MusicLoop; shuffle?: boolean; volume?: number }; at?: number }
  /** Set (or clear, with null) the lobby's background image and music. */
  | { kind: 'lobby'; set: { image?: string | null; music?: string | null } }
  /** Play a sound effect once on everyone's speakers (`sound: null` stops all effects). */
  | { kind: 'sfx'; sound: string | null }
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
  return { id, name, system, created: new Date().toISOString(), seq: 0, gm: null, zones: {}, pieces: {}, cards: {}, strokes: {}, images: {}, spotlight: null, templates: {}, counterColors: {} };
}
