import React, { useState, useEffect, useMemo, useCallback, useRef } from "react";
import SportToggle, { useSport } from "./greyhounds/SportToggle.jsx";
import GreyhoundTips from "./greyhounds/GreyhoundTips.jsx";
import GreyhoundAdmin from "./greyhounds/GreyhoundAdmin.jsx";
import { BET_TYPES, lineCount, settleMultiple, describeBet } from "./multiples.js";

/* ============================================================================
   HORSES BY HNH — DAILY RACING TIPS
   ----------------------------------------------------------------------------
   BRANDING   Drop logo.png in Netlify /public and it appears in the masthead.

   DATA LAYER Everything touching storage lives in `store`. To go live, swap the
              two methods for fetch() calls to a Netlify Function backed by
              Netlify Blobs. Nothing else changes.

   LANDING PAGE  summarise() returns the object your P&L panels read. Settle a
              result here and the landing page numbers move. One source of truth.

   NOT DONE CLIENT-SIDE — needs a Netlify Function:
     • Link previews. A React app serves the same empty HTML to every crawler,
       so pasting the URL into X gives a blank card. You need a function that
       renders per-day <meta og:image> tags and a generated preview image.
       Until then the in-app share tools below carry the load.
     • Web push. Real 6pm notifications need a service worker plus a push
       server. The install prompt and email list are the working substitutes.
   ========================================================================== */

/* ---------------------------------------------------------------------------
   PRIOR RECORD — horse racing results from before this page existed, carried
   over from the landing page archive. Points profit at advised prices.

   These aren't entered as individual tips on purpose. Every tip posted here
   carries a publish timestamp, and that timestamp is the proof. Backfilling
   old selections would mean inventing timestamps for bets this page never
   published — exactly what the record is meant to rule out. So the history
   is shown as a carried-over total, clearly labelled.

   Months carry counts where they're known. Anything still null simply doesn't
   show — sections stay hidden rather than displaying dashes — and fills in
   automatically the moment the figures are added.
--------------------------------------------------------------------------- */
const PRIOR_BY_TIPSTER = {
  lewis: {
    label: "April – 16 August 2026",
    through: "2026-08-16",
    // Lewis's carried-over months ARE Hooves & Hounds — he was tipping under
    // the brand throughout, so they belong in the combined record.
    isHNH: true,
    months: [
      { key: "2026-04", profit: 28.25, bets: 44, winners: 16, placed: 4, staked: 87 },
      { key: "2026-05", profit: 10.28, bets: 151, winners: 56, placed: 1, staked: 305.5 },
      { key: "2026-06", profit: 8.40, bets: null, winners: null, staked: 283.5 },
      { key: "2026-07", profit: 4.84, bets: 62, winners: 14, placed: 0, staked: 114.5 },
      { key: "2026-08", profit: -14.62, bets: 35, winners: 7, placed: 0, staked: 64.5 },
    ],
  },
  nath: {
    label: "April – 18 August 2026",
    through: "2026-08-18",
    joined: "2026-08-19",
    // Nath's own record from before he joined. Shown so punters can see how he
    // did over the same period, but deliberately NOT counted in the Hooves &
    // Hounds figures — those bets didn't go out under this brand.
    isHNH: false,
    months: [
      { key: "2026-04", profit: 31.20, bets: 30, winners: 16, placed: 0, staked: 47 },
      { key: "2026-05", profit: 30.59, bets: 38, winners: 20, placed: 0, staked: 62.5 },
      { key: "2026-06", profit: -11.95, bets: 30, winners: 9, placed: 0, staked: 45 },
      { key: "2026-07", profit: 18.45, bets: 39, winners: 12, placed: 0, staked: 55.5 },
      { key: "2026-08", profit: -0.05, bets: 19, winners: 5, placed: 0, staked: 34.25 },
    ],
  },
};

/* Carried-over months for whoever is selected.
   Viewing one tipster shows that tipster's own history. "All tips" is the
   Hooves & Hounds record, so it only carries over months that went out under
   the brand — anything a tipster did before joining stays on their own tab. */
function priorMonthsFor(who) {
  if (who !== "all") return PRIOR_BY_TIPSTER[who]?.months || [];

  const merged = {};
  for (const t of Object.values(PRIOR_BY_TIPSTER)) {
    if (!t.isHNH) continue;
    for (const m of t.months) {
      const row = merged[m.key] || (merged[m.key] = {
        key: m.key, profit: 0, bets: 0, winners: 0, placed: 0, staked: 0,
      });
      row.profit += m.profit;
      row.bets += m.bets || 0;
      row.winners += m.winners || 0;
      row.placed += m.placed || 0;
      row.staked += m.staked || 0;
    }
  }
  return Object.keys(merged).sort().map((k) => merged[k]);
}

/* The note under the month table. It has to say plainly whose record this is
   and whether it counts toward the brand's figures — a tipster's pre-joining
   history shown without that caveat would overstate what Hooves & Hounds has
   actually done. */
function priorNote(who) {
  if (who === "all") {
    return `${PRIOR_BY_TIPSTER.lewis.label} carried over from the published archive, where the
      tips went out by Telegram and email. Everything after that was posted here, timestamped.
      Nath joined on 19 August — his tips count from that date, and his earlier record is on
      his own tab.`;
  }
  const t = PRIOR_BY_TIPSTER[who];
  if (!t) return "";
  if (t.isHNH) {
    return `${t.label} carried over from the published archive, where the tips went out by
      Telegram and email. Everything after that was posted here, timestamped.`;
  }
  return `${t.label} is Nath's own record from before he joined Hooves & Hounds, shown so you
    can see how he did over the same period. It is not included in the Hooves & Hounds figures.
    His first tip for us was on 19 August — everything from then is posted here, timestamped.`;
}

/* Tipsters. Add or rename here — everything else follows.
   The carried-over record below belongs to Lewis; Nath starts from zero, which
   is the honest structure. Pooling them would credit a new tipster with a
   record he didn't build, and drag the other's figures around too. */
const TIPSTERS = [
  { id: "lewis", name: "Lewis" },
  { id: "nath", name: "Nath" },
];
const tipsterName = (id) => TIPSTERS.find((t) => t.id === id)?.name || "Lewis";

// Bets needed before the advised-vs-SP panel appears. Below this it's noise.
const SP_PANEL_MIN_BETS = 50;

const LOGO_SRC = "/logo.png";
const GREYHOUND_LOGO_SRC = "/logo-greyhounds.png";
const SITE_URL = "tips.hoovesnhounds.com";
const PUBLISH_HOUR = 18; // tips go out around 6pm

const store = {
  async read() {
    const r = await fetch("/api/tips");
    if (!r.ok) throw new Error("read failed");
    const j = await r.json();
    return j.days || {};
  },
  async write(days, password) {
    const r = await fetch("/api/tips", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-admin-password": password },
      body: JSON.stringify({ days }),
    });
    if (!r.ok) throw new Error(r.status === 401 ? "unauthorised" : "write failed");
  },
  async verify(password) {
    const r = await fetch("/api/tips", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-admin-password": password },
      body: JSON.stringify({ verify: true }),
    });
    return r.ok;
  },
};


/* Telegram announcements. Deliberately separate from store.write — a Telegram
   failure must never stop a tip saving, so this is called after the save and
   its result only ever surfaces as a status message. */
const notify = async (payload, password) => {
  const r = await fetch("/api/horse-notify", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-admin-password": password },
    body: JSON.stringify(payload),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || "Telegram failed");
  return j;
};

/* ============================ ODDS + P&L MATHS ============================ */

function fractionToProfit(frac) {
  if (!frac) return null;
  const s = String(frac).trim().toLowerCase();
  if (s === "evs" || s === "evens" || s === "even") return 1;
  const m = s.match(/^(\d+(?:\.\d+)?)\s*[/-]\s*(\d+(?:\.\d+)?)$/);
  if (!m) return null;
  const d = parseFloat(m[2]);
  return d ? parseFloat(m[1]) / d : null;
}

const PLACE_TERMS = { "1/2": 0.5, "1/4": 0.25, "1/5": 0.2 };

function pointsAt(tip, priceStr) {
  const f = fractionToProfit(priceStr);
  const stake = parseFloat(tip.stake) || 0;
  if (f === null || tip.result === "void" || tip.result === "pending") return 0;
  const term = PLACE_TERMS[tip.placeTerms] ?? 0.2;
  if (tip.betType === "ew") {
    if (tip.result === "won") return stake * f + stake * f * term;
    if (tip.result === "placed") return -stake + stake * f * term;
    return -2 * stake;
  }
  if (tip.result === "won") return stake * f;
  return -stake;
}

/* Multiples settle through the combination engine, singles through pointsAt.
   Keeping both in one tips array means the record, graph, streaks and month
   table all count multiples without any of them knowing multiples exist. */
const isMultiple = (tip) => tip.kind === "multiple";

/* Ante-post bets are stored on the day they were advised, like everything
   else, but they aren't part of that day's card — they stand until the race
   is run, which may be months away. So they're pulled out of the daily views
   and given their own section, and they only enter the record once settled. */
const isAntePost = (tip) => tip.kind === "antepost";

const multipleResult = (tip, price) =>
  settleMultiple(tip.betType, tip.legs || [], {
    stakePerLine: parseFloat(tip.stake) || 0,
    eachWay: tip.eachWay,
    price,
  });

// What the odds and stake alone produce, ignoring any override.
const settlePointsAuto = (tip) =>
  isMultiple(tip) ? (multipleResult(tip, "advised").profit || 0) : pointsAt(tip, tip.price);

// Advised price — the headline number. Manual override wins (Rule 4, BOG).
function settlePoints(tip) {
  if (tip.manualPts !== null && tip.manualPts !== undefined && tip.manualPts !== "") {
    const v = parseFloat(tip.manualPts);
    return isNaN(v) ? 0 : v;
  }
  if (isMultiple(tip)) {
    const r = multipleResult(tip, "advised");
    return r.pending || r.error ? 0 : r.profit;
  }
  return pointsAt(tip, tip.price);
}

// Starting price — the honesty check.
const spPoints = (tip) => {
  if (isMultiple(tip)) {
    const r = multipleResult(tip, "sp");
    return r.pending || r.error ? 0 : r.profit;
  }
  return tip.sp ? pointsAt(tip, tip.sp) : settlePoints(tip);
};

function stakedPoints(tip) {
  if (tip.result === "void" || tip.result === "pending") return 0;
  if (isMultiple(tip)) return multipleResult(tip, "advised").staked || 0;
  const stake = parseFloat(tip.stake) || 0;
  return tip.betType === "ew" ? stake * 2 : stake;
}

/* A multiple's result comes from its legs: settled once every leg is, and
   counted as won if it made money. Storing it keeps every existing filter
   working without them knowing multiples exist. */
function derivedResult(tip) {
  const legs = tip.legs || [];
  if (!legs.length) return "pending";
  if (legs.some((l) => !l.result || l.result === "pending")) return "pending";
  if (legs.every((l) => l.result === "void")) return "void";
  return settlePointsAuto(tip) > 0 ? "won" : "lost";
}

