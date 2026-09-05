/* Multiples and combination bets.
 *
 * Every bet type here is just a set of accumulator sizes over N selections.
 * A Trixie is "all doubles and trebles from 3"; a Lucky 15 is "all singles,
 * doubles, trebles and fourfolds from 4". So rather than write settlement
 * logic per bet type, we enumerate combinations once and let the registry say
 * which sizes are included.
 *
 * Void legs reduce the bet: the leg is priced at evens-with-no-profit (1.0
 * decimal) and the combination shrinks, which is how bookmakers settle a
 * non-runner in a multiple.
 */

/** Fraction like "5/2", "evs" → decimal profit multiplier (2.5). */
export function parseFraction(input) {
  if (input === null || input === undefined) return null;
  const raw = String(input).trim().toLowerCase();
  if (!raw) return null;
  if (raw === 'evs' || raw === 'evens' || raw === 'even') return 1;
  if (raw.includes('/')) {
    const [n, d] = raw.split('/');
    const num = Number(n);
    const den = Number(d);
    if (!Number.isFinite(num) || !Number.isFinite(den) || den === 0) return null;
    return num / den;
  }
  const dec = Number(raw);
  if (!Number.isFinite(dec) || dec <= 0) return null;
  return dec >= 2 ? dec - 1 : dec;
}

/** Decimal return per unit staked, including the stake. 5/2 → 3.5 */
const toDecimal = (frac) => {
  const f = parseFraction(frac);
  return f === null ? null : f + 1;
};

export const PLACE_FRACTIONS = { '1/2': 0.5, '1/4': 0.25, '1/5': 0.2 };

/**
 * The bet types. `sizes` lists which accumulator sizes are included.
 * `lines` is derived and only used for display.
 */
export const BET_TYPES = {
  single:      { label: 'Single',        legs: 1, sizes: [1] },
  double:      { label: 'Double',        legs: 2, sizes: [2] },
  treble:      { label: 'Treble',        legs: 3, sizes: [3] },
  fourfold:    { label: 'Fourfold',      legs: 4, sizes: [4] },
  fivefold:    { label: 'Fivefold',      legs: 5, sizes: [5] },
  sixfold:     { label: 'Sixfold',       legs: 6, sizes: [6] },
  sevenfold:   { label: 'Sevenfold',     legs: 7, sizes: [7] },
  eightfold:   { label: 'Eightfold',     legs: 8, sizes: [8] },

  trixie:      { label: 'Trixie',        legs: 3, sizes: [2, 3] },
  patent:      { label: 'Patent',        legs: 3, sizes: [1, 2, 3] },
  yankee:      { label: 'Yankee',        legs: 4, sizes: [2, 3, 4] },
  lucky15:     { label: 'Lucky 15',      legs: 4, sizes: [1, 2, 3, 4], lucky: true },
  canadian:    { label: 'Canadian',      legs: 5, sizes: [2, 3, 4, 5] },
  lucky31:     { label: 'Lucky 31',      legs: 5, sizes: [1, 2, 3, 4, 5], lucky: true },
  heinz:       { label: 'Heinz',         legs: 6, sizes: [2, 3, 4, 5, 6] },
  lucky63:     { label: 'Lucky 63',      legs: 6, sizes: [1, 2, 3, 4, 5, 6], lucky: true },
  superheinz:  { label: 'Super Heinz',   legs: 7, sizes: [2, 3, 4, 5, 6, 7] },
  goliath:     { label: 'Goliath',       legs: 8, sizes: [2, 3, 4, 5, 6, 7, 8] },
};

const choose = (n, k) => {
  if (k < 0 || k > n) return 0;
  let r = 1;
  for (let i = 1; i <= k; i += 1) r = (r * (n - k + i)) / i;
  return Math.round(r);
};

/** How many lines a bet type has. Lucky 15 → 15, Trixie → 4. */
export function lineCount(typeKey) {
  const t = BET_TYPES[typeKey];
  if (!t) return 0;
  return t.sizes.reduce((sum, k) => sum + choose(t.legs, k), 0);
}

/** Every index combination of a given size. */
function combinations(indices, size) {
  if (size === 0) return [[]];
  if (size > indices.length) return [];
  const [first, ...rest] = indices;
  return [
    ...combinations(rest, size - 1).map((c) => [first, ...c]),
    ...combinations(rest, size),
  ];
}

