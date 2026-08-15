// Fractional odds + points maths for the free greyhound feed.
// Kept dependency-free so it can be imported from the browser or a Netlify Function.

/**
 * Parse fractional odds into a decimal profit multiplier.
 * Accepts "5/2", "11/4", "evs", "evens", "1/1", "2.5" (already decimal profit).
 * Returns null if unparseable.
 */
export function parseOdds(input) {
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
  // Treat a bare number >= 2 as traditional decimal odds, otherwise as a fraction already.
  return dec >= 2 ? dec - 1 : dec;
}

/** Tidy an odds string for display: "5/2", "EVS". */
export function formatOdds(input) {
  const raw = String(input ?? '').trim();
  if (!raw) return '—';
  if (/^(evs|evens|even)$/i.test(raw)) return 'EVS';
  return raw.toUpperCase();
}

/**
 * Points returned by a single settled tip.
 * price: 'advised' | 'sp'
 */
export function tipReturn(tip, price = 'advised') {
  if (!tip || tip.result === 'pending') return 0;
  if (tip.result === 'void') return 0;

  const stake = Number(tip.points) || 0;
  if (tip.result === 'lose') return -stake;

  const odds = parseOdds(price === 'sp' ? tip.oddsSP || tip.oddsAdvised : tip.oddsAdvised);
  if (odds === null) return -stake;
  return stake * odds;
}

/** Aggregate stats across a list of tips. */
export function summarise(tips, price = 'advised') {
  const settled = tips.filter((t) => t.result && t.result !== 'pending' && t.result !== 'void');
  const staked = settled.reduce((sum, t) => sum + (Number(t.points) || 0), 0);
  const profit = settled.reduce((sum, t) => sum + tipReturn(t, price), 0);
  const wins = settled.filter((t) => t.result === 'win').length;

  return {
    bets: settled.length,
    wins,
    losses: settled.length - wins,
    strikeRate: settled.length ? (wins / settled.length) * 100 : 0,
    staked,
    profit,
    roi: staked ? (profit / staked) * 100 : 0,
  };
}

/**
 * Cumulative points running total, oldest first.
 * Returns [{ date, profit, cumulative }] with one entry per settled day.
 */
export function cumulativeByDay(tips, price = 'advised') {
  const byDate = new Map();

  for (const tip of tips) {
    if (!tip.result || tip.result === 'pending') continue;
    const current = byDate.get(tip.date) || 0;
    byDate.set(tip.date, current + tipReturn(tip, price));
  }

  const dates = [...byDate.keys()].sort();
  let running = 0;
  return dates.map((date) => {
    running += byDate.get(date);
    return { date, profit: byDate.get(date), cumulative: running };
  });
}

/**
 * The numbers most tipsters don't publish.
 * Worst drawdown is measured peak-to-trough on the cumulative points curve.
 */
export function transparency(tips, price = 'advised') {
  const settled = tips
    .filter((t) => t.result && t.result !== 'pending' && t.result !== 'void')
    .sort((a, b) => (a.date + (a.time || '')).localeCompare(b.date + (b.time || '')));

  let running = 0;
  let peak = 0;
  let worstDrawdown = 0;
  let losingRun = 0;
  let longestLosingRun = 0;
  let winningRun = 0;
  let longestWinningRun = 0;

  for (const tip of settled) {
    running += tipReturn(tip, price);
    peak = Math.max(peak, running);
    worstDrawdown = Math.max(worstDrawdown, peak - running);

    if (tip.result === 'win') {
      winningRun += 1;
      longestWinningRun = Math.max(longestWinningRun, winningRun);
      losingRun = 0;
    } else {
      losingRun += 1;
      longestLosingRun = Math.max(longestLosingRun, losingRun);
      winningRun = 0;
    }
  }

  const odds = settled
    .map((t) => parseOdds(price === 'sp' ? t.oddsSP || t.oddsAdvised : t.oddsAdvised))
    .filter((o) => o !== null);
  const avgOdds = odds.length ? odds.reduce((a, b) => a + b, 0) / odds.length : 0;

  const winners = settled.filter((t) => t.result === 'win');
  const winnerOdds = winners
    .map((t) => parseOdds(price === 'sp' ? t.oddsSP || t.oddsAdvised : t.oddsAdvised))
    .filter((o) => o !== null);

  return {
    bets: settled.length,
    worstDrawdown,
    longestLosingRun,
    longestWinningRun,
    avgOdds,
    avgWinnerOdds: winnerOdds.length ? winnerOdds.reduce((a, b) => a + b, 0) / winnerOdds.length : 0,
    currentLosingRun: losingRun,
  };
}

/** Render a decimal profit multiplier as the nearest real racing fraction. */
const RACING_FRACTIONS = [
  ['1/5', 0.2], ['2/7', 0.2857], ['1/3', 0.3333], ['4/9', 0.4444], ['1/2', 0.5],
  ['4/7', 0.5714], ['8/13', 0.6154], ['4/6', 0.6667], ['8/11', 0.7273], ['4/5', 0.8],
  ['5/6', 0.8333], ['10/11', 0.9091], ['EVS', 1], ['11/10', 1.1], ['6/5', 1.2],
  ['5/4', 1.25], ['11/8', 1.375], ['6/4', 1.5], ['13/8', 1.625], ['7/4', 1.75],
  ['15/8', 1.875], ['2/1', 2], ['9/4', 2.25], ['5/2', 2.5], ['11/4', 2.75],
  ['3/1', 3], ['10/3', 3.333], ['7/2', 3.5], ['4/1', 4], ['9/2', 4.5],
  ['5/1', 5], ['11/2', 5.5], ['6/1', 6], ['13/2', 6.5], ['7/1', 7],
  ['15/2', 7.5], ['8/1', 8], ['9/1', 9], ['10/1', 10], ['11/1', 11],
  ['12/1', 12], ['14/1', 14], ['16/1', 16], ['20/1', 20], ['25/1', 25],
];

export function oddsAsFraction(mult) {
  if (!mult || mult <= 0) return '—';
  let best = RACING_FRACTIONS[0];
  let bestErr = Infinity;
  for (const entry of RACING_FRACTIONS) {
    const err = Math.abs(entry[1] - mult);
    if (err < bestErr) {
      bestErr = err;
      best = entry;
    }
  }
  return best[0];
}

/** Format a points figure with an explicit sign. */
export function fmtPts(n) {
  const v = Number(n) || 0;
  return `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(2)}`;
}

/** Month label for display: "August 2026". */
export function fmtMonth(iso) {
  const d = new Date(`${iso}-01T12:00:00`);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
}

/** Short UK date for display: "Fri 14 Aug". */
export function fmtDate(iso) {
  const d = new Date(`${iso}T12:00:00`);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
}
