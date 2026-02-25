/**
 * @file Shared UI sub-components for admin tabs.
 */
import type { OctantStat, Assertion } from '../geoCore';

export function CompassSVG() {
  return (
    <div className="adm-compass">
      <svg viewBox="0 0 50 50" width="42" height="42">
        <circle cx="25" cy="25" r="22" fill="none" stroke="#2d3440" strokeWidth="1" />
        <text x="25" y="10" textAnchor="middle" fill="#d63031" fontSize="7.5" fontWeight="700">N</text>
        <text x="25" y="45" textAnchor="middle" fill="#00b894" fontSize="7.5" fontWeight="700">S</text>
        <text x="6" y="28" textAnchor="middle" fill="#fdcb6e" fontSize="6.5">W</text>
        <text x="44" y="28" textAnchor="middle" fill="#fdcb6e" fontSize="6.5">E</text>
        <polygon points="25,13 23.5,19 26.5,19" fill="#d63031" />
        <polygon points="25,37 23.5,31 26.5,31" fill="#00b894" />
      </svg>
    </div>
  );
}

export function AssertionsBox({
  title,
  stats,
  assertions,
}: {
  title: string;
  stats: OctantStat[];
  assertions: Assertion[];
}) {
  const allPass = assertions.length > 0 && assertions.every((a) => a.pass);
  return (
    <div className="adm-assertions">
      <h3>{title}</h3>
      <table className="adm-stats-table">
        <thead>
          <tr>
            <th>Octant</th>
            <th>Avg Azimuth</th>
            <th>Avg Suitability</th>
            <th>Cells</th>
          </tr>
        </thead>
        <tbody>
          {stats.map((o) => {
            const cls = o.avg === null ? '' : o.avg > 0.65 ? 'adm-good' : o.avg < 0.35 ? 'adm-bad' : 'adm-mid';
            return (
              <tr key={o.name}>
                <td>{o.name}</td>
                <td>{o.avgAz !== null ? o.avgAz.toFixed(1) + '°' : '—'}</td>
                <td className={`adm-val ${cls}`}>{o.avg !== null ? o.avg.toFixed(4) : '—'}</td>
                <td>{o.count}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <div style={{ marginTop: 10 }}>
        {assertions.map((a, i) => (
          <div key={i} className={`adm-assert-row ${a.pass ? 'adm-assert-pass' : 'adm-assert-fail'}`}>
            <span className="adm-assert-icon">{a.pass ? '✓' : '✗'}</span>
            <span>{a.text}</span>
          </div>
        ))}
        <div className="adm-assert-summary" style={{ color: allPass ? '#00b894' : '#d63031' }}>
          {allPass ? '✓ ALL ASSERTIONS PASSED' : '✗ SOME ASSERTIONS FAILED'}
        </div>
      </div>
    </div>
  );
}
