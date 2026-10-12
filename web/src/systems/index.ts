// Game systems ("plugins"). A system is configuration on the generic engine: the zones a new room
// starts with, the sheet players get, and custom action buttons (custom renderers may come later).
// The server never knows which system a room uses. Add a system by writing a module here and
// listing it below.
import type { Op, RoomState } from '../../../shared/model.ts';
import type { SheetTemplateFile } from '../../../shared/sheet.ts';
import { example } from './example.ts';
import { generic } from './generic.ts';

export interface GameSystem {
  id: string;
  name: string;
  description: string;
  /** Ops applied when a room is created (zones, starting decks...). */
  setup(): Op[];
  /** What "Create my sheet" makes when the room has no templates: named card slots and fields. */
  sheet?: { slots?: string[]; fields?: Record<string, string> };
  /** Sheet templates every new room of this system starts with (same JSON as Export/Import). */
  templates?: SheetTemplateFile[];
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

/** Everything a new room starts with: the system's zones plus its sheet templates. */
export function setupOps(system: GameSystem): Op[] {
  const used = new Set<string>();
  const templates = (system.templates ?? []).map((t): Op => {
    let id = `tpl-${t.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'sheet'}`;
    while (used.has(id)) id += '-2';
    used.add(id);
    return { kind: 'template.create', template: { ...t, id } };
  });
  return [...system.setup(), ...templates];
}

export const systemName = (id: string) => systems.find((s) => s.id === id)?.name ?? id;
