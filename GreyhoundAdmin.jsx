import { useEffect, useState } from 'react';
import { fetchAll, flattenTips, postTip, settleTip, setMembersRow,
         setGroupMonth, setFreeMonth } from './api.js';
import { fmtDate, formatOdds } from './points.js';

const tomorrow = () => {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return d.toISOString().slice(0, 10);
};

const blank = () => ({
  date: tomorrow(),
  time: '',
  track: '',
  trap: '',
  dog: '',
  oddsAdvised: '',
  book: '',
  points: '1',
  tipster: 'Lewis', // greyhounds are Lewis only; horses keep the Lewis/Nath dropdown
  notes: '',
});

export default function GreyhoundAdmin({ password = '' }) {
  const token = password;
  const [form, setForm] = useState(blank);
  const [days, setDays] = useState([]);
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);

  const [members, setMembers] = useState({ date: new Date().toISOString().slice(0, 10), tips: '', points: '' });
  const [months, setMonths] = useState([]);
  const [freeMonths, setFreeMonths] = useState([]);
  const [monthForm, setMonthForm] = useState({
    month: new Date().toISOString().slice(0, 7), tips: '', winners: '', staked: '', points: '',
    kind: 'group',
  });

  const load = () => fetchAll()
    .then(({ days: d, months: m, freeMonths: f }) => {
      setDays(d); setMonths(m); setFreeMonths(f);
    })
    .catch(() => setMsg('Could not load tips'));
  useEffect(() => { load(); }, []);

  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });

  async function submit() {
    if (!form.dog || !form.track || !form.trap) {
      setMsg('Dog, track and trap are needed');
      return;
    }
    setBusy(true);
    try {
      await postTip(form, token);
      setForm({ ...blank(), date: form.date });
      setMsg('Tip posted');
      await load();
    } catch (err) {
      setMsg(err.message);
    }
    setBusy(false);
  }

  async function settle(tip, result) {
    setBusy(true);
    try {
      const oddsSP = result === 'win'
        ? window.prompt('SP? (leave blank to use advised)', tip.oddsSP || '') ?? ''
        : '';
      await settleTip(tip.date, tip.id, result, oddsSP, token);
      setMsg('Settled');
      await load();
    } catch (err) {
      setMsg(err.message);
    }
    setBusy(false);
  }

  async function saveMonth() {
    if (!/^\d{4}-\d{2}$/.test(monthForm.month)) {
      setMsg('Month must be YYYY-MM');
      return;
    }
    setBusy(true);
    try {
      const save = monthForm.kind === 'free' ? setFreeMonth : setGroupMonth;
      await save({
        month: monthForm.month,
        tips: Number(monthForm.tips) || 0,
        winners: Number(monthForm.winners) || 0,
        staked: Number(monthForm.staked) || 0,
        points: Number(monthForm.points) || 0,
      }, token);
      setMsg(`${monthForm.month} saved to ${monthForm.kind === 'free' ? 'free tips' : 'group'} record`);
      await load();
    } catch (err) {
      setMsg(err.message);
    }
    setBusy(false);
  }

  async function saveMembers() {
    setBusy(true);
    try {
      await setMembersRow(members.date, {
        tips: Number(members.tips),
        points: Number(members.points),
        settled: true,
      }, token);
      setMsg('Members row saved');
      await load();
    } catch (err) {
      setMsg(err.message);
    }
    setBusy(false);
  }

  const tips = flattenTips(days);
  const pending = tips.filter((t) => !t.result || t.result === 'pending');

  return (
    <div className="gha">
      <style>{css}</style>

      {msg && <p className="gha-msg">{msg}</p>}

      <section className="gha-card">
        <h2>Post a tip</h2>
        <div className="gha-row">
          <label className="gha-field"><span>Date</span>
            <input type="date" value={form.date} onChange={set('date')} /></label>
          <label className="gha-field"><span>Time</span>
            <input type="time" value={form.time} onChange={set('time')} /></label>
        </div>
        <div className="gha-row">
          <label className="gha-field gha-grow"><span>Track</span>
            <input value={form.track} onChange={set('track')} placeholder="Nottingham" /></label>
          <label className="gha-field gha-narrow"><span>Trap</span>
            <input type="number" inputMode="numeric" min="1" max="6" value={form.trap} onChange={set('trap')} /></label>
        </div>
        <label className="gha-field"><span>Dog</span>
          <input value={form.dog} onChange={set('dog')} placeholder="Ballymac Flight" /></label>
        <div className="gha-row">
          <label className="gha-field"><span>Advised odds</span>
            <input value={form.oddsAdvised} onChange={set('oddsAdvised')} placeholder="5/2" /></label>
          <label className="gha-field gha-narrow"><span>Points</span>
            <input type="number" inputMode="decimal" step="0.5" value={form.points} onChange={set('points')} /></label>
        </div>
        <label className="gha-field"><span>Available at</span>
          <input value={form.book} onChange={set('book')} placeholder="Bet365" /></label>
        <label className="gha-field"><span>Note (optional)</span>
          <textarea rows="2" value={form.notes} onChange={set('notes')}
                    placeholder="Best of the early pace, should lead from the boxes." /></label>
        <button className="gha-primary" onClick={submit} disabled={busy}>
          {busy ? 'Working…' : 'Post tip'}
        </button>
      </section>

      <section className="gha-card">
        <h2>Members' row</h2>
        <p className="gha-hint">Aggregate only — this is what shows on the free page under the tip.</p>
        <div className="gha-row">
          <label className="gha-field"><span>Date</span>
            <input type="date" value={members.date}
                   onChange={(e) => setMembers({ ...members, date: e.target.value })} /></label>
          <label className="gha-field gha-narrow"><span>Tips</span>
            <input type="number" inputMode="numeric" value={members.tips}
                   onChange={(e) => setMembers({ ...members, tips: e.target.value })} /></label>
          <label className="gha-field gha-narrow"><span>Points</span>
            <input type="number" inputMode="decimal" step="0.01" value={members.points}
                   onChange={(e) => setMembers({ ...members, points: e.target.value })} /></label>
        </div>
        <button className="gha-primary" onClick={saveMembers} disabled={busy}>Save members' row</button>
      </section>

      <section className="gha-card">
        <h2>Monthly record</h2>
        <p className="gha-hint">
          Backfilled monthly figures. Free months are for history that pre-dates this page —
          a month entered here replaces any tips posted for that month, so nothing double-counts.
          Saving the same month again overwrites it.
        </p>
        <label className="gha-field"><span>Record</span>
          <select value={monthForm.kind} onChange={(e) => setMonthForm({ ...monthForm, kind: e.target.value })}>
            <option value="group">Exclusive Group</option>
            <option value="free">Free tips</option>
          </select></label>
        <div className="gha-row">
          <label className="gha-field"><span>Month</span>
            <input type="month" value={monthForm.month}
                   onChange={(e) => setMonthForm({ ...monthForm, month: e.target.value })} /></label>
          <label className="gha-field gha-narrow"><span>Points</span>
            <input type="number" inputMode="decimal" step="0.01" value={monthForm.points}
                   onChange={(e) => setMonthForm({ ...monthForm, points: e.target.value })} /></label>
        </div>
        <div className="gha-row">
          <label className="gha-field"><span>Tips</span>
            <input type="number" inputMode="numeric" value={monthForm.tips}
                   onChange={(e) => setMonthForm({ ...monthForm, tips: e.target.value })} /></label>
          <label className="gha-field"><span>Winners</span>
            <input type="number" inputMode="numeric" value={monthForm.winners}
                   onChange={(e) => setMonthForm({ ...monthForm, winners: e.target.value })} /></label>
          <label className="gha-field"><span>Staked</span>
            <input type="number" inputMode="decimal" step="0.5" value={monthForm.staked}
                   onChange={(e) => setMonthForm({ ...monthForm, staked: e.target.value })} /></label>
        </div>
        <button className="gha-primary" onClick={saveMonth} disabled={busy}>Save month</button>

        {(monthForm.kind === 'free' ? freeMonths : months).length > 0 && (
          <ul className="gha-months">
            {[...(monthForm.kind === 'free' ? freeMonths : months)].reverse().map((m) => (
              <li key={m.month}>
                <span>{m.month}</span>
                <span>{m.tips ? `${m.tips} tips` : '—'}</span>
                <strong>{(Number(m.points) || 0) > 0 ? '+' : ''}{(Number(m.points) || 0).toFixed(2)} pts</strong>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="gha-card">
        <h2>Settle {pending.length > 0 && <span className="gha-count">{pending.length}</span>}</h2>
        <p className="gha-hint">Settling is final — results can't be edited or deleted afterwards.</p>
        {pending.length === 0 && <p className="gha-hint">Nothing waiting.</p>}
        {pending.map((tip) => (
          <div key={tip.id} className="gha-pending">
            <div>
              <strong>{tip.dog}</strong>
              <span className="gha-sub">
                T{tip.trap} · {tip.track} · {fmtDate(tip.date)} · {formatOdds(tip.oddsAdvised)}
              </span>
            </div>
            <div className="gha-actions">
              <button onClick={() => settle(tip, 'win')} disabled={busy}>Won</button>
              <button onClick={() => settle(tip, 'lose')} disabled={busy}>Lost</button>
              <button onClick={() => settle(tip, 'void')} disabled={busy}>Void</button>
            </div>
          </div>
        ))}
      </section>
    </div>
  );
}

const css = `
.gha{padding:0}
.gha-card{background:var(--panel);border:1px solid var(--line);padding:16px;margin-bottom:14px}
.gha-card h2{font-weight:700;font-size:11px;letter-spacing:.16em;text-indent:.16em;
  text-transform:uppercase;margin:0 0 14px;color:var(--gold);display:flex;align-items:center;gap:8px}
.gha-count{background:var(--panel2);border:1px solid var(--gold-lo);color:var(--gold);
  padding:2px 8px;letter-spacing:0;font-family:'JetBrains Mono';font-size:11px}
.gha-hint{font-size:10.5px;color:var(--muted);margin:-6px 0 14px;line-height:1.6;letter-spacing:.03em}
.gha-row{display:flex;gap:10px}
.gha-field{display:block;margin-bottom:13px;flex:1;min-width:0}
.gha-grow{flex:2}
.gha-narrow{flex:0 0 84px}
.gha-field span{display:block;font-size:9px;font-weight:600;letter-spacing:.16em;text-indent:.16em;
  text-transform:uppercase;color:var(--muted);margin-bottom:6px}
.gha-primary{width:100%;background:var(--metal);color:#111;border:none;padding:13px 18px;
  font-weight:700;font-size:10px;letter-spacing:.18em;text-indent:.18em;text-transform:uppercase;
  font-family:inherit}
.gha-primary:disabled{opacity:.55}
.gha-msg{font-size:11px;color:var(--gold);text-align:center;margin:0 0 14px;letter-spacing:.04em}
.gha-months{list-style:none;margin:16px 0 0;padding:14px 0 0;border-top:1px solid var(--line)}
.gha-months li{display:flex;justify-content:space-between;align-items:center;gap:10px;
  padding:8px 0;font-size:11px;color:var(--muted);letter-spacing:.04em}
.gha-months strong{color:var(--text);font-family:'JetBrains Mono';font-weight:600}
.gha-pending{display:flex;justify-content:space-between;align-items:center;gap:10px;
  padding:12px 0;border-bottom:1px solid var(--line);flex-wrap:wrap}
.gha-pending strong{font-size:13px;display:block;letter-spacing:.06em}
.gha-sub{font-size:10px;color:var(--muted);display:block;margin-top:4px;letter-spacing:.04em}
.gha-actions{display:flex;gap:6px}
.gha-actions button{background:var(--panel2);border:1px solid var(--line);color:var(--muted);
  padding:9px 11px;font-size:9px;font-weight:600;letter-spacing:.12em;text-transform:uppercase;
  font-family:inherit}
.gha-actions button:hover{color:var(--gold);border-color:var(--gold-lo)}
`;