/* Every settled bet in running order — the spine of the proof section. */
/* Every settled bet in running order.
   `date` is the date the bet COUNTS on, which for a day's card is the day it
   ran. An ante-post bet advised in November and settled in March belongs to
   March — attributing it to November would retrospectively rewrite a month
   that had already been published. */
function countedDate(tip, iso) {
  if (isAntePost(tip) && tip.settledAt) return tip.settledAt.slice(0, 10);
  return iso;
}

function settledInOrder(days, who = "all") {
  const out = [];
  Object.keys(days).forEach((iso) =>
    days[iso].tips.forEach((t) => {
      const owner = t.tipster || "lewis";
      if (who !== "all" && owner !== who) return;
      if (t.result && t.result !== "pending") {
        out.push({ ...t, date: countedDate(t, iso), advised: iso });
      }
    })
  );
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

function summarise(days, who = "all") {
  const settled = settledInOrder(days, who);
  const priorMonths = priorMonthsFor(who);
  const livePts = settled.reduce((a, t) => a + settlePoints(t), 0);
  const spProfit = settled.reduce((a, t) => a + spPoints(t), 0);
  const staked = settled.reduce((a, t) => a + stakedPoints(t), 0);
  const liveWinners = settled.filter((t) => t.result === "won").length;

  const priorPts = priorMonths.reduce((a, m) => a + m.profit, 0);
  const profit = priorPts + livePts;
  const priorStaked = priorMonths.reduce((a, m) => a + (m.staked || 0), 0);
  const totalStaked = priorStaked + staked;
  const combinedRoi = totalStaked ? (profit / totalStaked) * 100 : 0;

  // Equity curve — opens at the carried-over total, not at zero.
  let run = priorPts;
  const curve = [priorPts, ...settled.map((t) => (run += settlePoints(t)))];

  // Longest run of losing bets. Published openly — hiding it is the tell.
  let streak = 0, worstStreak = 0;
  settled.forEach((t) => {
    if (settlePoints(t) < 0) { streak++; worstStreak = Math.max(worstStreak, streak); }
    else streak = 0;
  });

  // Month by month — carried-over months first, then anything settled here.
  const months = {};
  priorMonths.forEach((m) => {
    months[m.key] = {
      bets: m.bets || 0, winners: m.winners || 0, profit: m.profit,
      staked: m.staked || 0, carried: true, counted: m.bets !== null,
    };
  });
  settled.forEach((t) => {
    const k = t.date.slice(0, 7);
    if (!months[k]) months[k] = { bets: 0, winners: 0, profit: 0, staked: 0, counted: true };
    months[k].bets++;
    if (t.result === "won") months[k].winners++;
    months[k].profit += settlePoints(t);
    months[k].staked += stakedPoints(t);
    months[k].counted = months[k].carried ? months[k].counted : true;
  });

  // Timeline for the chart — cumulative points and cumulative ROI, month by month.
  const ascending = Object.keys(months).sort();
  let cp = 0, cs = 0;
  const timeline = ascending.map((k) => {
    cp += months[k].profit;
    cs += months[k].staked;
    return {
      key: k,
      label: new Date(+k.slice(0, 4), +k.slice(5, 7) - 1, 1)
        .toLocaleDateString("en-GB", { month: "short" }),
      pts: cp,
      roi: cs ? (cp / cs) * 100 : 0,
    };
  });

  return {
    timeline, totalStaked, combinedRoi,
    liveBets: settled.length,
    liveWinners,
    priorPts,
    profit, spProfit, staked,
    roi: staked ? (livePts / staked) * 100 : 0,
    spRoi: staked ? (spProfit / staked) * 100 : 0,
    livePts,
    curve, worstStreak, currentStreak: streak,
    months: Object.keys(months).sort().reverse().map((k) => ({ key: k, ...months[k] })),
  };
}

/* ============================== DATE HELPERS ============================== */

/* Dates are UK racing dates, so they resolve in Europe/London rather than UTC.
   toISOString() would leave a card up for an extra hour after midnight in BST. */
const LONDON = "Europe/London";

const londonISO = (date = new Date()) =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: LONDON, year: "numeric", month: "2-digit", day: "2-digit",
  }).format(date);

const todayISO = () => londonISO();

function tomorrowISO() {
  const d = new Date(); d.setDate(d.getDate() + 1);
  return londonISO(d);
}

function longDate(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("en-GB", {
    weekday: "long", day: "numeric", month: "long",
  });
}

function shortDate(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("en-GB", {
    weekday: "short", day: "numeric", month: "short",
  });
}

function monthName(key) {
  const [y, m] = key.split("-").map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString("en-GB", { month: "long", year: "numeric" });
}

const stamp = (ts) => new Date(ts).toLocaleString("en-GB", {
  day: "numeric", month: "short", hour: "2-digit", minute: "2-digit",
});

const fmtPts = (n) => (n > 0 ? "+" : "") + n.toFixed(2) + " pts";
const fmtSigned = (n) => (n > 0 ? "+" : "") + n.toFixed(1);

/* ================================ STYLES ================================= */

