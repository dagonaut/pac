import type { DiceTerm, RollResult } from './model.ts';

const MAX_DICE = 100;
const MAX_SIDES = 1000;

/**
 * Roll an expression like "d20", "2d6+3" or "1d8 + 1d6 - 1".
 * `rand(n)` returns an integer in [1, n]; pass a crypto-backed one on the server.
 */
export function roll(expr: string, rand: (sides: number) => number): RollResult {
  const src = expr.replace(/\s+/g, '').toLowerCase();
  if (!src || src.length > 60) throw new Error('Roll something like 2d6+3.');
  const parts = src.match(/[+-]?[^+-]+/g);
  if (!parts || parts.join('') !== src) throw new Error(`Can't read "${expr}".`);

  const terms: DiceTerm[] = [];
  let modifier = 0;
  let dice = 0;
  for (const part of parts) {
    const sign = part.startsWith('-') ? -1 : 1;
    const body = part.replace(/^[+-]/, '');
    const m = /^(\d*)d(\d+)$/.exec(body);
    if (m) {
      const count = m[1] ? Number(m[1]) : 1;
      const sides = Number(m[2]);
      if (count < 1 || sides < 2 || sides > MAX_SIDES) throw new Error(`"${body}" isn't a die I can roll.`);
      dice += count;
      if (dice > MAX_DICE) throw new Error(`At most ${MAX_DICE} dice at once.`);
      terms.push({ count, sides, sign, rolls: Array.from({ length: count }, () => rand(sides)) });
    } else if (/^\d{1,6}$/.test(body)) {
      modifier += sign * Number(body);
    } else {
      throw new Error(`Can't read "${part}" in "${expr}".`);
    }
  }
  if (!terms.length) throw new Error('Roll at least one die, e.g. d20.');

  const total = terms.reduce((sum, t) => sum + t.sign * t.rolls.reduce((a, b) => a + b, 0), modifier);
  return { terms, modifier, total };
}

/** "2d6+3" style text for a result, e.g. "2d6 (4, 6) + 3 = 13". */
export function describeRoll(r: RollResult): string {
  const terms = r.terms.map((t, i) => {
    const sign = t.sign < 0 ? '- ' : i ? '+ ' : '';
    return `${sign}${t.count}d${t.sides} (${t.rolls.join(', ')})`;
  });
  if (r.modifier) terms.push(`${r.modifier < 0 ? '-' : '+'} ${Math.abs(r.modifier)}`);
  return `${terms.join(' ')} = ${r.total}`;
}
