import { useEffect, useMemo, useState } from 'react';
import { fetchAll, flattenTips, groupTotals, combineFreeRecord } from './api.js';
import { summarise, cumulativeByDay, tipReturn, transparency, oddsAsFraction,
         fmtPts, fmtDate, fmtMonth, formatOdds } from './points.js';
import { shareTip, shareResult } from './shareCard.js';
import { WHOP_URL, TELEGRAM_URL, GROUP_PRICE, GROUP_PITCH,
         GROUP_TEAM, PROMO_CODE, PROMO_TEXT } from './config.js';

/* ---------------------------------------------------------------- graph */

function PointsGraph({ series }) {
  if (series.length < 2) {
    return <p className="ghg-empty">The graph appears once a few days are settled.</p>;
  }

  const W = 320;
  const H = 120;
  const pad = 6;
  const values = series.map((d) => d.cumulative);
  const min = Math.min(0, ...values);
  const max = Math.max(0, ...values);
  const span = max - min || 1;

  const x = (i) => pad + (i / (series.length - 1)) * (W - pad * 2);
  const y = (v) => H - pad - ((v - min) / span) * (H - pad * 2);

  const line = series.map((d, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(d.cumulative).toFixed(1)}`).join(' ');
  const area = `${line} L${x(series.length - 1).toFixed(1)},${y(min)} L${x(0).toFixed(1)},${y(min)} Z`;
  const last = series[series.length - 1];

  return (
    <svg className="ghg-graph" viewBox={`0 0 ${W} ${H}`} role="img"
         aria-label={`Cumulative points, currently ${fmtPts(last.cumulative)}`}>
      <defs>
        <linearGradient id="ghg-line" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stopColor="#A87718" />
          <stop offset="50%" stopColor="#F7EDBE" />
          <stop offset="100%" stopColor="#D9AE4A" />
        </linearGradient>
        <linearGradient id="ghg-area" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#D9AE4A" stopOpacity=".24" />
          <stop offset="100%" stopColor="#D9AE4A" stopOpacity="0" />
        </linearGradient>
      </defs>
      <line x1={pad} y1={y(0)} x2={W - pad} y2={y(0)} stroke="#33333A" strokeDasharray="3 4" />
      <path d={area} fill="url(#ghg-area)" />
      <path d={line} fill="none" stroke="url(#ghg-line)" strokeWidth="2.5"
            strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={x(series.length - 1)} cy={y(last.cumulative)} r="4" fill="#F7EDBE" />
    </svg>
  );
}

/* ------------------------------------------------------------ tip card */

function TipCard({ tip, price, featured, resultShare }) {
  const [shareState, setShareState] = useState('idle');
  const settled = tip.result && tip.result !== 'pending';
  const pts = tipReturn(tip, price);

  async function handleShare() {
    setShareState('working');
    try {
      const outcome = resultShare
        ? await shareResult(tip, resultShare)
        : await shareTip(tip);
      setShareState(outcome === 'shared' ? 'idle' : 'saved');
    } catch {
      setShareState('failed');
    }
  }

  return (
    <article className={`ghg-tip${featured ? ' ghg-tip--featured' : ''}`}>
      <div className="ghg-tip-head">
        <span className="ghg-meta">{tip.track} · {tip.time}</span>
        {settled && (
          <span className={`ghg-result ghg-result--${tip.result}`}>
            {tip.result === 'win' ? `WON ${fmtPts(pts)}` :
             tip.result === 'void' ? 'VOID' : `LOST ${fmtPts(pts)}`}
          </span>
        )}
        {!settled && <span className="ghg-result ghg-result--pending">RUNNING</span>}
      </div>

      <div className="ghg-tip-body">
        <span className="ghg-trap" aria-label={`Trap ${tip.trap}`}>{tip.trap}</span>
        <div>
          <h3 className="ghg-dog">{tip.dog}</h3>
          <p className="ghg-terms">
            {formatOdds(price === 'sp' && tip.oddsSP ? tip.oddsSP : tip.oddsAdvised)}
            {tip.book && price !== 'sp' && <span className="ghg-book"> {tip.book}</span>}
            <span className="ghg-dot">·</span>
            {tip.points} pt{Number(tip.points) === 1 ? '' : 's'}
          </p>
        </div>
      </div>

      {tip.notes && <p className="ghg-notes">{tip.notes}</p>}

      {tip.postedAt && (
        <p className="ghg-stamp">
          Posted {new Date(tip.postedAt).toLocaleString('en-GB', {
            day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
          })}
        </p>
      )}

      {(featured || resultShare) && (
        <button className="ghg-share" onClick={handleShare} disabled={shareState === 'working'}>
          {shareState === 'working' ? 'Building image…' :
           shareState === 'saved' ? 'Image saved' :
           shareState === 'failed' ? 'Try again' :
           resultShare ? 'Share result' : 'Share this tip'}
        </button>
      )}
    </article>
  );
}

/* ------------------------------------------------------- members' row */

function MembersRow({ members, date }) {
  if (!members) return null;
  const up = members.points > 0;

  return (
    <div className="ghg-members">
      <div className="ghg-members-lock" aria-hidden="true">
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2">
          <rect x="4" y="10" width="16" height="10" rx="2" />
          <path d="M8 10V7a4 4 0 0 1 8 0v3" />
        </svg>
      </div>
      <div className="ghg-members-copy">
        <p className="ghg-members-line">
          Members also got <strong>{members.tips}</strong> selection{members.tips === 1 ? '' : 's'} on {fmtDate(date)}
        </p>
        <p className={`ghg-members-pts${up ? ' is-up' : ''}`}>{fmtPts(members.points)} pts</p>
      </div>
      <a className="ghg-members-cta" href={WHOP_URL} target="_blank" rel="noopener noreferrer">Join</a>
    </div>
  );
}

/* ------------------------------------------------------------- section */

export default function GreyhoundTips() {
  const [days, setDays] = useState([]);
  const [months, setMonths] = useState([]);
  const [freeMonths, setFreeMonths] = useState([]);
  const [status, setStatus] = useState('loading');
  const [price, setPrice] = useState('advised');
  const [email, setEmail] = useState('');
  const [signup, setSignup] = useState({ state: 'idle', msg: '' });

  const subscribe = async () => {
    if (!email.includes('@')) return setSignup({ state: 'error', msg: 'Enter a valid email address.' });
    setSignup({ state: 'working', msg: '' });
    try {
      const r = await fetch('/api/subscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      });
      const j = await r.json().catch(() => ({}));
      if (r.ok) setSignup({ state: 'done', msg: '' });
      else setSignup({ state: 'error', msg: j.error || "Couldn't sign you up. Try again shortly." });
    } catch {
      setSignup({ state: 'error', msg: "Couldn't sign you up. Check your connection." });
    }
  };

  useEffect(() => {
    fetchAll()
      .then(({ days: d, months: m, freeMonths: f }) => {
        setDays(d); setMonths(m); setFreeMonths(f); setStatus('ready');
      })
      .catch(() => setStatus('error'));
  }, []);

  const tips = useMemo(() => flattenTips(days), [days]);
  const stats = useMemo(() => summarise(tips, price), [tips, price]);
  const series = useMemo(() => cumulativeByDay(tips, price), [tips, price]);
  const trans = useMemo(() => transparency(tips, price), [tips, price]);
  const group = useMemo(() => groupTotals(months), [months]);
  const freeRecord = useMemo(
    () => combineFreeRecord(tips, freeMonths, (t) => tipReturn(t, price)),
    [tips, freeMonths, price]
  );

  const latestDay = days.length ? days[days.length - 1] : null;
  const featured = tips[0] || null;
  const rest = tips.slice(1, 15);

  // Most recent settled tip, plus the totals its result card needs.
  const lastSettled = tips.find((t) => t.result && t.result !== 'pending');
  const resultTotals = lastSettled
    ? { profit: tipReturn(lastSettled, 'advised'), running: summarise(tips, 'advised').profit }
    : null;

  if (status !== 'ready') {
    return (
      <section className="ghg" id="greyhounds">
        <style>{css}</style>
        <p className="ghg-empty">
          {status === 'loading' ? 'Loading tips…' : "Tips didn't load. Refresh the page to try again."}
        </p>
      </section>
    );
  }

  return (
    <section className="ghg" id="greyhounds">
      <style>{css}</style>

      <header className="ghg-head">
        <p className="ghg-eyebrow">FREE DAILY</p>
        <p className="ghg-sub">One free selection a day. Every result settled here, win or lose.</p>
      </header>

      {featured ? (
        <>
          <TipCard tip={featured} price={price} featured />
          {latestDay && <MembersRow members={latestDay.members} date={latestDay.date} />}
        </>
      ) : (
        <p className="ghg-empty">The next selection will appear here.</p>
      )}

      <a className="ghg-telegram" href={TELEGRAM_URL} target="_blank" rel="noopener noreferrer">
        <span className="ghg-telegram-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor">
            <path d="M21.9 4.3 18.6 19.9c-.2 1.1-.9 1.4-1.8.9l-5-3.7-2.4 2.3c-.3.3-.5.5-1 .5l.4-5.1 9.3-8.4c.4-.4-.1-.6-.6-.2L6.1 13.3l-4.9-1.5c-1.1-.3-1.1-1 .2-1.5l19.2-7.4c.9-.3 1.6.2 1.3 1.4Z"/>
          </svg>
        </span>
        <span className="ghg-telegram-copy">
          <strong>Get the tip on Telegram</strong>
          <span>Free channel · every selection as it's posted</span>
        </span>
        <span className="ghg-telegram-arrow" aria-hidden="true">→</span>
      </a>

      <div className="ghg-record">
        <div className="ghg-record-head">
          <h3 className="ghg-record-title">FREE TIPS RECORD</h3>
          <div className="ghg-toggle" role="group" aria-label="Price basis">
            <button className={price === 'advised' ? 'is-on' : ''} onClick={() => setPrice('advised')}>Advised</button>
            <button className={price === 'sp' ? 'is-on' : ''} onClick={() => setPrice('sp')}>SP</button>
          </div>
        </div>

        <div className="ghg-headline">
          <span className="ghg-headline-label">SINCE LAUNCH</span>
          <span className={`ghg-headline-figure${freeRecord.total > 0 ? ' is-up' : freeRecord.total < 0 ? ' is-down' : ''}`}>
            {fmtPts(freeRecord.total)}
          </span>
          <span className="ghg-headline-unit">POINTS</span>
        </div>

        <div className="ghg-stats">
          <div><span className={`ghg-stat${stats.profit > 0 ? ' is-up' : stats.profit < 0 ? ' is-down' : ''}`}>{fmtPts(stats.profit)}</span><span className="ghg-stat-label">POINTS</span></div>
          <div><span className="ghg-stat">{stats.roi.toFixed(1)}%</span><span className="ghg-stat-label">ROI</span></div>
          <div><span className="ghg-stat">{stats.wins}/{stats.bets}</span><span className="ghg-stat-label">WINNERS</span></div>
          <div><span className="ghg-stat">{stats.strikeRate.toFixed(0)}%</span><span className="ghg-stat-label">STRIKE</span></div>
        </div>

        <PointsGraph series={series} />

        {freeRecord.rows.length > 0 && (
          <table className="ghg-months ghg-months--free">
            <tbody>
              {[...freeRecord.rows].reverse().map((r) => (
                <tr key={r.month}>
                  <th scope="row">{fmtMonth(r.month)}</th>
                  <td className={r.points > 0 ? 'is-up' : r.points < 0 ? 'is-down' : ''}>
                    {fmtPts(r.points)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {freeMonths.length > 0 && (
          <p className="ghg-gap">
            Free greyhound tips ran April to June. They paused in July when the Exclusive Group
            launched, and are starting again now — so the months above stop at June by design,
            not by omission.
          </p>
        )}

        {trans.bets > 0 && trans.bets < 100 && (
          <p className="ghg-sample">
            {trans.bets} settled bet{trans.bets === 1 ? '' : 's'} so far — too few to judge anyone on.
            Come back at 100 and hold me to it.
          </p>
        )}
      </div>

      <div className="ghg-honest">
        <h3 className="ghg-record-title">THE BITS NOBODY ADVERTISES</h3>
        <dl className="ghg-honest-grid">
          <div>
            <dt>Worst drawdown</dt>
            <dd>−{trans.worstDrawdown.toFixed(2)} pts</dd>
          </div>
          <div>
            <dt>Longest losing run</dt>
            <dd>{trans.longestLosingRun} bet{trans.longestLosingRun === 1 ? '' : 's'}</dd>
          </div>
          <div>
            <dt>Average price</dt>
            <dd>{oddsAsFraction(trans.avgOdds)}</dd>
          </div>
          <div>
            <dt>Average winner</dt>
            <dd>{oddsAsFraction(trans.avgWinnerOdds)}</dd>
          </div>
        </dl>
        <p className="ghg-honest-note">
          Drawdown is the worst peak-to-trough fall the record has been through. Every tipster has one.
          If you follow along, expect to sit through something like it.
        </p>
      </div>

      <div className="ghg-staking">
        <h3 className="ghg-record-title">HOW THE STAKING WORKS</h3>
        <ul className="ghg-staking-list">
          <li><strong>1 point</strong> is one unit of your betting bank, whatever you decide that's worth.</li>
          <li>A <strong>50 point bank</strong> is the sensible minimum. On £2 a point that's £100.</li>
          <li>Results are settled to the <strong>advised price</strong> shown when the tip went out,
              at the bookmaker named. Flip the toggle above to see the same record at SP.</li>
          <li>Never chase a price that's gone. If it's shorter than advised, it's your call whether the bet still stands.</li>
        </ul>
      </div>

      {rest.length > 0 && (
        <div className="ghg-history">
          <h3 className="ghg-record-title">RECENT</h3>
          {rest.map((tip) => (
            <TipCard
              key={tip.id}
              tip={tip}
              price={price}
              resultShare={lastSettled && tip.id === lastSettled.id ? resultTotals : null}
            />
          ))}
        </div>
      )}

      {months.length > 0 && (
        <div className="ghg-group">
          <h3 className="ghg-record-title">EXCLUSIVE GROUP RECORD</h3>
          <p className="ghg-group-intro">
            The paid group's full record since launch — every month, including the bad ones.
          </p>

          <div className="ghg-group-headline">
            <span className={`ghg-headline-figure${group.points > 0 ? ' is-up' : group.points < 0 ? ' is-down' : ''}`}>
              {fmtPts(group.points)}
            </span>
            <span className="ghg-headline-unit">POINTS ACROSS {group.months} MONTH{group.months === 1 ? '' : 'S'}</span>
          </div>

          <table className="ghg-months">
            <thead>
              <tr><th>Month</th><th>Tips</th><th>Won</th><th>ROI</th><th>Points</th></tr>
            </thead>
            <tbody>
              {[...months].reverse().map((m) => {
                const roi = m.staked ? (m.points / m.staked) * 100 : null;
                return (
                  <tr key={m.month}>
                    <th scope="row">{fmtMonth(m.month)}</th>
                    <td>{m.tips || '—'}</td>
                    <td>{m.winners || '—'}</td>
                    <td>{roi === null ? '—' : `${roi.toFixed(1)}%`}</td>
                    <td className={m.points > 0 ? 'is-up' : m.points < 0 ? 'is-down' : ''}>
                      {fmtPts(m.points)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot>
              <tr>
                <th scope="row">Total</th>
                <td>{group.tips || '—'}</td>
                <td>{group.winners || '—'}</td>
                <td>{group.staked ? `${group.roi.toFixed(1)}%` : '—'}</td>
                <td className={group.points > 0 ? 'is-up' : group.points < 0 ? 'is-down' : ''}>
                  {fmtPts(group.points)}
                </td>
              </tr>
            </tfoot>
          </table>

          <div className="ghg-stats ghg-stats--group">
            <div>
              <span className="ghg-stat">{group.tips}</span>
              <span className="ghg-stat-label">BETS</span>
            </div>
            <div>
              <span className="ghg-stat">{group.winners}</span>
              <span className="ghg-stat-label">WINNERS</span>
            </div>
            <div>
              <span className="ghg-stat">{group.strike.toFixed(1)}%</span>
              <span className="ghg-stat-label">STRIKE</span>
            </div>
            <div>
              <span className={`ghg-stat${group.roi > 0 ? ' is-up' : group.roi < 0 ? ' is-down' : ''}`}>
                {group.roi.toFixed(1)}%
              </span>
              <span className="ghg-stat-label">ROI</span>
            </div>
          </div>

          <h4 className="ghg-worth-head">WHAT THAT'S WORTH</h4>
          <div className="ghg-worth">
            {[5, 10, 20].map((v) => (
              <div key={v}>
                <span className="ghg-worth-stake">£{v} a point</span>
                <span className={`ghg-worth-sum${group.points >= 0 ? ' is-up' : ' is-down'}`}>
                  {group.points < 0 ? '−£' : '£'}
                  {Math.abs(group.points * v).toLocaleString('en-GB', {
                    minimumFractionDigits: 2, maximumFractionDigits: 2,
                  })}
                </span>
              </div>
            ))}
          </div>

          <p className="ghg-group-note">
            What level staking every group selection would have returned since launch, before
            any bookmaker restrictions. Settled to advised prices, same basis as the free record
            above. {group.tips} bets is still a short record — a strong start, not proof of a
            long-term edge. Past results are not a guide to future returns.
          </p>
        </div>
      )}

      {GROUP_TEAM && <p className="ghg-team">{GROUP_TEAM}</p>}

      <a className="ghg-upgrade" href={WHOP_URL} target="_blank" rel="noopener noreferrer">
        <span className="ghg-upgrade-eyebrow">EXCLUSIVE GREYHOUND GROUP</span>
        <span className="ghg-upgrade-line">{GROUP_PITCH}</span>
        <span className="ghg-upgrade-price">{GROUP_PRICE}</span>
      </a>

      {PROMO_CODE && (
        <div className="ghg-promo">
          <span className="ghg-promo-text">{PROMO_TEXT}</span>
          <span className="ghg-promo-code">{PROMO_CODE}</span>
          <span className="ghg-promo-note">Enter at checkout · new members only</span>
        </div>
      )}

      <div className="ghg-signup">
        <h3 className="ghg-record-title">FREE HORSE RACING TIPS BY EMAIL</h3>
        <p className="ghg-signup-copy">
          Greyhound tips go out on Telegram — too close to the off for email to land in time.
          The email list carries the horse racing selections, free, the evening before racing.
        </p>
        {signup.state === 'done' ? (
          <p className="ghg-signup-done">You're on the list. First email lands tomorrow evening.</p>
        ) : (
          <>
            <div className="ghg-signup-row">
              <input type="email" value={email} placeholder="you@email.com"
                aria-label="Email address"
                onChange={(e) => setEmail(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && subscribe()} />
              <button onClick={subscribe} disabled={signup.state === 'working'}>
                {signup.state === 'working' ? '…' : 'Join'}
              </button>
            </div>
            {signup.msg && <p className="ghg-signup-err">{signup.msg}</p>}
            <p className="ghg-signup-small">Free, and you can unsubscribe from any email. 18+ only.</p>
          </>
        )}
      </div>

      <a className="ghg-tracker" href="https://tracker.hoovesnhounds.com"
         target="_blank" rel="noopener noreferrer">
        <span className="ghg-tracker-line">Want to track your own bets?</span>
        <span className="ghg-tracker-url">tracker.hoovesnhounds.com &rsaquo;</span>
      </a>

      <p className="ghg-legal">
        18+ · Tips are opinion, not advice. Never stake more than you can afford to lose.
        Help and support at <a href="https://www.begambleaware.org" target="_blank" rel="noopener noreferrer">BeGambleAware.org</a>.
      </p>
    </section>
  );
}

/* ---------------------------------------------------------------- style */

const css = `
/* Inherits the tokens from .hnh — --metal, --gold, --panel, --line, --win, --loss. */
.ghg{padding:0;}
.ghg-head{text-align:center;margin:20px 0}
.ghg-eyebrow{font-size:9px;letter-spacing:.30em;text-indent:.30em;text-transform:uppercase;
  color:var(--muted);margin:0 0 8px;font-weight:600}
.ghg-sub{font-size:12.5px;color:var(--body);margin:12px 0 0;line-height:1.7}

.ghg-tip{display:block;background:var(--panel);border:1px solid var(--line);
  padding:14px 15px;margin-bottom:12px}
.ghg-tip--featured{position:relative}
.ghg-tip--featured::before{content:"";position:absolute;top:-1px;left:0;right:0;height:2px;background:var(--metal)}
.ghg-tip-head{display:flex;justify-content:space-between;align-items:center;gap:10px;margin-bottom:12px}
.ghg-meta{font-size:9px;letter-spacing:.13em;color:var(--muted);font-weight:600;text-transform:uppercase}
.ghg-result{font-size:9px;letter-spacing:.18em;text-indent:.18em;font-weight:700;padding:5px 10px;
  text-transform:uppercase;border:1px solid;white-space:nowrap}
.ghg-result--win{color:var(--win);border-color:var(--win)}
.ghg-result--lose{color:var(--loss);border-color:var(--loss)}
.ghg-result--void,.ghg-result--pending{color:var(--gold);border-color:var(--gold-lo)}
.ghg-tip-body{display:flex;align-items:center;gap:15px}
.ghg-trap{flex:0 0 58px;height:58px;background:var(--panel2);border:1px solid var(--line);
  display:flex;align-items:center;justify-content:center;font-family:'JetBrains Mono';
  font-size:24px;font-weight:600;color:var(--gold)}
.ghg-dog{font-weight:700;font-size:16px;letter-spacing:.10em;text-indent:.10em;
  text-transform:uppercase;margin:0;line-height:1.3}
.ghg-terms{font-family:'JetBrains Mono';font-size:11px;color:var(--muted);margin:8px 0 0;
  letter-spacing:.04em}
.ghg-book{color:var(--muted);opacity:.75}
.ghg-dot{margin:0 7px;opacity:.45}
.ghg-notes{font-size:13.5px;color:var(--body);line-height:1.65;margin:13px 0 0;
  padding:11px 12px;background:var(--panel2);border-left:2px solid var(--gold-lo);white-space:pre-wrap}
.ghg-stamp{font-family:'JetBrains Mono';font-size:10px;color:var(--muted);margin:12px 0 0;letter-spacing:.04em}
.ghg-share{margin-top:14px;width:100%;background:none;border:1px solid var(--line);
  color:var(--muted);padding:11px 6px;font-size:9px;font-weight:600;letter-spacing:.14em;
  text-transform:uppercase;font-family:inherit}
.ghg-share:hover{color:var(--gold);border-color:var(--gold-lo)}
.ghg-share:disabled{opacity:.5}

.ghg-members{display:flex;align-items:center;gap:13px;padding:13px 14px;margin-bottom:14px;
  background:var(--panel);border:1px solid var(--line);border-left:2px solid var(--gold-lo)}
.ghg-members-lock{color:var(--gold);flex:0 0 auto;display:flex;opacity:.8}
.ghg-members-copy{flex:1;min-width:0}
.ghg-members-line{font-size:11.5px;color:var(--body);margin:0;line-height:1.5}
.ghg-members-line strong{color:var(--text);font-weight:600}
.ghg-members-pts{font-family:'JetBrains Mono';font-size:16px;font-weight:600;margin:4px 0 0;color:var(--muted)}
.ghg-members-pts.is-up{color:var(--win)}
.ghg-members-cta{flex:0 0 auto;font-size:9px;letter-spacing:.16em;text-indent:.16em;font-weight:700;
  color:#111;background:var(--metal);padding:9px 13px;text-decoration:none;text-transform:uppercase}

.ghg-telegram{display:flex;align-items:center;gap:13px;padding:14px;margin-bottom:14px;
  background:var(--panel);border:1px solid var(--line);text-decoration:none;position:relative}
.ghg-telegram::before{content:"";position:absolute;left:-1px;top:0;bottom:0;width:2px;background:var(--metal)}
.ghg-telegram-icon{flex:0 0 auto;color:var(--gold);display:flex}
.ghg-telegram-copy{flex:1;min-width:0;display:flex;flex-direction:column;gap:4px}
.ghg-telegram-copy strong{font-size:12px;color:var(--text);font-weight:600;letter-spacing:.10em;text-transform:uppercase}
.ghg-telegram-copy span{font-size:11px;color:var(--muted);font-weight:400;letter-spacing:.03em}
.ghg-telegram-arrow{flex:0 0 auto;color:var(--gold);font-size:16px}

.ghg-record,.ghg-honest,.ghg-staking,.ghg-group,.ghg-history{margin-top:26px}
.ghg-record-head{display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;gap:12px}
.ghg-record-title{font-size:9px;font-weight:600;letter-spacing:.20em;text-indent:.20em;
  text-transform:uppercase;color:var(--muted);margin:0}
.ghg-toggle{display:flex;gap:6px}
.ghg-toggle button{background:var(--panel2);border:1px solid var(--line);color:var(--muted);
  padding:8px 12px;font-size:9px;font-weight:600;letter-spacing:.12em;text-transform:uppercase;
  font-family:inherit}
.ghg-toggle button.is-on{background:var(--metal);border-color:transparent;color:#111;font-weight:700}

.ghg-headline{text-align:center;border:1px solid var(--line);background:var(--panel);
  padding:18px 12px;position:relative}
.ghg-headline::before{content:"";position:absolute;top:-1px;left:0;right:0;height:2px;background:var(--metal)}
.ghg-headline-label{display:block;font-size:8px;font-weight:600;letter-spacing:.20em;
  text-transform:uppercase;color:var(--muted)}
.ghg-headline-figure{display:block;font-family:'JetBrains Mono';font-size:34px;font-weight:600;
  line-height:1.1;margin-top:8px;font-variant-numeric:tabular-nums;color:var(--text)}
.ghg-headline-figure.is-up{color:var(--win)}
.ghg-headline-figure.is-down{color:var(--loss)}
.ghg-headline-unit{display:block;font-size:8px;font-weight:600;letter-spacing:.18em;
  text-transform:uppercase;color:var(--muted);margin-top:7px}

.ghg-stats{display:grid;grid-template-columns:repeat(4,1fr);border:1px solid var(--line);
  border-top:none;background:var(--panel);margin-bottom:14px}
.ghg-stats>div{padding:12px 5px;text-align:center;border-right:1px solid var(--line)}
.ghg-stats>div:last-child{border-right:none}
.ghg-stat{display:block;font-family:'JetBrains Mono';font-weight:600;font-size:15px;
  color:var(--text);font-variant-numeric:tabular-nums}
.ghg-stat.is-up{color:var(--win)}
.ghg-stat.is-down{color:var(--loss)}
.ghg-stat-label{display:block;font-size:8px;letter-spacing:.16em;color:var(--muted);
  margin-top:6px;font-weight:600;text-transform:uppercase}

.ghg-graph{width:100%;height:auto;display:block;border:1px solid var(--line);
  background:var(--panel);padding:10px 8px}
.ghg-sample{font-size:11.5px;color:var(--body);line-height:1.65;margin:12px 0 0;
  padding:11px 12px;background:var(--panel2);border-left:2px solid var(--gold-lo)}

.ghg-months{width:100%;border-collapse:collapse;margin-top:10px}
.ghg-months th,.ghg-months td{font-family:'JetBrains Mono';font-size:12px;text-align:right;
  padding:10px 6px;border-bottom:1px solid var(--line);font-variant-numeric:tabular-nums;color:var(--body)}
.ghg-months thead th{font-family:'Montserrat';font-size:8px;font-weight:600;letter-spacing:.14em;
  text-transform:uppercase;color:var(--muted)}
.ghg-months th:first-child,.ghg-months td:first-child{text-align:left}
.ghg-months tbody th{font-family:'Montserrat';font-size:11px;font-weight:600;letter-spacing:.08em;
  text-transform:uppercase;color:var(--text)}
.ghg-months tfoot th,.ghg-months tfoot td{border-top:1px solid var(--gold-lo);border-bottom:none;
  padding-top:12px;color:var(--text);font-weight:600}
.ghg-months .is-up{color:var(--win)}
.ghg-months .is-down{color:var(--loss)}
.ghg-months--free td{font-weight:600;color:var(--text)}

.ghg-honest-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin:0 0 14px}
.ghg-honest-grid>div{border:1px solid var(--line);background:var(--panel);padding:13px;text-align:center}
.ghg-honest-grid dt{font-size:8px;letter-spacing:.16em;color:var(--muted);font-weight:600;text-transform:uppercase}
.ghg-honest-grid dd{font-family:'JetBrains Mono';font-size:16px;font-weight:600;margin:7px 0 0;color:var(--text)}
.ghg-honest-note,.ghg-group-intro,.ghg-group-note{font-size:11px;color:var(--muted);
  line-height:1.7;margin:12px 0 0;letter-spacing:.03em}
.ghg-staking-list{margin:0;padding-left:17px}
.ghg-staking-list li{font-size:12.5px;color:var(--body);line-height:1.7;margin-bottom:9px}
.ghg-staking-list strong{color:var(--text);font-weight:600}
.ghg-group-headline{text-align:center;padding:14px 0 16px}
.ghg-stats--group{border-top:1px solid var(--line);margin:16px 0 0}
.ghg-gap{font-size:11.5px;color:var(--body);line-height:1.7;margin:14px 0 0;
  padding:11px 12px;background:var(--panel2);border-left:2px solid var(--gold-lo)}
.ghg-worth-head{font-size:9px;font-weight:600;letter-spacing:.20em;text-indent:.20em;
  text-transform:uppercase;color:var(--muted);margin:22px 0 10px;text-align:center}
.ghg-worth{display:grid;grid-template-columns:repeat(3,1fr);gap:8px}
.ghg-worth>div{border:1px solid var(--line);background:var(--panel);padding:13px 4px;text-align:center}
.ghg-worth-stake{display:block;font-size:8px;font-weight:600;letter-spacing:.14em;
  text-transform:uppercase;color:var(--muted)}
.ghg-worth-sum{display:block;font-family:'JetBrains Mono';font-size:15px;font-weight:600;
  margin-top:7px;color:var(--text)}
.ghg-worth-sum.is-up{color:var(--win)}
.ghg-worth-sum.is-down{color:var(--loss)}

.ghg-upgrade{display:block;text-align:center;padding:18px;text-decoration:none;
  background:var(--metal);color:#111;margin-top:26px}
.ghg-upgrade-eyebrow{display:block;font-size:9px;letter-spacing:.20em;text-indent:.20em;
  font-weight:700;opacity:.7;text-transform:uppercase}
.ghg-upgrade-line{display:block;font-size:14px;font-weight:700;margin-top:7px;letter-spacing:.04em;line-height:1.45}
.ghg-upgrade-price{display:block;font-family:'JetBrains Mono';font-size:15px;font-weight:600;
  margin-top:8px;opacity:.85}
.ghg-team{font-size:12.5px;color:var(--body);line-height:1.7;margin:26px 0 0;text-align:center}
.ghg-promo{border:1px dashed rgba(212,175,55,.45);border-top:none;padding:14px;text-align:center}
.ghg-promo-text{display:block;font-size:11px;font-weight:600;letter-spacing:.16em;
  text-transform:uppercase;color:var(--gold)}
.ghg-promo-code{display:inline-block;font-family:'JetBrains Mono';font-size:19px;font-weight:600;
  letter-spacing:.14em;color:var(--text);margin:9px 0 0;padding:7px 14px;
  border:1px solid rgba(212,175,55,.45);background:var(--panel2)}
.ghg-promo-note{display:block;font-size:10px;color:var(--muted);margin-top:9px;letter-spacing:.05em}

.ghg-signup{border:1px solid var(--line);background:var(--panel);padding:18px;margin-top:26px;
  position:relative;text-align:center}
.ghg-signup::before{content:"";position:absolute;top:-1px;left:0;right:0;height:2px;background:var(--metal)}
.ghg-signup-copy{font-size:12.5px;color:var(--body);line-height:1.7;margin:10px 0 14px}
.ghg-signup-row{display:flex;gap:8px}
.ghg-signup-row input{flex:1;min-width:0;background:var(--panel2);border:1px solid var(--line);
  color:var(--text);padding:11px;font-family:inherit;font-size:16px}
.ghg-signup-row button{background:var(--metal);color:#111;border:none;padding:11px 18px;
  font-weight:700;font-size:10px;letter-spacing:.16em;text-transform:uppercase;font-family:inherit}
.ghg-signup-err{font-size:11px;color:var(--loss);margin:10px 0 0}
.ghg-signup-small{font-size:10px;color:var(--muted);margin:10px 0 0;line-height:1.6}
.ghg-signup-done{font-size:13px;color:var(--gold);margin:0}
.ghg-tracker{display:block;text-align:center;border:1px solid var(--line);background:var(--panel);
  padding:16px;margin-top:14px;text-decoration:none;position:relative}
.ghg-tracker::before{content:"";position:absolute;left:-1px;top:0;bottom:0;width:2px;background:var(--metal)}
.ghg-tracker-line{display:block;font-size:13px;color:var(--body)}
.ghg-tracker-url{display:block;font-family:'JetBrains Mono';font-size:12.5px;color:var(--gold);
  margin-top:7px;letter-spacing:.04em}
.ghg-empty{border:1px dashed var(--line);padding:30px 20px;text-align:center;color:var(--muted);
  font-size:13px;line-height:1.8;letter-spacing:.03em;margin:0}
.ghg-legal{font-size:10px;color:var(--muted);line-height:1.9;text-align:center;
  margin:22px 0 0;letter-spacing:.05em}
.ghg-legal a{color:var(--body)}
`;
