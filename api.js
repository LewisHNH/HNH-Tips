const ENDPOINT = '/api/greyhound-tips';

async function send(method, body, token) {
  const res = await fetch(ENDPOINT, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { 'x-admin-password': token } : {}),
    },
    body: JSON.stringify(body),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

/** Everything the public page needs: days oldest-first, plus group months. */
export async function fetchAll() {
  const res = await fetch(ENDPOINT, { headers: { 'cache-control': 'no-cache' } });
  if (!res.ok) throw new Error('Could not load tips');
  const data = await res.json();
  return { days: data.days || [], months: data.months || [], freeMonths: data.freeMonths || [] };
}

/** All days, oldest first. */
export async function fetchDays() {
  return (await fetchAll()).days;
}

/**
 * Combine live-posted free tips with historical monthly figures.
 * A historical month always wins over live tips for the same month, so
 * backfilled summaries and posted tips can never be double-counted.
 */
export function combineFreeRecord(tips, freeMonths, tipReturnFn) {
  const covered = new Set(freeMonths.map((m) => m.month));

  const liveByMonth = new Map();
  for (const tip of tips) {
    if (!tip.result || tip.result === 'pending') continue;
    const month = (tip.date || '').slice(0, 7);
    if (!month || covered.has(month)) continue;
    liveByMonth.set(month, (liveByMonth.get(month) || 0) + tipReturnFn(tip));
  }

  const rows = [
    ...freeMonths.map((m) => ({ month: m.month, points: Number(m.points) || 0, source: 'history' })),
    ...[...liveByMonth.entries()].map(([month, points]) => ({ month, points, source: 'live' })),
  ].sort((a, b) => a.month.localeCompare(b.month));

  return {
    rows,
    total: rows.reduce((sum, r) => sum + r.points, 0),
    liveTotal: [...liveByMonth.values()].reduce((sum, v) => sum + v, 0),
    historyTotal: freeMonths.reduce((sum, m) => sum + (Number(m.points) || 0), 0),
  };
}

/** Summarise the group's monthly records into a since-launch total. */
export function groupTotals(months) {
  const points = months.reduce((sum, m) => sum + (Number(m.points) || 0), 0);
  const staked = months.reduce((sum, m) => sum + (Number(m.staked) || 0), 0);
  const tips = months.reduce((sum, m) => sum + (Number(m.tips) || 0), 0);
  const winners = months.reduce((sum, m) => sum + (Number(m.winners) || 0), 0);
  return {
    points,
    staked,
    tips,
    winners,
    roi: staked ? (points / staked) * 100 : 0,
    strike: tips ? (winners / tips) * 100 : 0,
    months: months.length,
  };
}

/** Flatten day records into a single tip list, newest first. */
export function flattenTips(days) {
  return days
    .flatMap((day) => (day.tips || []).map((tip) => ({ ...tip, date: day.date })))
    .sort((a, b) => (b.date + (b.time || '')).localeCompare(a.date + (a.time || '')));
}

export const postTip = (tip, token) => send('POST', tip, token);
export const settleTip = (date, tipId, result, oddsSP, token) =>
  send('PATCH', { date, tipId, result, oddsSP }, token);
export const setMembersRow = (date, members, token) => send('PATCH', { date, members }, token);
export const setGroupMonth = (month, token) => send('PUT', { ...month, kind: 'group' }, token);
export const setFreeMonth = (month, token) => send('PUT', { ...month, kind: 'free' }, token);

// There is deliberately no delete. The record is append-only.