const CSS = `
@import url('https://fonts.googleapis.com/css2?family=Montserrat:wght@400;500;600;700&family=JetBrains+Mono:wght@400;600&display=swap');

.hnh{
  --ink:#000; --panel:#0C0C0D; --panel2:#131315; --line:#232326;
  --gold-lo:#A87718; --gold:#D9AE4A; --gold-hi:#F3E0A3;
  --metal:linear-gradient(150deg,#A87718 0%,#E8C765 32%,#F7EDBE 50%,#D9AE4A 68%,#9A6B14 100%);
  --text:#FFF; --body:#B9B9BF; --muted:#77777E;
  --win:#4CA97A; --loss:#C0473C;
  background:var(--ink);color:var(--text);min-height:100vh;
  font-family:'Montserrat',system-ui,sans-serif;-webkit-font-smoothing:antialiased;
}
.hnh *,.hnh *::before,.hnh *::after{box-sizing:border-box;}
.hnh button{font-family:inherit;cursor:pointer;}
.hnh :focus-visible{outline:2px solid var(--gold);outline-offset:2px;}
@media (prefers-reduced-motion:reduce){.hnh *{animation:none!important;transition:none!important;}}

.wrap{max-width:620px;margin:0 auto;padding:0 16px 60px;}

.top{padding:24px 0 18px;text-align:center;position:relative;}
.logo{width:128px;height:auto;margin:0 auto;display:block;}
.lockup .w1{font-weight:600;font-size:25px;letter-spacing:.34em;text-indent:.34em;line-height:1;}
.lockup .w2{font-weight:600;font-size:21px;letter-spacing:.30em;text-indent:.30em;line-height:1;
  background:var(--metal);-webkit-background-clip:text;background-clip:text;color:transparent;margin-top:7px;}
.adminbtn{position:absolute;top:24px;right:0;background:none;border:1px solid var(--line);
  color:var(--muted);font-size:9px;letter-spacing:.16em;text-transform:uppercase;padding:6px 10px;font-weight:500;}
.adminbtn:hover{color:var(--gold);border-color:var(--gold-lo);}

.div{display:flex;align-items:center;gap:14px;margin:32px 0 18px;}
.div::before,.div::after{content:"";flex:1;height:1px;background:var(--metal);opacity:.75;}
.div span{font-size:10px;font-weight:600;letter-spacing:.30em;text-indent:.30em;
  text-transform:uppercase;color:var(--gold);white-space:nowrap;}

.board{display:grid;grid-template-columns:repeat(4,1fr);border:1px solid var(--line);
  background:var(--panel);margin:18px 0 0;position:relative;}
.board::before{content:"";position:absolute;top:-1px;left:0;right:0;height:2px;background:var(--metal);}
.board div{padding:12px 6px;text-align:center;border-right:1px solid var(--line);}
.board div:last-child{border-right:none;}
.board dt{font-size:8px;font-weight:600;letter-spacing:.18em;text-indent:.18em;
  text-transform:uppercase;color:var(--muted);margin-bottom:6px;}
.board dd{font-family:'JetBrains Mono';font-weight:600;font-size:16px;margin:0;font-variant-numeric:tabular-nums;}
.pos{color:var(--win);} .neg{color:var(--loss);}
.since{text-align:center;font-size:9px;letter-spacing:.14em;text-transform:uppercase;
  color:var(--muted);margin:10px auto 0;line-height:1.8;max-width:34ch;}
.flag-sep{color:var(--gold);}
.intro{text-align:center;font-size:12.5px;color:var(--body);line-height:1.7;margin:14px 0 0;}

/* install + countdown */
.bar{display:flex;align-items:center;gap:12px;border:1px solid var(--line);background:var(--panel);
  padding:11px 13px;margin-top:16px;position:relative;}
.bar::before{content:"";position:absolute;left:-1px;top:0;bottom:0;width:2px;background:var(--metal);}
.bar p{margin:0;font-size:11.5px;color:var(--body);line-height:1.5;flex:1;}
.bar b{color:var(--gold);font-weight:600;}
.x{background:none;border:none;color:var(--muted);font-size:16px;padding:0 2px;line-height:1;}
.count{font-family:'JetBrains Mono';font-size:12px;color:var(--gold);letter-spacing:.05em;}

.daytitle{font-weight:700;font-size:19px;letter-spacing:.13em;text-indent:.13em;
  text-transform:uppercase;margin:0 0 8px;line-height:1.35;}
.posted{font-family:'JetBrains Mono';font-size:10px;color:var(--muted);letter-spacing:.04em;margin-bottom:18px;}

.tip{display:flex;background:var(--panel);border:1px solid var(--line);margin-bottom:12px;
  animation:rise .4s ease both;}
@keyframes rise{from{opacity:0;transform:translateY(8px);}to{opacity:1;transform:none;}}
.rail{flex:0 0 66px;background:var(--panel2);border-right:1px solid var(--line);padding:13px 6px;text-align:center;}
.tip.won .rail{background:rgba(76,169,122,.12);border-right-color:var(--win);}
.tip.lost .rail{background:rgba(192,71,60,.10);border-right-color:var(--loss);}
.tip.placed .rail{background:rgba(217,174,74,.10);border-right-color:var(--gold-lo);}
.rtime{font-family:'JetBrains Mono';font-weight:600;font-size:14px;color:var(--gold);}
.rcourse{font-size:9px;font-weight:600;letter-spacing:.13em;text-transform:uppercase;
  color:var(--muted);margin-top:5px;line-height:1.25;word-break:break-word;}
.body{flex:1;padding:13px 14px;min-width:0;}
.horse{font-weight:700;font-size:16px;letter-spacing:.10em;text-indent:.10em;
  text-transform:uppercase;margin:0 0 10px;line-height:1.3;}
.meta{display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin-bottom:10px;}
.chip{font-family:'JetBrains Mono';font-size:10px;padding:5px 8px;border:1px solid var(--line);
  color:var(--muted);letter-spacing:.05em;text-transform:uppercase;}
.price{background:var(--metal);border:none;color:#111;font-weight:600;font-size:11px;
  text-decoration:none;display:inline-block;padding:6px 10px;font-family:'JetBrains Mono';}
.price:hover{filter:brightness(1.12);}
.checkprice{display:block;text-align:center;border:1px solid var(--line);background:var(--panel2);
  color:var(--gold);font-size:11px;font-weight:600;letter-spacing:.14em;text-transform:uppercase;
  padding:10px 8px;margin:0 0 12px;text-decoration:none;}
.checkprice:hover{border-color:var(--gold-lo);}
.tip.multi{display:block;}
.tip.multi .body{padding:14px 15px;}
.multihead{display:flex;justify-content:space-between;align-items:center;gap:10px;
  flex-wrap:wrap;margin-bottom:12px;}
.multihead .horse{margin:0;}
.legs{list-style:none;margin:0 0 12px;padding:0;counter-reset:leg;}
.legs li{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap;padding:9px 0 9px 22px;
  border-bottom:1px solid var(--line);position:relative;font-size:13px;}
.legs li::before{counter-increment:leg;content:counter(leg);position:absolute;left:0;
  font-family:'JetBrains Mono';font-size:10px;color:var(--muted);top:11px;}
.legs li:last-child{border-bottom:none;}
.legwhen{font-family:'JetBrains Mono';font-size:10px;color:var(--muted);
  letter-spacing:.04em;text-transform:uppercase;flex:0 0 auto;}
.leghorse{font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:var(--text);flex:1;}
.legprice{font-family:'JetBrains Mono';font-size:12px;color:var(--gold);}
.legflag{font-size:8px;font-weight:700;letter-spacing:.14em;text-transform:uppercase;
  padding:3px 7px;border:1px solid;}
.legflag.won{color:var(--win);border-color:var(--win);}
.legflag.lost{color:var(--loss);border-color:var(--loss);}
.legflag.placed{color:var(--gold);border-color:var(--gold-lo);}
.legflag.void{color:var(--muted);border-color:var(--line);}
.writeup{font-size:13.5px;line-height:1.65;color:var(--body);white-space:pre-wrap;font-weight:400;}
.flag{display:inline-block;font-size:9px;font-weight:700;letter-spacing:.18em;text-indent:.18em;
  text-transform:uppercase;padding:5px 10px;margin-top:12px;border:1px solid;}
.flag.won{color:var(--win);border-color:var(--win);}
.flag.lost{color:var(--loss);border-color:var(--loss);}
.flag.placed,.flag.void{color:var(--gold);border-color:var(--gold-lo);}

/* share */
.share{display:flex;gap:8px;margin:4px 0 8px;}
.share button{flex:1;background:none;border:1px solid var(--line);color:var(--muted);
  padding:11px 6px;font-size:9px;font-weight:600;letter-spacing:.14em;text-transform:uppercase;}
.share button:hover{color:var(--gold);border-color:var(--gold-lo);}

/* proof */
.chartbox{border:1px solid var(--line);background:var(--panel);padding:14px 12px 8px;}
.chartbox h4{font-size:9px;font-weight:600;letter-spacing:.18em;text-transform:uppercase;
  color:var(--muted);margin:0 0 10px;}
.who{display:flex;gap:6px;margin:16px 0 2px;}
.who button{flex:1;background:var(--panel);border:1px solid var(--line);color:var(--muted);
  padding:10px 4px;font-size:9px;font-weight:600;letter-spacing:.14em;text-transform:uppercase;}
.who button[aria-pressed="true"]{background:var(--metal);border-color:transparent;
  color:#111;font-weight:700;}
.byline{font-size:10px;font-weight:700;letter-spacing:.22em;text-indent:.22em;
  text-transform:uppercase;color:var(--gold);margin:18px 0 10px;display:flex;
  align-items:center;gap:10px;}
.byline::after{content:"";flex:1;height:1px;background:var(--line);}
.verdict{margin:12px 0 0;padding:11px 12px;background:var(--panel2);
  border-left:2px solid var(--gold-lo);font-size:13px;line-height:1.6;color:var(--body);
  white-space:pre-wrap;}
.verdict span{display:block;font-size:8px;font-weight:600;letter-spacing:.18em;
  text-transform:uppercase;color:var(--gold);margin-bottom:6px;}
.subhead{font-size:9px;font-weight:600;letter-spacing:.20em;text-indent:.20em;
  text-transform:uppercase;color:var(--muted);margin:22px 0 10px;text-align:center;}
.trio{display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;}
.trio .stat{padding:13px 4px;}
.trio dd{font-size:15px;}
.duo{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:12px;}
.stat{border:1px solid var(--line);background:var(--panel);padding:13px;text-align:center;}
.stat dt{font-size:8px;font-weight:600;letter-spacing:.16em;text-transform:uppercase;color:var(--muted);}
.stat dd{font-family:'JetBrains Mono';font-weight:600;font-size:17px;margin:7px 0 0;}
.stat small{display:block;font-size:9px;color:var(--muted);margin-top:5px;letter-spacing:.04em;
  font-family:'Montserrat';text-transform:none;}
.mtable{width:100%;border-collapse:collapse;margin-top:12px;}
.mtable th{font-size:8px;font-weight:600;letter-spacing:.14em;text-transform:uppercase;
  color:var(--muted);text-align:right;padding:8px 6px;border-bottom:1px solid var(--line);}
.mtable th:first-child{text-align:left;}
.mtable td{font-family:'JetBrains Mono';font-size:12px;text-align:right;padding:10px 6px;
  border-bottom:1px solid var(--line);font-variant-numeric:tabular-nums;color:var(--body);}
.mtable td:first-child{text-align:left;font-family:'Montserrat';font-size:11px;font-weight:600;
  letter-spacing:.08em;text-transform:uppercase;color:var(--text);}

.arow{display:flex;justify-content:space-between;align-items:center;width:100%;gap:10px;
  background:var(--panel);border:1px solid var(--line);padding:13px 14px;margin-bottom:8px;
  color:var(--text);text-align:left;}
.arow:hover{border-color:var(--gold-lo);}
.arow b{font-weight:600;font-size:12px;letter-spacing:.13em;text-transform:uppercase;}
.arow small{display:block;font-size:10px;color:var(--muted);margin-top:4px;letter-spacing:.06em;}
.arow em{font-family:'JetBrains Mono';font-style:normal;font-size:13px;font-variant-numeric:tabular-nums;}

.mail{border:1px solid var(--line);background:var(--panel);padding:20px;margin-top:34px;
  position:relative;text-align:center;}
.mail::before{content:"";position:absolute;top:-1px;left:0;right:0;height:2px;background:var(--metal);}
.mail h3{font-weight:700;font-size:14px;letter-spacing:.16em;text-indent:.16em;
  text-transform:uppercase;margin:0 0 8px;}
.mail p{font-size:12.5px;color:var(--muted);margin:0 0 15px;line-height:1.6;}
.mailrow{display:flex;gap:8px;}

input,select,textarea{width:100%;background:var(--panel2);border:1px solid var(--line);
  color:var(--text);padding:11px;font-family:'Montserrat';font-size:15px;font-weight:500;border-radius:0;}
textarea{min-height:100px;resize:vertical;line-height:1.6;font-weight:400;}
label{display:block;font-size:9px;font-weight:600;letter-spacing:.16em;text-indent:.16em;
  text-transform:uppercase;color:var(--muted);margin-bottom:6px;}
.field{margin-bottom:13px;}
.grid2{display:grid;grid-template-columns:1fr 1fr;gap:10px;}
.grid3{display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px;}
.btn{background:var(--metal);color:#111;border:none;padding:13px 18px;font-weight:700;
  font-size:10px;letter-spacing:.18em;text-indent:.18em;text-transform:uppercase;}
.btn:hover{filter:brightness(1.12);}
.btn.flat{background:none;border:1px solid var(--line);color:var(--muted);font-weight:600;}
.btn.flat:hover{color:var(--gold);border-color:var(--gold-lo);}
.card{background:var(--panel);border:1px solid var(--line);padding:16px;margin-bottom:14px;}
.card h4{font-weight:700;font-size:11px;letter-spacing:.16em;text-indent:.16em;
  text-transform:uppercase;margin:0 0 14px;color:var(--gold);line-height:1.5;}
.seg{display:flex;gap:6px;}
.seg button{flex:1;background:var(--panel2);border:1px solid var(--line);color:var(--muted);
  padding:10px 4px;font-size:9px;font-weight:600;letter-spacing:.12em;text-transform:uppercase;}
.seg button[aria-pressed="true"]{background:var(--metal);border-color:transparent;color:#111;font-weight:700;}
.tip.ante{display:block;}
.tip.ante .body{padding:14px 15px;}
.antehead{display:flex;justify-content:space-between;align-items:baseline;gap:10px;
  flex-wrap:wrap;margin-bottom:8px;}
.anteevent{font-size:9px;font-weight:600;letter-spacing:.20em;text-transform:uppercase;
  color:var(--gold);}
.antedate{font-family:'JetBrains Mono';font-size:10px;color:var(--muted);}
.flag.open{color:var(--gold);border-color:var(--gold-lo);}
.anteintro{font-size:12px;color:var(--body);line-height:1.7;margin:0 0 14px;
  padding:11px 12px;background:var(--panel2);border-left:2px solid var(--gold-lo);}
.legcard{border:1px solid var(--line);background:var(--panel2);padding:12px;margin-bottom:12px;}
.leglabel{font-size:9px;font-weight:600;letter-spacing:.16em;text-transform:uppercase;
  color:var(--gold);margin-bottom:10px;}
.srow{display:flex;align-items:center;gap:8px;padding:10px 0;border-bottom:1px solid var(--line);}
.srow span{flex:1;font-size:11px;letter-spacing:.05em;min-width:0;}
.srow span small{display:block;color:var(--muted);font-size:10px;margin-top:3px;}
.empty{border:1px dashed var(--line);padding:34px 20px;text-align:center;color:var(--muted);
  font-size:13px;line-height:1.8;letter-spacing:.03em;}
.alert{border:1px solid var(--loss);color:var(--loss);padding:10px 12px;font-size:11.5px;
  letter-spacing:.04em;margin:14px 0 0;line-height:1.5;}
.note{font-size:10.5px;color:var(--muted);margin-top:10px;line-height:1.6;letter-spacing:.03em;}
.tracker{display:block;text-align:center;border:1px solid var(--line);background:var(--panel);
  padding:16px;margin-top:28px;text-decoration:none;position:relative;}
.tracker::before{content:"";position:absolute;left:-1px;top:0;bottom:0;width:2px;background:var(--metal);}
.tracker-line{display:block;font-size:13px;color:var(--body);}
.tracker-url{display:block;font-family:'JetBrains Mono';font-size:12.5px;color:var(--gold);
  margin-top:7px;letter-spacing:.04em;}
.foot{margin-top:40px;padding-top:18px;border-top:1px solid var(--line);font-size:10px;
  color:var(--muted);line-height:1.9;text-align:center;letter-spacing:.05em;}
`;

/* ============================ SHARE TOOLING ============================== */

function buildTweet(iso, day) {
  const lines = [`🏇 SELECTIONS — ${shortDate(iso).toUpperCase()}`, ""];
  day.tips.forEach((t) => {
    const who = TIPSTERS.length > 1 ? `${tipsterName(t.tipster)} · ` : "";
    lines.push(`${who}${t.time} ${t.course} — ${t.horse.toUpperCase()}`);
    lines.push(`${t.price} · ${t.stake}pt ${t.betType === "ew" ? "e/w" : "win"}`);
    lines.push("");
  });
  lines.push("Full write-ups, free:");
  lines.push(SITE_URL);
  lines.push("");
  lines.push("18+ | BeGambleAware.org");
  return lines.join("\n");
}

