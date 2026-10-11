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
  actions: [
    {
      label: 'Refill market',
      title: 'Draw from the loot deck until the market has 4 cards',
      run: ({ state }) => {
        const inMarket = Object.values(state.pieces).filter((p) => p.zone === 'market').length;
        const inDeck = Object.values(state.pieces).filter((p) => p.zone === 'loot').length;
        if (inMarket >= 4) return 'The market already has 4 cards.';
        if (!inDeck) return 'The loot deck is empty.';
        return [{ kind: 'draw', from: 'loot', to: 'market', count: 4 - inMarket }];
      },
    },
    {
      label: 'Untap all',
      title: 'Untap every card on the table and on sheets',
      run: ({ state }) => {
        const tapped = Object.values(state.pieces).filter((p) => p.tapped);
        if (!tapped.length) return 'Nothing is tapped.';
        return tapped.map((p) => ({ kind: 'piece.update', id: p.id, set: { tapped: false } }));
      },
    },
  ],
};