/**
 * Settle a multiple.
 *
 * legs: [{ horse, price, sp, result, placeTerms }]
 *   result: 'won' | 'placed' | 'lost' | 'void' | 'pending'
 * opts:
 *   stakePerLine  points on each line (a 1pt Lucky 15 stakes 15 points)
 *   eachWay       doubles the lines — a win pool and a place pool
 *   price         'advised' | 'sp'
 *   bonuses       { allWinnersPct, oneWinnerMultiplier } for Lucky bets
 *
 * Returns points staked, points returned, and profit.
 */
export function settleMultiple(typeKey, legs, opts = {}) {
  const type = BET_TYPES[typeKey];
  if (!type) return { error: `Unknown bet type: ${typeKey}` };
  if (legs.length !== type.legs) {
    return { error: `${type.label} needs ${type.legs} selections, got ${legs.length}` };
  }

  const stakePerLine = Number(opts.stakePerLine) || 0;
  const eachWay = !!opts.eachWay;
  const usingSP = opts.price === 'sp';
  const lines = lineCount(typeKey);
  const staked = stakePerLine * lines * (eachWay ? 2 : 1);

  if (legs.some((l) => !l.result || l.result === 'pending')) {
    return { pending: true, lines, staked, returned: 0, profit: 0 };
  }

  const idx = legs.map((_, i) => i);

  // Win part: a leg wins, voids (priced 1.0), or kills the line.
  const winMultiplier = (i) => {
    const l = legs[i];
    if (l.result === 'void') return 1;
    if (l.result !== 'won') return 0;
    const dec = toDecimal(usingSP && l.sp ? l.sp : l.price);
    return dec === null ? 0 : dec;
  };

  // Place part: a placed or winning leg returns at the place fraction.
  const placeMultiplier = (i) => {
    const l = legs[i];
    if (l.result === 'void') return 1;
    if (l.result !== 'won' && l.result !== 'placed') return 0;
    const f = parseFraction(usingSP && l.sp ? l.sp : l.price);
    if (f === null) return 0;
    const frac = PLACE_FRACTIONS[l.placeTerms] ?? 0.2;
    return f * frac + 1;
  };

  const poolReturn = (multiplier) => {
    let total = 0;
    for (const size of type.sizes) {
      for (const combo of combinations(idx, size)) {
        const line = combo.reduce((acc, i) => acc * multiplier(i), 1);
        total += line * stakePerLine;
      }
    }
    return total;
  };

  let returned = poolReturn(winMultiplier);
  if (eachWay) returned += poolReturn(placeMultiplier);

  // Lucky bet bonuses. These vary between bookmakers, so they're opt-in and
  // the figures are passed in rather than assumed.
  const bonuses = opts.bonuses || {};
  const settledLegs = legs.filter((l) => l.result !== 'void');
  const winners = settledLegs.filter((l) => l.result === 'won').length;

  let bonus = 0;
  if (type.lucky && settledLegs.length > 0) {
    if (winners === settledLegs.length && bonuses.allWinnersPct) {
      bonus = returned * (Number(bonuses.allWinnersPct) / 100);
    } else if (winners === 1 && bonuses.oneWinnerMultiplier) {
      // Consolation: the single winning line pays at a multiple of its odds.
      const i = legs.findIndex((l) => l.result === 'won');
      const dec = toDecimal(usingSP && legs[i].sp ? legs[i].sp : legs[i].price);
      if (dec !== null) {
        const normal = dec * stakePerLine;
        bonus = normal * (Number(bonuses.oneWinnerMultiplier) - 1);
      }
    }
  }

  returned += bonus;

  return {
    lines,
    staked: Number(staked.toFixed(2)),
    returned: Number(returned.toFixed(2)),
    bonus: Number(bonus.toFixed(2)),
    profit: Number((returned - staked).toFixed(2)),
    winners,
    voids: legs.length - settledLegs.length,
  };
}

/** One-line description for the admin and the card. */
export function describeBet(typeKey, stakePerLine, eachWay) {
  const t = BET_TYPES[typeKey];
  if (!t) return '';
  const n = lineCount(typeKey);
  const total = stakePerLine * n * (eachWay ? 2 : 1);
  return `${stakePerLine}pt ${t.label}${eachWay ? ' e/w' : ''} · ${n} line${n === 1 ? '' : 's'} · ${total}pt total`;
}
