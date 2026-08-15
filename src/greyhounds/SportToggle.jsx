import { useEffect, useState } from 'react';

/**
 * Segmented Horses / Greyhounds control.
 *
 * Keeps the choice in the URL hash (#horses / #greyhounds) so a shared link
 * opens on the right sport, and remembers the last sport between visits.
 */
export function useSport(defaultSport = 'horses') {
  const [sport, setSport] = useState(() => {
    const fromHash = window.location.hash.replace('#', '');
    if (fromHash === 'horses' || fromHash === 'greyhounds') return fromHash;
    return localStorage.getItem('hnh-sport') || defaultSport;
  });

  useEffect(() => {
    localStorage.setItem('hnh-sport', sport);
    if (window.location.hash.replace('#', '') !== sport) {
      window.history.replaceState(null, '', `#${sport}`);
    }
  }, [sport]);

  useEffect(() => {
    const onHash = () => {
      const next = window.location.hash.replace('#', '');
      if (next === 'horses' || next === 'greyhounds') setSport(next);
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  return [sport, setSport];
}

export default function SportToggle({ sport, onChange }) {
  return (
    <div className="hnh-sport">
      <style>{css}</style>
      <div role="tablist" aria-label="Choose a sport" style={{ display: 'contents' }}>
        <button role="tab" aria-selected={sport === 'horses'} onClick={() => onChange('horses')}>
          Horses
        </button>
        <button role="tab" aria-selected={sport === 'greyhounds'} onClick={() => onChange('greyhounds')}>
          Greyhounds
        </button>
      </div>
    </div>
  );
}

const css = `
.hnh-sport{display:flex;gap:6px;margin:20px 0 4px}
.hnh-sport button{flex:1;background:var(--panel);border:1px solid var(--line);color:var(--muted);
  padding:12px 4px;font-size:10px;font-weight:600;letter-spacing:.18em;text-indent:.18em;
  text-transform:uppercase;font-family:inherit}
.hnh-sport button[aria-selected="true"]{background:var(--metal);border-color:transparent;
  color:#111;font-weight:700}
`;
