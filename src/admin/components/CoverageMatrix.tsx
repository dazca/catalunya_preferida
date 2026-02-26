/**
 * @file Municipality × Layer completion matrix.
 * Shows a grid with municipalities as rows and layers as columns,
 * cells coloured by data presence.
 */
import { useMemo, useState } from 'react';
import type { IntegrityReport, IntegrityLayerStats } from '../../utils/dataIntegrity';

interface Props {
  /** codi → nom mapping from municipalities GeoJSON. */
  muniNames: Record<string, string>;
  /** Per-layer: array of codi strings that have data. */
  coverageByLayer: Record<string, string[]>;
  report: IntegrityReport | null;
}

const LAYER_COLS = [
  'votes', 'terrain', 'forest', 'crime', 'rentalPrices',
  'employment', 'internet', 'airQuality', 'climate',
];

const SHORT_LABELS: Record<string, string> = {
  votes: 'Votes', terrain: 'Terr', forest: 'For', crime: 'Crime',
  rentalPrices: 'Rent', employment: 'Empl', internet: 'Net',
  airQuality: 'Air', climate: 'Clim',
};

export default function CoverageMatrix({ muniNames, coverageByLayer, report }: Props) {
  const [search, setSearch] = useState('');
  const [sortCol, setSortCol] = useState<string | null>(null);
  const [sortAsc, setSortAsc] = useState(true);
  const [showOnlyMissing, setShowOnlyMissing] = useState(false);

  // Build sets for fast lookup
  const coverageSets = useMemo(() => {
    const sets: Record<string, Set<string>> = {};
    for (const layer of LAYER_COLS) {
      sets[layer] = new Set(coverageByLayer[layer] ?? []);
    }
    return sets;
  }, [coverageByLayer]);

  // Build municipality rows
  const rows = useMemo(() => {
    const entries = Object.entries(muniNames);
    return entries.map(([codi, nom]) => {
      const presence: Record<string, boolean> = {};
      let presentCount = 0;
      for (const layer of LAYER_COLS) {
        const has = coverageSets[layer]?.has(codi) ?? false;
        presence[layer] = has;
        if (has) presentCount++;
      }
      return { codi, nom, presence, presentCount, missingCount: LAYER_COLS.length - presentCount };
    });
  }, [muniNames, coverageSets]);

  // Filter + sort
  const filtered = useMemo(() => {
    let result = rows;
    if (search) {
      const q = search.toLowerCase();
      result = result.filter((r) => r.nom.toLowerCase().includes(q) || r.codi.includes(q));
    }
    if (showOnlyMissing) {
      result = result.filter((r) => r.missingCount > 0);
    }
    if (sortCol) {
      result = [...result].sort((a, b) => {
        if (sortCol === 'nom') return sortAsc ? a.nom.localeCompare(b.nom) : b.nom.localeCompare(a.nom);
        if (sortCol === 'missing') return sortAsc ? a.missingCount - b.missingCount : b.missingCount - a.missingCount;
        const layerKey = sortCol;
        const aVal = a.presence[layerKey] ? 1 : 0;
        const bVal = b.presence[layerKey] ? 1 : 0;
        return sortAsc ? aVal - bVal : bVal - aVal;
      });
    }
    return result;
  }, [rows, search, showOnlyMissing, sortCol, sortAsc]);

  const handleSort = (col: string) => {
    if (sortCol === col) setSortAsc(!sortAsc);
    else { setSortCol(col); setSortAsc(true); }
  };

  // Layer stats summary
  const layerStats = useMemo((): IntegrityLayerStats[] => report?.layerStats ?? [], [report]);

  return (
    <div className="adm-di-card adm-di-card-wide">
      <h4>Municipality × Layer Completion Matrix</h4>

      {/* Layer stats summary row */}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 8, fontSize: '0.75em' }}>
        {layerStats.filter((s) => LAYER_COLS.includes(s.layer)).map((s) => (
          <span key={s.layer} style={{
            padding: '2px 8px', borderRadius: 4,
            background: s.municipalityCoverage >= 90 ? 'rgba(0,184,148,0.15)' :
              s.municipalityCoverage >= 50 ? 'rgba(253,203,110,0.15)' : 'rgba(214,48,49,0.15)',
            color: s.municipalityCoverage >= 90 ? '#00b894' :
              s.municipalityCoverage >= 50 ? '#fdcb6e' : '#d63031',
          }}>
            {SHORT_LABELS[s.layer]}: {s.municipalityCoverage}% ({s.totalRecords})
            {s.dataYear ? ` [${s.dataYear}]` : ''}
          </span>
        ))}
      </div>

      {/* Controls */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 8, alignItems: 'center' }}>
        <input
          type="text"
          placeholder="Search municipality…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          style={{
            background: '#232730', color: '#e0e0e0', border: '1px solid #2d3440',
            borderRadius: 4, padding: '4px 8px', fontSize: '0.82em', width: 180,
          }}
        />
        <label style={{ fontSize: '0.78em', display: 'flex', alignItems: 'center', gap: 4, color: '#aab1c7' }}>
          <input type="checkbox" checked={showOnlyMissing} onChange={() => setShowOnlyMissing(!showOnlyMissing)} />
          Only missing
        </label>
        <span style={{ fontSize: '0.72em', color: '#8d95ad' }}>
          Showing {filtered.length} / {rows.length}
        </span>
      </div>

      {/* Matrix table */}
      <div style={{ overflowX: 'auto', maxHeight: 400, overflowY: 'auto' }}>
        <table className="adm-stats-table" style={{ width: '100%', fontSize: '0.72em' }}>
          <thead>
            <tr>
              <th
                style={{ position: 'sticky', top: 0, left: 0, background: '#181b21', zIndex: 3, cursor: 'pointer' }}
                onClick={() => handleSort('nom')}
              >
                Municipality {sortCol === 'nom' ? (sortAsc ? '▲' : '▼') : ''}
              </th>
              <th style={{ position: 'sticky', top: 0, background: '#181b21', zIndex: 2 }}>Codi</th>
              {LAYER_COLS.map((col) => (
                <th
                  key={col}
                  style={{ position: 'sticky', top: 0, background: '#181b21', zIndex: 2, cursor: 'pointer', textAlign: 'center' }}
                  onClick={() => handleSort(col)}
                  title={col}
                >
                  {SHORT_LABELS[col]} {sortCol === col ? (sortAsc ? '▲' : '▼') : ''}
                </th>
              ))}
              <th
                style={{ position: 'sticky', top: 0, background: '#181b21', zIndex: 2, cursor: 'pointer', textAlign: 'center' }}
                onClick={() => handleSort('missing')}
              >
                Missing {sortCol === 'missing' ? (sortAsc ? '▲' : '▼') : ''}
              </th>
            </tr>
          </thead>
          <tbody>
            {filtered.slice(0, 200).map((r) => (
              <tr key={r.codi}>
                <td style={{ position: 'sticky', left: 0, background: '#181b21', fontWeight: 500, whiteSpace: 'nowrap' }}>
                  {r.nom}
                </td>
                <td style={{ fontFamily: 'monospace', fontSize: '0.95em', color: '#8d95ad' }}>{r.codi}</td>
                {LAYER_COLS.map((col) => (
                  <td key={col} style={{ textAlign: 'center', padding: 2 }}>
                    <span
                      style={{
                        display: 'inline-block',
                        width: 14, height: 14,
                        borderRadius: 3,
                        background: r.presence[col] ? '#00b894' : '#d63031',
                        opacity: r.presence[col] ? 0.7 : 0.5,
                      }}
                      title={r.presence[col] ? 'present' : 'missing'}
                    />
                  </td>
                ))}
                <td style={{
                  textAlign: 'center',
                  fontWeight: 600,
                  color: r.missingCount === 0 ? '#00b894' : r.missingCount <= 3 ? '#fdcb6e' : '#d63031',
                }}>
                  {r.missingCount}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {filtered.length > 200 && (
          <div style={{ fontSize: '0.72em', color: '#8d95ad', padding: 6 }}>
            Showing first 200 of {filtered.length} rows. Use search to narrow down.
          </div>
        )}
      </div>
    </div>
  );
}
