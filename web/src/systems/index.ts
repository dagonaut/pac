// Game systems ("plugins"). A system is configuration on the generic engine: the zones a new room
// starts with, and later its sheet layout, custom actions and renderers. The server never knows
// which system a room uses. Add a system by writing a module here and listing it below.
import type { Op } from '../../../shared/model.ts';
import { generic } from './generic.ts';

export interface GameSystem {
  id: string;
  name: string;
  description: string;
  /** Ops applied when a room is created (zones, starting decks...). */
  setup(): Op[];
}

export const systems: GameSystem[] = [generic];

export const systemName = (id: string) => systems.find((s) => s.id === id)?.name ?? id;