/* Draws letter-spaced caps — the brand's defining type treatment, which canvas
   won't do on its own in every browser. */
function tracked(ctx, text, x, y, spacing, align = "left") {
  const chars = [...text];
  const width = chars.reduce((a, c) => a + ctx.measureText(c).width + spacing, 0) - spacing;
  let cx = align === "center" ? x - width / 2 : align === "right" ? x - width : x;
  chars.forEach((c) => { ctx.fillText(c, cx, y); cx += ctx.measureText(c).width + spacing; });
  return width;
}

function goldFill(ctx, x, y, w, h) {
  const g = ctx.createLinearGradient(x, y, x + w, y + h);
  g.addColorStop(0, "#A87718"); g.addColorStop(0.32, "#E8C765");
  g.addColorStop(0.5, "#F7EDBE"); g.addColorStop(0.68, "#D9AE4A");
  g.addColorStop(1, "#9A6B14");
  return g;
}

/* 1080x1350 — Instagram feed, and crops cleanly for a TikTok cover. */
async function renderCard(iso, day, summary) {
  const W = 1080, H = 1350;
  const c = document.createElement("canvas");
  c.width = W; c.height = H;
  const ctx = c.getContext("2d");

  ctx.fillStyle = "#000"; ctx.fillRect(0, 0, W, H);

  // masthead
  ctx.textBaseline = "alphabetic";
  ctx.font = "600 46px Montserrat, sans-serif";
  ctx.fillStyle = "#FFF";
  tracked(ctx, "HORSES", W / 2, 118, 16, "center");
  ctx.font = "600 34px Montserrat, sans-serif";
  ctx.fillStyle = goldFill(ctx, 340, 140, 400, 40);
  tracked(ctx, "BY HNH", W / 2, 170, 12, "center");

  // gold rule
  ctx.fillStyle = goldFill(ctx, 80, 210, 920, 3);
  ctx.fillRect(80, 210, 920, 3);

  // date
  ctx.font = "700 40px Montserrat, sans-serif";
  ctx.fillStyle = "#FFF";
  tracked(ctx, shortDate(iso).toUpperCase(), W / 2, 285, 7, "center");

  // tips
  let y = 350;
  const rowH = Math.min(210, (H - 560) / Math.max(day.tips.length, 1));
  day.tips.forEach((t) => {
    ctx.fillStyle = "#0C0C0D"; ctx.fillRect(80, y, 920, rowH - 18);
    ctx.strokeStyle = "#232326"; ctx.lineWidth = 2;
    ctx.strokeRect(80, y, 920, rowH - 18);
    ctx.fillStyle = goldFill(ctx, 80, y, 6, rowH); ctx.fillRect(80, y, 6, rowH - 18);

    ctx.font = "600 30px 'JetBrains Mono', monospace";
    ctx.fillStyle = "#D9AE4A";
    ctx.fillText(`${t.time}  ${t.course.toUpperCase()}`, 118, y + 55);

    ctx.font = "700 42px Montserrat, sans-serif";
    ctx.fillStyle = "#FFF";
    tracked(ctx, t.horse.toUpperCase().slice(0, 24), 118, y + 112, 4);

    ctx.font = "600 28px 'JetBrains Mono', monospace";
    ctx.fillStyle = goldFill(ctx, 118, y + 130, 300, 30);
    ctx.fillText(`${t.price}  ·  ${t.stake}pt ${t.betType === "ew" ? "E/W" : "WIN"}`, 118, y + 158);

    y += rowH;
  });

  // record strip
  const by = H - 190;
  ctx.fillStyle = goldFill(ctx, 80, by, 920, 3); ctx.fillRect(80, by, 920, 3);
  ctx.font = "600 22px Montserrat, sans-serif";
  ctx.fillStyle = "#77777E";
  tracked(ctx, "FULL RECORD SINCE LAUNCH", W / 2, by + 48, 5, "center");
  ctx.font = "600 40px 'JetBrains Mono', monospace";
  ctx.fillStyle = summary.profit >= 0 ? "#4CA97A" : "#C0473C";
  ctx.textAlign = "center";
  ctx.fillText(
    `${fmtSigned(summary.profit)} PTS   ·   ${summary.combinedRoi.toFixed(1)}% ROI`,
    W / 2, by + 100
  );
  ctx.textAlign = "left";
  ctx.font = "500 20px Montserrat, sans-serif";
  ctx.fillStyle = "#77777E";
  ctx.textAlign = "center";
  ctx.fillText(`${SITE_URL}   ·   18+   ·   BeGambleAware.org`, W / 2, by + 150);

  return new Promise((res) => c.toBlob(res, "image/png"));
}

/* ============================== COMPONENTS ============================== */

function Logo({ sport = "horses" }) {
  const [broken, setBroken] = useState(false);
  const dogs = sport === "greyhounds";
  const word = dogs ? "Greyhounds" : "Horses";

  // Reset if the sport changes, so a missing dog logo doesn't stick.
  useEffect(() => setBroken(false), [sport]);

  if (broken) return (
    <div className="lockup">
      <div className="w1" style={dogs ? { fontSize: 21 } : undefined}>{word}</div>
      <div className="w2">By HNH</div>
    </div>
  );
  return (
    <img className="logo" src={dogs ? GREYHOUND_LOGO_SRC : LOGO_SRC}
      alt={`${word} by HNH`} onError={() => setBroken(true)} />
  );
}

const Divider = ({ label }) => <div className="div"><span>{label}</span></div>;

function ShareRow({ iso, day, summary }) {
  const [msg, setMsg] = useState("");
  const busy = useRef(false);

  const copyTweet = async () => {
    const text = buildTweet(iso, day);
    try {
      await navigator.clipboard.writeText(text);
      setMsg("Post copied — paste it into X.");
    } catch {
      setMsg("Couldn't copy. Long-press to select instead.");
    }
    setTimeout(() => setMsg(""), 3500);
  };

  const makeImage = async () => {
    if (busy.current) return;
    busy.current = true;
    setMsg("Building image…");
    try {
      const blob = await renderCard(iso, day, summary);
      const file = new File([blob], `hnh-${iso}.png`, { type: "image/png" });
      if (navigator.canShare?.({ files: [file] })) {
        await navigator.share({ files: [file] });
        setMsg("");
      } else {
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url; a.download = `hnh-${iso}.png`; a.click();
        URL.revokeObjectURL(url);
        setMsg("Image saved.");
      }
    } catch {
      setMsg("Image didn't build. Try again.");
    }
    busy.current = false;
    setTimeout(() => setMsg(""), 3500);
  };

  return (
    <>
      <div className="share">
        <button onClick={copyTweet}>Copy post for X</button>
        <button onClick={makeImage}>Make image</button>
      </div>
      {msg && <p className="note" style={{ color: "var(--gold)", marginTop: 0 }}>{msg}</p>}
    </>
  );
}

/* What the points record is worth in money at common stake sizes. */
function Returns({ profit }) {
  const stakes = [5, 10, 20];
  const money = (n) =>
    (n < 0 ? "−£" : "£") + Math.abs(n).toLocaleString("en-GB", {
      minimumFractionDigits: 2, maximumFractionDigits: 2,
    });
  return (
    <>
      <h4 className="subhead">What that's worth</h4>
      <div className="trio">
        {stakes.map((s) => (
          <div className="stat" key={s}>
            <dt>£{s} a point</dt>
            <dd className={profit >= 0 ? "pos" : "neg"}>{money(profit * s)}</dd>
            <small>since April</small>
          </div>
        ))}
      </div>
      <p className="note" style={{ textAlign: "center" }}>
        What level staking every selection would have returned, before any bookmaker
        restrictions. Past results are not a guide to future returns — the record above
        includes losing months, and it can go the other way.
      </p>
    </>
  );
}

function Curve({ timeline }) {
  if (timeline.length < 2) {
    return <div className="empty">The graph builds as months complete.</div>;
  }
  const W = 320, H = 165, L = 24, R = 14, T = 14, B = 26;
  const pts = timeline.map((d) => d.pts);
  const pMax = Math.max(...pts, 0), pMin = Math.min(...pts, 0);
  const pSpan = pMax - pMin || 1;

  const x = (i) => L + (i / (timeline.length - 1)) * (W - L - R);
  const y = (v) => T + (1 - (v - pMin) / pSpan) * (H - T - B);
  const line = pts.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  const area = `${line} L${x(pts.length - 1).toFixed(1)},${y(pMin)} L${x(0)},${y(pMin)} Z`;
  const last = pts[pts.length - 1];

  return (
    <div className="chartbox">
      <h4>Cumulative points profit</h4>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" height="175" role="img"
        aria-label={`Running profit, currently ${last.toFixed(1)} points`}>
        <defs>
          <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="#A87718" /><stop offset="50%" stopColor="#F7EDBE" />
            <stop offset="100%" stopColor="#D9AE4A" />
          </linearGradient>
          <linearGradient id="f" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#D9AE4A" stopOpacity=".24" />
            <stop offset="100%" stopColor="#D9AE4A" stopOpacity="0" />
          </linearGradient>
        </defs>

        <line x1={L} x2={W - R} y1={y(0)} y2={y(0)} stroke="#33333A" strokeDasharray="3 4" />
        <path d={area} fill="url(#f)" />
        <path d={line} fill="none" stroke="url(#g)" strokeWidth="2.4"
          strokeLinejoin="round" strokeLinecap="round" />

        {timeline.map((d, i) => (
          <g key={d.key}>
            <circle cx={x(i)} cy={y(d.pts)} r="2.6" fill="#F7EDBE" />
            <text x={x(i)} y={H - 8} fill="#77777E" fontSize="8"
              fontFamily="Montserrat" textAnchor="middle" letterSpacing="1">
              {d.label.toUpperCase()}
            </text>
          </g>
        ))}

        <text x={2} y={y(pMax) + 3} fill="#77777E" fontSize="8" fontFamily="JetBrains Mono">
          {pMax.toFixed(0)}
        </text>
      </svg>
    </div>
  );
}

