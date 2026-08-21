// netlify/functions/brief.js
// The morning brief. Scheduled in netlify.toml at "45 5,6 * * *" (UTC),
// with a guard below so it only actually fires at 06:45 UK time. That way
// it self-corrects when the clocks change instead of drifting an hour.
//
// Manual test: GET /.netlify/functions/brief?force=1&pw=YOUR_ADMIN_PASSWORD

const events = require('./lib/events');
const { tipMetrics, memberMetrics, contentPipeline, toDecimal } = require('./lib/metrics');
const { sendMessage, esc } = require('./lib/telegram');
const { tasksForDate, fixtureFor } = require('./config/content-rules');

function fmtPts(n) {
  if (n == null) return '—';
  const s = n > 0 ? '+' : '';
  return `${s}${n.toFixed(2)} pts`;
}

function dowFor(isoDate) {
  return new Date(`${isoDate}T12:00:00Z`).getUTCDay();
}

function prettyDate(isoDate) {
  return new Intl.DateTimeFormat('en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  }).format(new Date(`${isoDate}T12:00:00Z`));
}

function sportBlock(label, m) {
  if (!m.bets) return `${label}: no bets settled`;
  const gap =
    m.advisedVsSpGap != null
      ? ` (SP ${fmtPts(m.profitSP)}, gap ${fmtPts(m.advisedVsSpGap)})`
      : '';
  return `${label}: ${m.wins}/${m.bets} · ${m.strikeRate}% · ${fmtPts(m.profit)}${gap}`;
}

async function buildBrief() {
  const today = events.ukDate();
  const yesterday = events.addDays(today, -1);

  const yEvents = await events.readDay(yesterday);
  const monthStart = `${today.slice(0, 7)}-01`;
  const monthEvents = await events.range(monthStart, yesterday);
  const recentEvents = await events.lastNDays(14, today);

  const yHorses = tipMetrics(yEvents, { sport: 'horses' });
  const yGrey = tipMetrics(yEvents, { sport: 'greyhounds' });
  const mHorses = tipMetrics(monthEvents, { sport: 'horses' });
  const mGrey = tipMetrics(monthEvents, { sport: 'greyhounds' });
  const members = memberMetrics(monthEvents);
  const pipeline = contentPipeline(recentEvents);

  const bigWinners = yEvents
    .filter((e) => e.type === 'tip.settled' && e.payload.result === 'win')
    .filter((e) => (toDecimal(e.payload.advisedPrice) || 0) >= 9)
    .map((e) => e.payload);

  const tasks = tasksForDate(today, { dow: dowFor(today), bigWinners });
  const fixture = fixtureFor(today);

  // -------------------------------------------------------------------------
  // Compose. Everything numeric above is computed, never generated.
  // -------------------------------------------------------------------------
  const L = [];
  L.push(`<b>HNH BRIEF — ${esc(prettyDate(today))}</b>`);
  if (fixture) L.push(`<i>${esc(fixture.name)}</i>`);
  L.push('');

  L.push('<b>Yesterday</b>');
  L.push(esc(sportBlock('Horses', yHorses)));
  L.push(esc(sportBlock('Greys', yGrey)));
  L.push('');

  L.push('<b>Month to date</b>');
  L.push(esc(`Horses ${fmtPts(mHorses.profit)} · ROI ${mHorses.roi}%`));
  L.push(esc(`Greys  ${fmtPts(mGrey.profit)} · ROI ${mGrey.roi}%`));
  if (mGrey.advisedVsSpGap != null) {
    L.push(esc(`Advised beat SP by ${fmtPts(mGrey.advisedVsSpGap)} on greys`));
  }
  L.push(esc(`Subs ${members.netSubs >= 0 ? '+' : ''}${members.netSubs} · members ${members.netMembers >= 0 ? '+' : ''}${members.netMembers}`));
  L.push('');

  L.push('<b>Today</b>');
  if (!tasks.length) {
    L.push('Nothing scheduled.');
  } else {
    for (const t of tasks) {
      const when = t.postAt ? `${t.postAt}` : 'anytime';
      const film = t.filmBy ? ` · film by ${t.filmBy}` : '';
      L.push(esc(`${when} ${t.platform || ''} — ${t.title}${film}`));
      if (t.note) L.push(`  <i>${esc(t.note)}</i>`);
    }
  }

  // -------------------------------------------------------------------------
  // The nag. Three lines max or you stop reading it.
  // -------------------------------------------------------------------------
  const nags = [];
  if (pipeline.unfilmed.length) {
    nags.push(`${pipeline.unfilmed.length} planned, not filmed`);
  }
  if (pipeline.stale.length) {
    const first = pipeline.stale[0];
    nags.push(`"${first.title}" filmed but unposted 48h+`);
  }
  if (!yHorses.bets && !yGrey.bets) {
    nags.push('No results logged yesterday — settle them');
  }

  if (nags.length) {
    L.push('');
    L.push('<b>Chasing you</b>');
    for (const n of nags.slice(0, 3)) L.push(esc(`• ${n}`));
  }

  return L.join('\n');
}

exports.handler = async (req) => {
  const q = (req && req.queryStringParameters) || {};
  const forced = q.force === '1';

  if (forced && q.pw !== process.env.ADMIN_PASSWORD) {
    return { statusCode: 401, body: 'unauthorised' };
  }

  // DST guard: cron runs 05:45 and 06:45 UTC; only one is 06:45 UK.
  if (!forced && events.ukHour() !== 6) {
    return { statusCode: 200, body: 'skipped: not 6am UK' };
  }

  try {
    const text = await buildBrief();
    const chatId = process.env.BRIEF_CHAT_ID;
    if (!chatId) throw new Error('BRIEF_CHAT_ID is not set');

    await sendMessage(chatId, text);
    await events.append({
      type: 'brief.generated',
      actor: 'system',
      payload: { chars: text.length },
    });

    return { statusCode: 200, body: 'sent' };
  } catch (err) {
    console.error('brief failed:', err);
    return { statusCode: 500, body: `brief failed: ${err.message}` };
  }
};

exports.buildBrief = buildBrief;
