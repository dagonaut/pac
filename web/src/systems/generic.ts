import type { GameSystem } from './index.ts';

/** Cards, a board and dice, with nothing system-specific. Configure it at the table. */
export const generic: GameSystem = {
  id: 'generic',
  name: 'Generic',
  description: 'Draw deck, selection row, table and discard. Dice and chat.',
  setup: () => [
    { kind: 'zone.create', zone: { id: 'deck', kind: 'deck', label: 'Draw deck' } },
    { kind: 'zone.create', zone: { id: 'row', kind: 'row', label: 'Selection' } },
    { kind: 'zone.create', zone: { id: 'table', kind: 'board', label: 'Table' } },
    { kind: 'zone.create', zone: { id: 'discard', kind: 'discard', label: 'Discard' } },
  ],
};
