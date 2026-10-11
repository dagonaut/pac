// Game systems ("plugins"). A system is configuration on the generic engine: the zones a new room
// starts with, the sheet players get, and custom action buttons (custom renderers may come later).
// The server never knows which system a room uses. Add a system by writing a module here and
// listing it below.
import type { Op, RoomState } from '../../../shared/model.ts';
import { example } from './example.ts';
import { generic } from './generic.ts';

export interface GameSystem {
  id: string;
  name: string;
  description: string;
  /** Ops applied when a room is created (zones, starting decks...). */
  setup(): Op[];
  /** What "Create my sheet" makes: named card slots and starting fields. */
  sheet?: { slots?: string[]; fields?: Record<string, string> };
  /** Buttons shown above the table. `run` returns ordinary ops (sent as one batch, so one undo);
   *  return a string instead to show it as a message (e.g. "The market is already full"). */
  actions?: SystemAction[];
}

export interface SystemAction {
  label: string;
  title?: string;
  run(ctx: { state: RoomState; me: string }): Op[] | string;
}

export const systems: GameSystem[] = [generic, example];

export const systemName = (id: string) => systems.find((s) => s.id === id)?.name ?? id;