function Proof({ s, who }) {
  if (!s.months.length) return null;
  return (
    <>
      <Divider label="The record" />
      <Curve timeline={s.timeline} />
      <Returns profit={s.profit} />

      {/* Advised vs SP is the best evidence on this page, but only once there
          are enough bets to mean anything. Under this many, a single drifter
          swings it either way and it misleads more than it shows. */}
      {s.liveBets >= SP_PANEL_MIN_BETS && (
        <>
          <div className="duo">
            <div className="stat">
              <dt>Advised price</dt>
              <dd className={s.livePts >= 0 ? "pos" : "neg"}>{fmtSigned(s.livePts)}</dd>
              <small>{s.roi.toFixed(1)}% ROI</small>
            </div>
            <div className="stat">
              <dt>Same bets at SP</dt>
              <dd className={s.spProfit >= 0 ? "pos" : "neg"}>{fmtSigned(s.spProfit)}</dd>
              <small>{s.spRoi.toFixed(1)}% ROI</small>
            </div>
          </div>
          <p className="note" style={{ textAlign: "center" }}>
            Advised prices were on Oddschecker when the tip went out. SP is what the horse
            returned. Both are published so you can judge the gap yourself — these two cover
            tips posted on this page, where the price was timestamped.
          </p>
        </>
      )}

      {s.liveBets >= 10 && (
        <div className="duo" style={{ marginTop: 6 }}>
          <div className="stat">
            <dt>Longest losing run</dt>
            <dd>{s.worstStreak}</dd>
            <small>consecutive losers</small>
          </div>
          <div className="stat">
            <dt>Current run</dt>
            <dd>{s.currentStreak}</dd>
            <small>{s.currentStreak === 0 ? "last bet won" : "since the last winner"}</small>
          </div>
        </div>
      )}

      {s.months.length > 0 && (
        <table className="mtable">
          <thead>
            <tr><th>Month</th><th>Points</th><th>ROI</th></tr>
          </thead>
          <tbody>
            {s.months.map((m) => {
              const roi = m.staked ? (m.profit / m.staked) * 100 : null;
              return (
                <tr key={m.key}>
                  <td>{monthName(m.key)}</td>
                  <td className={m.profit >= 0 ? "pos" : "neg"}>{fmtSigned(m.profit)}</td>
                  <td className={roi === null ? "" : roi >= 0 ? "pos" : "neg"}>
                    {roi === null ? "—" : roi.toFixed(1) + "%"}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      <p className="note" style={{ textAlign: "center" }}>
        {priorNote(who)}
      </p>
    </>
  );
}

/* A multiple reads as one bet with its legs listed inside it, rather than as
   several tips. The line count and total stake are spelled out because "1pt
   Lucky 15" means 15 points to a lot of people and 1 point to others. */
function MultipleTip({ tip }) {
  const settled = tip.result && tip.result !== "pending";
  const pts = settled ? settlePoints(tip) : 0;
  const type = BET_TYPES[tip.betType];
  const legs = tip.legs || [];

  return (
    <article className={`tip multi ${tip.result || "pending"}`}>
      <div className="body">
        <div className="multihead">
          <h3 className="horse">{type ? type.label.toUpperCase() : "MULTIPLE"}</h3>
          <span className="chip">{describeBet(tip.betType, tip.stake, tip.eachWay)}</span>
        </div>

        <ol className="legs">
          {legs.map((l, i) => (
            <li key={i} className={l.result || "pending"}>
              <span className="legwhen">{l.time}{l.course ? ` ${l.course}` : ""}</span>
              <span className="leghorse">{l.horse}</span>
              <span className="legprice">{l.price}</span>
              {settled && l.result && l.result !== "pending" && (
                <span className={`legflag ${l.result}`}>{l.result}</span>
              )}
            </li>
          ))}
        </ol>

        {tip.writeup && <p className="writeup">{tip.writeup}</p>}

        {settled && (
          <>
            <div className={`flag ${tip.result}`}>{tip.result} · {fmtPts(pts)}</div>
            {tip.verdict && <p className="verdict"><span>After the race</span>{tip.verdict}</p>}
          </>
        )}
      </div>
    </article>
  );
}

/* An ante-post bet leads with the race it's for, not the time — nobody cares
   that a Gold Cup bet was advised at 14:20 on a Tuesday in November. */
function AnteTip({ tip }) {
  const settled = tip.result && tip.result !== "pending";
  const pts = settled ? settlePoints(tip) : 0;

  return (
    <article className={`tip ante ${tip.result || "pending"}`}>
      <div className="body">
        <div className="antehead">
          <span className="anteevent">{tip.event}</span>
          {tip.eventDate && <span className="antedate">{tip.eventDate}</span>}
        </div>
        <h3 className="horse">{tip.horse}</h3>
        <div className="meta">
          <span className="price">{tip.price}</span>
          <span className="chip">{tip.stake} pt{tip.betType === "ew" ? " e/w" : " win"}</span>
          {tip.betType === "ew" && <span className="chip">{tip.placeTerms} odds</span>}
          {tip.book && <span className="chip">{tip.book}</span>}
          {settled && tip.sp && <span className="chip">SP {tip.sp}</span>}
        </div>
        {tip.writeup && <p className="writeup">{tip.writeup}</p>}
        {settled ? (
          <>
            <div className={`flag ${tip.result}`}>{tip.result} · {fmtPts(pts)}</div>
            {tip.verdict && <p className="verdict"><span>After the race</span>{tip.verdict}</p>}
          </>
        ) : (
          <div className="flag open">Still standing · advised {shortDate(tip.advised || "")}</div>
        )}
      </div>
    </article>
  );
}

function Tip({ tip }) {
  if (isMultiple(tip)) return <MultipleTip tip={tip} />;
  if (isAntePost(tip)) return <AnteTip tip={tip} />;
  const settled = tip.result && tip.result !== "pending";
  const pts = settled ? settlePoints(tip) : 0;
  return (
    <article className={`tip ${tip.result || "pending"}`}>
      <div className="rail">
        <div className="rtime">{tip.time}</div>
        <div className="rcourse">{tip.course}</div>
      </div>
      <div className="body">
        <h3 className="horse">{tip.horse}</h3>
        <div className="meta">
          <span className="price">{tip.price}</span>
          <span className="chip">{tip.stake} pt{tip.betType === "ew" ? " e/w" : " win"}</span>
          {tip.betType === "ew" && <span className="chip">{tip.placeTerms} odds</span>}
          {settled && tip.sp && <span className="chip">SP {tip.sp}</span>}
        </div>
        {/* Prices move. Rather than showing a stale one, send people somewhere
            that's always current — and only while the bet is still live. */}
        {tip.oddscheckerUrl && !settled && (
          <a className="checkprice" href={tip.oddscheckerUrl}
            target="_blank" rel="noopener noreferrer">
            Check the current price <span aria-hidden="true">›</span>
          </a>
        )}
        {tip.writeup && <p className="writeup">{tip.writeup}</p>}
        {settled && (
          <>
            <div className={`flag ${tip.result}`}>{tip.result} · {fmtPts(pts)}</div>
            {tip.verdict && (
              <p className="verdict"><span>After the race</span>{tip.verdict}</p>
            )}
          </>
        )}
      </div>
    </article>
  );
}

/* Countdown to the next publish slot — a reason to come back tonight. */
function useCountdown() {
  const [txt, setTxt] = useState("");
  useEffect(() => {
    const tick = () => {
      const now = new Date();
      // Current London wall-clock time, wherever the reader happens to be.
      const parts = new Intl.DateTimeFormat("en-GB", {
        timeZone: LONDON, hour: "2-digit", minute: "2-digit", hour12: false,
      }).formatToParts(now);
      const nowH = +parts.find((p) => p.type === "hour").value;
      const nowM = +parts.find((p) => p.type === "minute").value;
      const minsNow = nowH * 60 + nowM;
      const target = PUBLISH_HOUR * 60;
      const minsLeft = target > minsNow ? target - minsNow : 1440 - minsNow + target;
      setTxt(`${Math.floor(minsLeft / 60)}h ${String(minsLeft % 60).padStart(2, "0")}m`);
    };
    tick();
    const id = setInterval(tick, 30000);
    return () => clearInterval(id);
  }, []);
  return txt;
}

function InstallBar() {
  const [prompt, setPrompt] = useState(null);
  const [hidden, setHidden] = useState(false);
  const standalone =
    window.matchMedia?.("(display-mode: standalone)").matches || window.navigator.standalone;
  const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);

  useEffect(() => {
    const h = (e) => { e.preventDefault(); setPrompt(e); };
    window.addEventListener("beforeinstallprompt", h);
    return () => window.removeEventListener("beforeinstallprompt", h);
  }, []);

  if (hidden || standalone || (!prompt && !isIOS)) return null;

  return (
    <div className="bar">
      <p>
        <b>Add to your home screen</b> — opens straight to the day's card, no browser,
        {isIOS ? " via Share then Add to Home Screen." : " one tap to install."}
      </p>
      {prompt && (
        <button className="btn" style={{ padding: "9px 12px" }}
          onClick={() => { prompt.prompt(); setHidden(true); }}>Add</button>
      )}
      <button className="x" aria-label="Dismiss" onClick={() => setHidden(true)}>×</button>
    </div>
  );
}

/* ------------------------------- PUBLIC -------------------------------- */

function TipGroup({ tips, showNames }) {
  if (!showNames) return tips.map((t) => <Tip key={t.id} tip={t} />);
  const groups = TIPSTERS
    .map((ts) => ({ ts, list: tips.filter((t) => (t.tipster || "lewis") === ts.id) }))
    .filter((g) => g.list.length);
  return groups.map((g) => (
    <div key={g.ts.id}>
      <h3 className="byline">{g.ts.name}'s tips</h3>
      {g.list.map((t) => <Tip key={t.id} tip={t} />)}
    </div>
  ));
}

function PublicView({ days }) {
  const [open, setOpen] = useState(null);
  const [who, setWho] = useState("all");
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [signupErr, setSignupErr] = useState("");
  const [signingUp, setSigningUp] = useState(false);
  const countdown = useCountdown();

  const subscribe = async () => {
    if (!email.includes("@")) return setSignupErr("Enter a valid email address.");
    setSigningUp(true);
    setSignupErr("");
    try {
      const r = await fetch("/api/subscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      const j = await r.json().catch(() => ({}));
      if (r.ok) setSent(true);
      else setSignupErr(j.error || "Couldn't sign you up. Try again shortly.");
    } catch {
      setSignupErr("Couldn't sign you up. Check your connection.");
    }
    setSigningUp(false);
  };

  const keys = Object.keys(days).sort().reverse();
  const today = todayISO();

  // The card on show is the soonest one that hasn't run — today's while its
  // races are still pending, otherwise the next day posted. Picking the
  // earliest date instead files tomorrow's card under Previous Days.
  const upcoming = keys.filter((k) => k >= today).sort();
  const hasPending = (k) => days[k].tips.some(
    (t) => !isAntePost(t) && (!t.result || t.result === "pending"));
  const liveKey = upcoming.find(hasPending) || upcoming[upcoming.length - 1] || null;

  // Anything posted beyond the live card — rare, but it must never disappear.
  const ahead = keys.filter((k) => liveKey && k > liveKey).sort();
  const past = keys.filter((k) => k !== liveKey && !ahead.includes(k));
  const s = useMemo(() => summarise(days, who), [days, who]);

  // Tips for a day, filtered to the selected tipster. Ante-post bets are
  // excluded — they stand on their own, not on any day's card.
  const mine = (t) => who === "all" || (t.tipster || "lewis") === who;
  const tipsFor = (iso) => days[iso].tips.filter((t) => mine(t) && !isAntePost(t));

  // Every ante-post bet, newest advised first. Open ones lead; settled ones
  // stay so the section is a record rather than just a to-do list.
  const antePost = keys
    .flatMap((k) => days[k].tips.filter((t) => mine(t) && isAntePost(t))
      .map((t) => ({ ...t, advised: k })))
    .sort((a, b) => b.advised.localeCompare(a.advised));
  const openAnte = antePost.filter((t) => !t.result || t.result === "pending");
  const settledAnte = antePost.filter((t) => t.result && t.result !== "pending");
  const openStake = openAnte.reduce(
    (a, t) => a + (parseFloat(t.stake) || 0) * (t.betType === "ew" ? 2 : 1), 0);

  const dayPts = (iso) =>
    tipsFor(iso).filter((t) => t.result !== "pending")
      .reduce((a, t) => a + settlePoints(t), 0);

  return (
    <>
      <div className="who">
        <button aria-pressed={who === "all"} onClick={() => setWho("all")}>All tips</button>
        {TIPSTERS.map((t) => (
          <button key={t.id} aria-pressed={who === t.id} onClick={() => setWho(t.id)}>
            {t.name}
          </button>
        ))}
      </div>

      <dl className="board" style={{ gridTemplateColumns: "1fr 1fr" }}>
        <div><dt>Points</dt>
          <dd className={s.profit >= 0 ? "pos" : "neg"}>{fmtSigned(s.profit)}</dd></div>
        <div><dt>ROI</dt>
          <dd className={s.combinedRoi >= 0 ? "pos" : "neg"}>
            {s.combinedRoi.toFixed(1)}%</dd></div>
      </dl>
      <p className="since">
        {who === "all"
          ? <>Every horse racing bet since Hooves &amp; Hounds began · April 2026</>
          : PRIOR_BY_TIPSTER[who]?.isHNH === false
            ? <>{tipsterName(who)}'s own record · April 2026 to date<br />
                <span className="flag-sep">Joined Hooves &amp; Hounds 19 August</span></>
            : <>Every horse racing bet from {tipsterName(who)}</>}
      </p>
      <p className="intro">
        Two or three horse racing selections, posted free the evening before racing,
        with the reasoning behind each one. Every bet settled and published — winners and losers.
      </p>

      <InstallBar />

      <Divider label={liveKey ? "The card" : "Next card"} />

      {liveKey && tipsFor(liveKey).length ? (
        <>
          <h2 className="daytitle">{longDate(liveKey)}</h2>
          <div className="posted">Published {stamp(days[liveKey].publishedAt)}</div>
          <TipGroup tips={tipsFor(liveKey)} showNames={who === "all"} />
          <ShareRow iso={liveKey} day={{ ...days[liveKey], tips: tipsFor(liveKey) }} summary={s} />
        </>
      ) : (
        <div className="empty">
          Nothing up yet.<br />
          Next card lands in <span className="count">{countdown}</span>
        </div>
      )}

      <Proof s={s} who={who} />

      {antePost.length > 0 && (
        <>
          <Divider label="Ante-post" />
          {openAnte.length > 0 && (
            <p className="anteintro">
              {openAnte.length} bet{openAnte.length === 1 ? "" : "s"} still standing
              · {openStake.toFixed(2)} pts committed. These settle when the race is run,
              so they don't appear in the figures above until then.
            </p>
          )}
          {openAnte.map((t) => <Tip key={t.id} tip={t} />)}
          {settledAnte.length > 0 && (
            <>
              <h4 className="subhead">Settled ante-post</h4>
              {settledAnte.map((t) => <Tip key={t.id} tip={t} />)}
            </>
          )}
        </>
      )}

      {ahead.filter((k) => tipsFor(k).length).length > 0 && (
        <>
          <Divider label="Also posted" />
          {ahead.filter((k) => tipsFor(k).length).map((k) => (
            <div key={k}>
              <h2 className="daytitle">{longDate(k)}</h2>
              <div className="posted">Published {stamp(days[k].publishedAt)}</div>
              <TipGroup tips={tipsFor(k)} showNames={who === "all"} />
              <ShareRow iso={k} day={{ ...days[k], tips: tipsFor(k) }} summary={s} />
            </div>
          ))}
        </>
      )}

      {past.filter((k) => tipsFor(k).length).length > 0 && (
        <>
          <Divider label="Previous days" />
          {past.filter((k) => tipsFor(k).length).map((k) => {
            const pts = dayPts(k);
            const pending = tipsFor(k).some((t) => t.result === "pending");
            return (
              <div key={k}>
                <button className="arow" onClick={() => setOpen(open === k ? null : k)}
                  aria-expanded={open === k}>
                  <span><b>{shortDate(k)}</b>
                    <small>{tipsFor(k).length} selections</small></span>
                  <em className={pending ? "" : pts >= 0 ? "pos" : "neg"}>
                    {pending ? "—" : fmtPts(pts)}
                  </em>
                </button>
                {open === k && (
                  <div style={{ marginBottom: 16 }}>
                    <TipGroup tips={tipsFor(k)} showNames={who === "all"} />
                    <ShareRow iso={k} day={{ ...days[k], tips: tipsFor(k) }} summary={s} />
                  </div>
                )}
              </div>
            );
          })}
        </>
      )}

      <div className="mail">
        <h3>Straight to your inbox</h3>
        <p>Every selection, emailed the night before racing. Free, no catch.</p>
        {sent ? (
          <p style={{ color: "var(--gold)", margin: 0 }}>
            You're on the list. First email lands tomorrow evening.
          </p>
        ) : (
          <>
            <div className="mailrow">
              <input type="email" value={email} placeholder="you@email.com"
                onChange={(e) => setEmail(e.target.value)} aria-label="Email address"
                onKeyDown={(e) => e.key === "Enter" && subscribe()} />
              <button className="btn" onClick={subscribe} disabled={signingUp}>
                {signingUp ? "…" : "Join"}
              </button>
            </div>
            {signupErr && <p className="note" style={{ color: "var(--loss)" }}>{signupErr}</p>}
            <p className="note" style={{ marginBottom: 0 }}>
              Free, and you can unsubscribe from any email. 18+ only.
            </p>
          </>
        )}
      </div>

      <a className="tracker" href="https://tracker.hoovesnhounds.com"
        target="_blank" rel="noopener noreferrer">
        <span className="tracker-line">Want to track your own bets?</span>
        <span className="tracker-url">tracker.hoovesnhounds.com &rsaquo;</span>
      </a>

      <p className="foot">
        Horses by HNH — part of Hooves &amp; Hounds<br />
        18+ only. Tips are opinion, not advice. Never stake more than you can afford to lose.<br />
        Prices shown were available at time of publishing. Support at BeGambleAware.org.
      </p>
    </>
  );
}

/* -------------------------------- ADMIN -------------------------------- */

const blankTip = () => ({
  id: Math.random().toString(36).slice(2, 9),
  tipster: "lewis",
  time: "", course: "", horse: "", price: "", sp: "", oddscheckerUrl: "",
  stake: "1", betType: "win", placeTerms: "1/5", writeup: "",
  result: "pending", manualPts: "", verdict: "",
});

const blankLeg = () => ({
  horse: "", course: "", time: "", price: "", sp: "",
  result: "pending", placeTerms: "1/5",
});

const blankAntePost = () => ({
  id: Math.random().toString(36).slice(2, 9),
  kind: "antepost",
  tipster: "lewis",
  horse: "", event: "", eventDate: "", price: "", sp: "", book: "",
  stake: "1", betType: "win", placeTerms: "1/4", writeup: "",
  result: "pending", manualPts: "", verdict: "",
});

const blankMultiple = (type = "double") => ({
  id: Math.random().toString(36).slice(2, 9),
  kind: "multiple",
  tipster: "lewis",
  betType: type,
  stake: "1",
  eachWay: false,
  legs: Array.from({ length: BET_TYPES[type].legs }, blankLeg),
  writeup: "",
  result: "pending",
  manualPts: "",
  verdict: "",
});

function AdminView({ days, save, exit, password }) {
  const [tab, setTab] = useState("post");
  const [date, setDate] = useState(tomorrowISO());
  const [drafts, setDrafts] = useState([blankTip(), blankTip()]);
  const [flash, setFlash] = useState("");
  const [sending, setSending] = useState("");

  useEffect(() => {
    if (days[date]) setDrafts(days[date].tips.map((t) => ({ ...t })));
  }, [date]); // eslint-disable-line

  const set = (i, k, v) => setDrafts((d) => d.map((t, n) => (n === i ? { ...t, [k]: v } : t)));

  // Changing bet type resizes the legs, keeping whatever's already typed.
  const setBetType = (i, type) => setDrafts((d) => d.map((t, n) => {
    if (n !== i) return t;
    const want = BET_TYPES[type].legs;
    const legs = Array.from({ length: want }, (_, j) => t.legs?.[j] || blankLeg());
    return { ...t, betType: type, legs };
  }));

  const setLeg = (i, legIdx, k, v) => setDrafts((d) => d.map((t, n) => {
    if (n !== i) return t;
    return { ...t, legs: t.legs.map((l, j) => (j === legIdx ? { ...l, [k]: v } : l)) };
  }));

  // A leg settled in the Settle tab, which also re-derives the bet's result.
  const patchLeg = async (iso, id, legIdx, field, value) => {
    const updated = days[iso].tips.map((t) => {
      if (t.id !== id) return t;
      const legs = t.legs.map((l, j) => (j === legIdx ? { ...l, [field]: value } : l));
      const next = { ...t, legs };
      const result = derivedResult(next);
      return { ...next, result,
        ...(result !== "pending" && !next.settledAt
          ? { settledAt: new Date().toISOString() } : {}) };
    });
    const next = { ...days, [iso]: { ...days[iso], tips: updated } };
    await save(next);

    if (field !== "result" || value === "pending") return;
    const wasPending = days[iso].tips.some((t) => t.result === "pending");
    const nowSettled = !updated.some((t) => t.result === "pending");
    if (wasPending && nowSettled) await sendResults(iso, next);
  };

  const publish = async () => {
    const clean = drafts.filter((t) => {
      if (isMultiple(t)) return (t.legs || []).every((l) => l.horse.trim() && l.price.trim());
      if (isAntePost(t)) return t.horse.trim() && t.event.trim();
      return t.horse.trim() && t.course.trim();
    });
    if (!clean.length) {
      return setFlash("Add a horse and course, or fill in every leg of the multiple.");
    }
    await save({
      ...days,
      [date]: { publishedAt: days[date]?.publishedAt || Date.now(), tips: clean },
    });
    setFlash(`Published — ${clean.length} selections for ${shortDate(date)}.`);

    try {
      const res = await notify({
        type: "card", date, showTipster: TIPSTERS.length > 1,
        tips: clean.map((t) => (isMultiple(t) ? {
          kind: "multiple",
          label: describeBet(t.betType, t.stake, t.eachWay).toUpperCase(),
          summary: `${lineCount(t.betType)} lines`,
          legs: (t.legs || []).map((l) => ({
            horse: l.horse, time: l.time, course: l.course, price: l.price,
          })),
          writeup: t.writeup,
          tipster: tipsterName(t.tipster),
        } : {
          horse: t.horse, time: t.time, course: t.course, price: t.price,
          stake: t.stake, betType: t.betType, writeup: t.writeup,
          tipster: tipsterName(t.tipster),
        })),
      }, password);
      const t = res.telegram || {};
      const e = res.email || {};
      const tg = t.sent ? `Telegram ${t.sent}/${t.of}` : `Telegram: ${t.skipped || t.error || "not sent"}`;
      const ml = e.sent ? "email sent" : `email: ${e.skipped || e.error || "not sent"}`;
      setFlash(`Published ${clean.length} selections — ${tg}, ${ml}.${
        t.failed ? ` Channel errors: ${t.failed.join("; ")}` : ""}`);
    } catch (e) {
      setFlash(`Published, but Telegram failed: ${e.message}`);
    }
  };

  const patch = async (iso, id, field, value) => {
    const target = days[iso].tips.find((t) => t.id === id);
    const stampSettled = field === "result" && value !== "pending";
    const updated = days[iso].tips.map((t) => (t.id === id
      ? { ...t, [field]: value, ...(stampSettled ? { settledAt: new Date().toISOString() } : {}) }
      : t));
    const next = { ...days, [iso]: { ...days[iso], tips: updated } };
    await save(next);

    // Announce the moment the day's last pending tip is settled — one clean
    // post, fired once. Editing an SP afterwards won't re-send, and settling
    // an ante-post bet never triggers a day's results.
    if (field !== "result" || value === "pending" || isAntePost(target)) return;
    const daily = (t) => !isAntePost(t);
    const wasPending = days[iso].tips.filter(daily).some((t) => t.result === "pending");
    const nowSettled = !updated.filter(daily).some((t) => t.result === "pending");
    if (wasPending && nowSettled) await sendResults(iso, next);
  };

  const settleRest = async (iso) => {
    await save({
      ...days,
      [iso]: {
        ...days[iso],
        tips: days[iso].tips.map((t) => (t.result === "pending" ? { ...t, result: "lost" } : t)),
      },
    });
  };

  // Results go out on a button rather than automatically — settling happens
  // across an afternoon, and one clean post beats four dribbled ones.
  const sendResults = async (iso, snapshot) => {
    const source = snapshot || days;
    setSending(iso);
    try {
      const tips = source[iso].tips.filter((t) => !isAntePost(t));
      if (!tips.length) { setSending(""); return; }
      const dayPts = tips.reduce((a, t) => a + settlePoints(t), 0);
      const summary = summarise(source, "all");
      const running = summary.profit;

      // The month this day belongs to, as the combined H&H figure — carried-over
      // months plus everything settled here.
      const key = iso.slice(0, 7);
      const row = summary.months.find((m) => m.key === key);
      const month = row ? { label: monthName(key).split(" ")[0], points: row.profit } : null;

      const res = await notify({
        type: "results", date: iso, dayPts, running, month,
        tips: tips.map((t) => ({
          horse: isMultiple(t) ? BET_TYPES[t.betType]?.label : t.horse,
          result: t.result,
        })),
      }, password);
      const t = res.telegram || {};
      setFlash(`Results for ${shortDate(iso)} — sent to ${t.sent || 0} of ${t.of || 0} channels.${
        t.failed ? ` Failed: ${t.failed.join("; ")}` : ""}`);
    } catch (e) {
      setFlash(`Telegram failed: ${e.message}`);
    }
    setSending("");
  };

  // Remove a single tip. If it was the last one on that day, the day goes too,
  // rather than leaving an empty card on the public page.
  const removeTip = async (iso, id) => {
    const tip = days[iso].tips.find((t) => t.id === id);
    if (!window.confirm(`Delete ${tip?.horse || "this selection"}? This can't be undone.`)) return;

    const remaining = days[iso].tips.filter((t) => t.id !== id);
    const next = { ...days };
    if (remaining.length) next[iso] = { ...days[iso], tips: remaining };
    else delete next[iso];

    await save(next);
    setFlash(remaining.length
      ? `Deleted — ${remaining.length} selection${remaining.length === 1 ? "" : "s"} left on ${shortDate(iso)}.`
      : `Deleted — nothing left on ${shortDate(iso)}, day removed.`);
  };

  // Every open ante-post bet, whenever it was advised. The recent-days list
  // would never surface a Gold Cup bet placed in November.
  const openAnte = Object.keys(days).sort().reverse().flatMap((iso) =>
    days[iso].tips.filter((t) => isAntePost(t) && (!t.result || t.result === "pending"))
      .map((t) => ({ iso, tip: t })));

  const pendingDays = Object.keys(days).filter((k) =>
    days[k].tips.some((t) => t.result === "pending"));
  // Show the last week regardless of state, so a note can be added after settling.
  const recent = Object.keys(days).sort().reverse().slice(0, 7);

  return (
    <>
      <div className="seg" style={{ margin: "20px 0" }}>
        <button aria-pressed={tab === "post"} onClick={() => setTab("post")}>Post tips</button>
        <button aria-pressed={tab === "settle"} onClick={() => setTab("settle")}>
          Settle{pendingDays.length ? ` (${pendingDays.length})` : ""}
        </button>
        <button aria-pressed={tab === "dogs"} onClick={() => setTab("dogs")}>Dogs</button>
        <button onClick={exit}>Exit</button>
      </div>

      {tab === "dogs" && <GreyhoundAdmin password={password} />}

      {tab === "post" && (
        <>
          <div className="field">
            <label htmlFor="raceday">Race day</label>
            <input id="raceday" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </div>

          {drafts.map((t, i) => (isAntePost(t) ? (
            <div className="card" key={t.id}>
              <h4>Ante-post {i + 1}</h4>
              <div className="field"><label>Tipster</label>
                <select value={t.tipster || "lewis"} onChange={(e) => set(i, "tipster", e.target.value)}>
                  {TIPSTERS.map((ts) => <option key={ts.id} value={ts.id}>{ts.name}</option>)}
                </select></div>
              <div className="field"><label>Race / event</label>
                <input value={t.event} placeholder="Cheltenham Gold Cup"
                  onChange={(e) => set(i, "event", e.target.value)} /></div>
              <div className="field"><label>When (optional)</label>
                <input value={t.eventDate} placeholder="March 2027"
                  onChange={(e) => set(i, "eventDate", e.target.value)} /></div>
              <div className="field"><label>Horse</label>
                <input value={t.horse} onChange={(e) => set(i, "horse", e.target.value)} /></div>
              <div className="grid3">
                <div className="field"><label>Price</label>
                  <input value={t.price} placeholder="16/1"
                    onChange={(e) => set(i, "price", e.target.value)} /></div>
                <div className="field"><label>Stake</label>
                  <input value={t.stake} inputMode="decimal"
                    onChange={(e) => set(i, "stake", e.target.value)} /></div>
                <div className="field"><label>Bet</label>
                  <select value={t.betType} onChange={(e) => set(i, "betType", e.target.value)}>
                    <option value="win">Win</option><option value="ew">Each-way</option>
                  </select></div>
              </div>
              {t.betType === "ew" && (
                <div className="field"><label>Place terms</label>
                  <select value={t.placeTerms} onChange={(e) => set(i, "placeTerms", e.target.value)}>
                    <option>1/5</option><option>1/4</option><option>1/2</option>
                  </select></div>
              )}
              <div className="field"><label>Available at</label>
                <input value={t.book} placeholder="Bet365"
                  onChange={(e) => set(i, "book", e.target.value)} /></div>
              <div className="field"><label>Why it wins</label>
                <textarea value={t.writeup} onChange={(e) => set(i, "writeup", e.target.value)} /></div>
              <p className="note">
                Ante-post bets stand until the race is run. They appear in their own section
                and only enter the record once settled.
              </p>
              <button className="btn flat" onClick={() => setDrafts(drafts.filter((_, n) => n !== i))}>
                Remove
              </button>
            </div>
          ) : isMultiple(t) ? (
            <div className="card" key={t.id}>
              <h4>Multiple {i + 1}</h4>
              <div className="field"><label>Tipster</label>
                <select value={t.tipster || "lewis"} onChange={(e) => set(i, "tipster", e.target.value)}>
                  {TIPSTERS.map((ts) => <option key={ts.id} value={ts.id}>{ts.name}</option>)}
                </select></div>
              <div className="grid2">
                <div className="field"><label>Bet</label>
                  <select value={t.betType} onChange={(e) => setBetType(i, e.target.value)}>
                    {Object.keys(BET_TYPES).filter((k) => k !== "single").map((k) => (
                      <option key={k} value={k}>{BET_TYPES[k].label}</option>
                    ))}
                  </select></div>
                <div className="field"><label>Points per line</label>
                  <input value={t.stake} inputMode="decimal"
                    onChange={(e) => set(i, "stake", e.target.value)} /></div>
              </div>
              <div className="field">
                <label>Each-way</label>
                <div className="seg">
                  <button aria-pressed={!t.eachWay} onClick={() => set(i, "eachWay", false)}>Win only</button>
                  <button aria-pressed={!!t.eachWay} onClick={() => set(i, "eachWay", true)}>Each-way</button>
                </div>
              </div>
              <p className="note" style={{ color: "var(--gold)", marginTop: 0 }}>
                {describeBet(t.betType, t.stake, t.eachWay)}
              </p>

              {t.legs.map((l, j) => (
                <div className="legcard" key={j}>
                  <div className="leglabel">Selection {j + 1}</div>
                  <div className="grid3">
                    <div className="field"><label>Time</label>
                      <input value={l.time} placeholder="14:20"
                        onChange={(e) => setLeg(i, j, "time", e.target.value)} /></div>
                    <div className="field"><label>Course</label>
                      <input value={l.course} placeholder="Newbury"
                        onChange={(e) => setLeg(i, j, "course", e.target.value)} /></div>
                    <div className="field"><label>Price</label>
                      <input value={l.price} placeholder="7/2"
                        onChange={(e) => setLeg(i, j, "price", e.target.value)} /></div>
                  </div>
                  <div className="field"><label>Horse</label>
                    <input value={l.horse}
                      onChange={(e) => setLeg(i, j, "horse", e.target.value)} /></div>
                  {t.eachWay && (
                    <div className="field"><label>Place terms</label>
                      <select value={l.placeTerms}
                        onChange={(e) => setLeg(i, j, "placeTerms", e.target.value)}>
                        <option>1/5</option><option>1/4</option><option>1/2</option>
                      </select></div>
                  )}
                </div>
              ))}

              <div className="field"><label>Why it wins</label>
                <textarea value={t.writeup}
                  onChange={(e) => set(i, "writeup", e.target.value)} /></div>
              <button className="btn flat" onClick={() => setDrafts(drafts.filter((_, n) => n !== i))}>
                Remove
              </button>
            </div>
          ) : (
            <div className="card" key={t.id}>
              <h4>Selection {i + 1}</h4>
              <div className="field"><label>Tipster</label>
                <select value={t.tipster || "lewis"}
                  onChange={(e) => set(i, "tipster", e.target.value)}>
                  {TIPSTERS.map((ts) => <option key={ts.id} value={ts.id}>{ts.name}</option>)}
                </select></div>
              <div className="grid2">
                <div className="field"><label>Time</label>
                  <input value={t.time} placeholder="14:20" onChange={(e) => set(i, "time", e.target.value)} /></div>
                <div className="field"><label>Course</label>
                  <input value={t.course} placeholder="Newbury" onChange={(e) => set(i, "course", e.target.value)} /></div>
              </div>
              <div className="field"><label>Horse</label>
                <input value={t.horse} onChange={(e) => set(i, "horse", e.target.value)} /></div>
              <div className="grid3">
                <div className="field"><label>Price</label>
                  <input value={t.price} placeholder="7/2" onChange={(e) => set(i, "price", e.target.value)} /></div>
                <div className="field"><label>Stake</label>
                  <input value={t.stake} inputMode="decimal" onChange={(e) => set(i, "stake", e.target.value)} /></div>
                <div className="field"><label>Bet</label>
                  <select value={t.betType} onChange={(e) => set(i, "betType", e.target.value)}>
                    <option value="win">Win</option><option value="ew">Each-way</option>
                  </select></div>
              </div>
              {t.betType === "ew" && (
                <div className="field"><label>Place terms</label>
                  <select value={t.placeTerms} onChange={(e) => set(i, "placeTerms", e.target.value)}>
                    <option>1/5</option><option>1/4</option><option>1/2</option>
                  </select></div>
              )}
              <div className="field"><label>Oddschecker link</label>
                <input value={t.oddscheckerUrl} placeholder="https://oddschecker.com/…"
                  onChange={(e) => set(i, "oddscheckerUrl", e.target.value)} /></div>
              <div className="field"><label>Why it wins</label>
                <textarea value={t.writeup} onChange={(e) => set(i, "writeup", e.target.value)} /></div>
              {drafts.length > 1 && (
                <button className="btn flat" onClick={() => setDrafts(drafts.filter((_, n) => n !== i))}>
                  Remove
                </button>
              )}
            </div>
          )))}

          <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
            <button className="btn flat" onClick={() => setDrafts([...drafts, blankTip()])}>
              Add single
            </button>
            <button className="btn flat" onClick={() => setDrafts([...drafts, blankMultiple()])}>
              Add multiple
            </button>
            <button className="btn flat" onClick={() => setDrafts([...drafts, blankAntePost()])}>
              Add ante-post
            </button>
            <button className="btn" style={{ flex: 1 }} onClick={publish}>Publish</button>
          </div>
          {flash && <p className="note" style={{ color: "var(--gold)" }}>{flash}</p>}
        </>
      )}

      {tab === "settle" && openAnte.length > 0 && (
        <>
          <Divider label="Ante-post standing" />
          {openAnte.map(({ iso, tip: t }) => (
            <div className="card" key={t.id}>
              <h4>{tipsterName(t.tipster)} · {t.event} — {t.horse}</h4>
              <p className="gha-hint" style={{ marginTop: -8 }}>
                {t.price} · {t.stake}pt {t.betType === "ew" ? "e/w" : "win"} ·
                advised {shortDate(iso)}
              </p>
              <div className="seg" style={{ marginBottom: 12 }}>
                {["won", "placed", "lost", "void"].map((r) => (
                  <button key={r} aria-pressed={t.result === r}
                    onClick={() => patch(iso, t.id, "result", r)}>{r}</button>
                ))}
              </div>
              <div className="grid2">
                <div className="field"><label>Returned SP</label>
                  <input value={t.sp} placeholder="14/1"
                    onChange={(e) => patch(iso, t.id, "sp", e.target.value)} /></div>
                <div className="field"><label>Final points (override)</label>
                  <input value={t.manualPts} inputMode="decimal"
                    placeholder={`auto: ${settlePointsAuto(t).toFixed(2)}`}
                    onChange={(e) => patch(iso, t.id, "manualPts", e.target.value)} /></div>
              </div>
              <div className="field">
                <label>Post-race note</label>
                <textarea value={t.verdict} style={{ minHeight: 70 }}
                  onChange={(e) => patch(iso, t.id, "verdict", e.target.value)} />
              </div>
              <button className="btn flat" style={{ width: "100%", color: "var(--loss)" }}
                onClick={() => removeTip(iso, t.id)}>Delete this bet</button>
            </div>
          ))}
        </>
      )}

      {tab === "settle" && (
        recent.length === 0 ? (
          <div className="empty">Nothing posted yet.</div>
        ) : (
          recent.map((iso) => (
            <div key={iso}>
              <Divider label={shortDate(iso)} />
              {days[iso].tips.filter((t) => !isAntePost(t)).map((t) => (isMultiple(t) ? (
                <div className="card" key={t.id}>
                  <h4>
                    {tipsterName(t.tipster)} · {BET_TYPES[t.betType]?.label}
                    {t.eachWay ? " e/w" : ""}
                  </h4>
                  <p className="gha-hint" style={{ marginTop: -8 }}>
                    {describeBet(t.betType, t.stake, t.eachWay)}
                  </p>

                  {t.legs.map((l, j) => (
                    <div className="legcard" key={j}>
                      <div className="leglabel">
                        {j + 1}. {l.horse || "—"} · {l.time} {l.course} · {l.price}
                      </div>
                      <div className="seg" style={{ marginBottom: 10 }}>
                        {["won", "placed", "lost", "void"].map((r) => (
                          <button key={r} aria-pressed={l.result === r}
                            onClick={() => patchLeg(iso, t.id, j, "result", r)}>{r}</button>
                        ))}
                      </div>
                      <div className="field" style={{ marginBottom: 0 }}>
                        <label>Returned SP</label>
                        <input value={l.sp || ""} placeholder="9/2"
                          onChange={(e) => patchLeg(iso, t.id, j, "sp", e.target.value)} />
                      </div>
                    </div>
                  ))}

                  <div className="field"><label>Final points (override)</label>
                    <input value={t.manualPts} inputMode="decimal"
                      placeholder={`auto: ${settlePointsAuto(t).toFixed(2)}`}
                      onChange={(e) => patch(iso, t.id, "manualPts", e.target.value)} /></div>
                  <div className="field">
                    <label>Post-race note</label>
                    <textarea value={t.verdict} style={{ minHeight: 70 }}
                      onChange={(e) => patch(iso, t.id, "verdict", e.target.value)} />
                  </div>
                  <p className="note">
                    {(() => {
                      const r = multipleResult(t, "advised");
                      if (r.error) return r.error;
                      if (r.pending) return `${r.lines} lines · ${r.staked} pts staked · not all legs settled yet.`;
                      return `${r.lines} lines · ${r.staked} pts staked · returns ${r.returned.toFixed(2)} `
                        + `= ${r.profit >= 0 ? "+" : ""}${r.profit.toFixed(2)} pts`;
                    })()}
                  </p>
                  <button className="btn flat" style={{ width: "100%", color: "var(--loss)" }}
                    onClick={() => removeTip(iso, t.id)}>
                    Delete this multiple
                  </button>
                </div>
              ) : (
                <div className="card" key={t.id}>
                  <h4>{tipsterName(t.tipster)} · {t.time} {t.course} — {t.horse}</h4>
                  <div className="seg" style={{ marginBottom: 12 }}>
                    {["won", "placed", "lost", "void"].map((r) => (
                      <button key={r} aria-pressed={t.result === r}
                        onClick={() => patch(iso, t.id, "result", r)}>{r}</button>
                    ))}
                  </div>
                  <div className="grid2">
                    <div className="field"><label>Returned SP</label>
                      <input value={t.sp} placeholder="9/2"
                        onChange={(e) => patch(iso, t.id, "sp", e.target.value)} /></div>
                    <div className="field"><label>Final points (override)</label>
                      <input value={t.manualPts} inputMode="decimal"
                        placeholder={`auto: ${settlePointsAuto(t).toFixed(2)}`}
                        onChange={(e) => patch(iso, t.id, "manualPts", e.target.value)} /></div>
                  </div>
                  <div className="field">
                    <label>Post-race note</label>
                    <textarea value={t.verdict} style={{ minHeight: 70 }}
                      placeholder="Why it won, or what went wrong"
                      onChange={(e) => patch(iso, t.id, "verdict", e.target.value)} />
                  </div>
                  <p className="note">
                    Auto-calculated from {t.price || "—"} at {t.stake} pt
                    {t.betType === "ew" ? " each-way" : " win"} = <b>{settlePointsAuto(t).toFixed(2)} pts</b>.
                    Only fill the override in when the real return differs — a Rule 4, BOG, or a dead
                    heat — and enter the <b>finished points figure</b>, not the deduction.
                    {t.manualPts !== "" && t.manualPts !== null && t.manualPts !== undefined && (
                      <><br /><b style={{ color: "var(--gold)" }}>
                        Override active: this bet is counting as {(parseFloat(t.manualPts) || 0).toFixed(2)} pts,
                        not {settlePointsAuto(t).toFixed(2)}.
                      </b></>
                    )}
                  </p>
                  <button className="btn flat" style={{ width: "100%", color: "var(--loss)" }}
                    onClick={() => removeTip(iso, t.id)}>
                    Delete this selection
                  </button>
                </div>
              )))}
              {pendingDays.includes(iso) && (
                <button className="btn flat" style={{ width: "100%" }} onClick={() => settleRest(iso)}>
                  Settle the rest as losers
                </button>
              )}
              {!pendingDays.includes(iso) && (
                <button className="btn flat" style={{ width: "100%" }}
                  disabled={sending === iso}
                  onClick={() => sendResults(iso)}>
                  {sending === iso ? "Sending…" : "Re-send results to Telegram"}
                </button>
              )}
            </div>
          ))
        )
      )}
    </>
  );
}

/* ================================= APP =================================== */

export default function App() {
  const [days, setDays] = useState({});
  const [loading, setLoading] = useState(true);
  const [admin, setAdmin] = useState(false);
  const [asking, setAsking] = useState(false);
  const [pin, setPin] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [sport, setSport] = useSport("horses");

  useEffect(() => {
    store.read()
      .then((d) => setDays(d))
      .catch(() => setError("Couldn't load the tips. Refresh to try again."))
      .finally(() => setLoading(false));
  }, []);

  // Optimistic update, then persist. If the write fails the banner says so
  // rather than silently losing the tip.
  const save = useCallback(async (next) => {
    const previous = days;
    setDays(next);
    try {
      await store.write(next, password);
      setError("");
    } catch (e) {
      setDays(previous);
      setError(e.message === "unauthorised"
        ? "Session expired — unlock again."
        : "Couldn't save. Check your connection and retry.");
    }
  }, [days, password]);

  return (
    <div className="hnh">
      <style>{CSS}</style>
      <div className="wrap">
        <header className="top">
          <Logo sport={admin ? "horses" : sport} />
          {!admin && <button className="adminbtn" onClick={() => setAsking(!asking)}>Admin</button>}
        </header>

        {asking && !admin && (
          <div className="card">
            <div className="field">
              <label htmlFor="pin">Enter PIN</label>
              <input id="pin" type="password" inputMode="numeric" value={pin}
                onChange={(e) => setPin(e.target.value)} />
            </div>
            <button className="btn" onClick={async () => {
              const ok = await store.verify(pin);
              if (ok) { setPassword(pin); setAdmin(true); setAsking(false); setPin(""); setError(""); }
              else { setPin(""); setError("Wrong password."); }
            }}>Unlock</button>
            
          </div>
        )}

        {error && <p className="alert">{error}</p>}

        {loading ? <div className="empty" style={{ marginTop: 24 }}>Loading…</div>
          : admin ? (
            <AdminView days={days} save={save} exit={() => setAdmin(false)} password={password} />
          ) : (
            <>
              <SportToggle sport={sport} onChange={setSport} />
              {sport === "horses" ? <PublicView days={days} /> : <GreyhoundTips />}
            </>
          )}
      </div>
    </div>
  );
}
