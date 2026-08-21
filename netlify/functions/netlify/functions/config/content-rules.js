// netlify/functions/config/content-rules.js
//
// This is the file you will actually edit. It decides what the brief tells
// you to film and when to post it. No AI involved - pure rules, so it fires
// identically every morning.
//
// Times are UK local, 24h.

// ---------------------------------------------------------------------------
// Big meetings. Add rows as the calendar fills. Inclusive date ranges.
// ---------------------------------------------------------------------------
const FIXTURES = [
  { name: 'Ebor Festival', from: '2026-08-19', to: '2026-08-22', sport: 'horses' },
  // { name: 'Cheltenham Festival', from: '2027-03-16', to: '2027-03-19', sport: 'horses' },
  // { name: 'Greyhound Derby', from: '2027-05-29', to: '2027-06-26', sport: 'greyhounds' },
];

// ---------------------------------------------------------------------------
// Posting windows per platform. The brief reads these for "post at".
// ---------------------------------------------------------------------------
const POST_TIMES = {
  tiktok: ['12:30', '19:00'],
  instagram: ['12:00'],
  x: ['09:30', '13:00', '20:00'],
  telegram: ['08:00', '18:40'],
};

// ---------------------------------------------------------------------------
// Rules. Each returns zero or more tasks when its match() is true.
// ctx = { date, dow, fixture, bigWinners, pipeline }
//   dow: 0=Sun ... 6=Sat
//   fixture: the FIXTURES row for today, or null
//   bigWinners: yesterday's settled winners at 8/1+ (decimal 9.0+)
// ---------------------------------------------------------------------------
const RULES = [
  {
    id: 'fixture-preview',
    match: (ctx) => !!ctx.fixture,
    tasks: (ctx) => [
      {
        title: `${ctx.fixture.name} preview - 60s vertical`,
        ref: `${ctx.fixture.name.toLowerCase().replace(/\s+/g, '-')}-${ctx.date}`,
        platform: 'tiktok',
        filmBy: '11:00',
        postAt: '12:30',
        note: 'Analysis framing. No odds as a call to action, no bet slips.',
      },
    ],
  },
  {
    id: 'saturday-card',
    match: (ctx) => ctx.dow === 6 && !ctx.fixture,
    tasks: (ctx) => [
      {
        title: 'Saturday card walkthrough',
        ref: `sat-card-${ctx.date}`,
        platform: 'tiktok',
        filmBy: '10:30',
        postAt: '12:30',
        note: 'Pick two races max. Reasoning over selections.',
      },
    ],
  },
  {
    id: 'big-winner-clip',
    match: (ctx) => ctx.bigWinners.length > 0,
    tasks: (ctx) => [
      {
        title: `Result clip - ${ctx.bigWinners[0].selection} (${ctx.bigWinners[0].advisedPrice})`,
        ref: `winner-${ctx.date}`,
        platform: 'instagram',
        filmBy: '17:00',
        postAt: '19:00',
        note: 'Advised price vs SP is the story. Not the profit figure.',
      },
    ],
  },
  {
    id: 'sunday-review',
    match: (ctx) => ctx.dow === 0,
    tasks: (ctx) => [
      {
        title: 'Weekly P&L card - both codes',
        ref: `weekly-pl-${ctx.date}`,
        platform: 'x',
        filmBy: null,
        postAt: '20:00',
        note: 'Auto-generated card. Check the numbers before it goes.',
      },
    ],
  },
  {
    id: 'greyhound-daily',
    match: () => true,
    tasks: (ctx) => [
      {
        title: 'Greyhound tips to Exclusive Group',
        ref: `grey-tips-${ctx.date}`,
        platform: 'telegram',
        filmBy: null,
        postAt: '18:40',
        note: 'Judges in by 18:00.',
      },
    ],
  },
];

function fixtureFor(date) {
  return FIXTURES.find((f) => date >= f.from && date <= f.to) || null;
}

/**
 * Build today's task list.
 */
function tasksForDate(date, { dow, bigWinners = [] }) {
  const ctx = { date, dow, fixture: fixtureFor(date), bigWinners };
  const out = [];
  for (const rule of RULES) {
    try {
      if (rule.match(ctx)) out.push(...rule.tasks(ctx).map((t) => ({ ...t, rule: rule.id })));
    } catch (err) {
      out.push({ title: `RULE ERROR: ${rule.id}`, note: String(err.message) });
    }
  }
  // Sort by post time, unscheduled last.
  return out.sort((a, b) => (a.postAt || '99:99').localeCompare(b.postAt || '99:99'));
}

module.exports = { FIXTURES, POST_TIMES, RULES, fixtureFor, tasksForDate };
