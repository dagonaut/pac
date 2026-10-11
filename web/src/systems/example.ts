import type { GameSystem } from './index.ts';

/**
 * A template to copy when writing a system for a real game. Shows the pieces a system can set:
 * starting zones, and the sheet players get (named slots plus fields). Copy this file, rename it,
 * change the values, and add it to the list in index.ts.
 */
export const example: GameSystem = {
  id: 'example',
  name: 'Example',
  description: 'Template: loot deck, market row, sheets with Weapon/Armor/Gear slots and HP.',
  setup: () => [
    { kind: 'zone.create', zone: { id: 'loot', kind: 'deck', label: 'Loot deck' } },
    { kind: 'zone.create', zone: { id: 'market', kind: 'row', label: 'Market' } },
    { kind: 'zone.create', zone: { id: 'table', kind: 'board', label: 'Table' } },
    { kind: 'zone.create', zone: { id: 'discard', kind: 'discard', label: 'Discard' } },
  ],
  sheet: {
    slots: ['Weapon', 'Armor', 'Gear', 'Gear', 'Gear'],
    fields: { HP: '10', Charge: '0' },
  },
};
