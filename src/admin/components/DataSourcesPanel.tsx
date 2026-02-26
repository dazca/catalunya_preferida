/**
 * @file Data-sources registry panel.
 * Lists every data layer with its origin URL, download script, last-known year,
 * data format, and quick copy-to-clipboard re-fetch command.
 */
import { useState } from 'react';

export type DataFormat = 'municipality-json' | 'point-geojson' | 'polygon-geojson' | 'synthetic' | 'grid' | 'station-json';

export interface DataSourceEntry {
  layer: string;
  label: string;
  format: DataFormat;
  source: string;
  script: string;
  apiUrl: string;
  socrataId?: string;
  notes?: string;
  /** Last known data year or 'synthetic'. */
  lastYear: string;
  /** Whether the resource file currently has data. */
  hasData?: boolean;
  /** Count of records. */
  recordCount?: number;
}

export const DATA_SOURCES: DataSourceEntry[] = [
  {
    layer: 'votes',
    label: 'Municipal Sentiment (Votes)',
    format: 'municipality-json',
    source: 'Catalan Parliament Elections — Socrata',
    script: 'scripts/download-votes.mjs',
    apiUrl: 'https://analisi.transparenciacatalunya.cat/resource/',
    notes: 'Aggregated left/right + indep/unionist per municipality. turnoutPct currently zero.',
    lastYear: '2019',
  },
  {
    layer: 'climate',
    label: 'METEOCAT Climate Stations',
    format: 'point-geojson',
    source: 'METEOCAT — Socrata',
    script: 'scripts/download-climate.mjs',
    apiUrl: 'https://analisi.transparenciacatalunya.cat/resource/',
    socrataId: 'yqwd-vj5e / 4fb2-n3yi / nzvn-apee',
    notes: 'stations.geojson + station_climate.json (readings). 3 Socrata datasets joined.',
    lastYear: '2024',
  },
  {
    layer: 'crime',
    label: 'Crime (Mossos)',
    format: 'municipality-json',
    source: 'Mossos d\'Esquadra — Socrata',
    script: 'scripts/download-crime.mjs',
    apiUrl: 'https://analisi.transparenciacatalunya.cat/resource/',
    socrataId: 'qnyt-emjc',
    notes: 'Source is by ABP (police region), NOT municipality. Currently empty [].',
    lastYear: 'N/A',
  },
  {
    layer: 'airQuality',
    label: 'Air Quality (XVPCA)',
    format: 'station-json',
    source: 'XVPCA — Socrata',
    script: 'scripts/download-air-quality.mjs',
    apiUrl: 'https://analisi.transparenciacatalunya.cat/resource/',
    socrataId: 'tasf-thgu',
    notes: 'Station-based hourly readings. Sparse municipality coverage.',
    lastYear: '2024',
  },
  {
    layer: 'healthcare',
    label: 'Health Facilities',
    format: 'point-geojson',
    source: 'Equipaments de Catalunya — Socrata',
    script: 'scripts/download-facilities.mjs',
    apiUrl: 'https://analisi.transparenciacatalunya.cat/resource/',
    socrataId: '8gmd-gz7i',
    notes: 'Hospitals, CAPs, health centers. Shared script with schools & amenities.',
    lastYear: '2024',
  },
  {
    layer: 'schools',
    label: 'Educational Facilities',
    format: 'point-geojson',
    source: 'Equipaments de Catalunya — Socrata',
    script: 'scripts/download-facilities.mjs',
    apiUrl: 'https://analisi.transparenciacatalunya.cat/resource/',
    socrataId: '8gmd-gz7i',
    notes: 'Filtered by education category.',
    lastYear: '2024',
  },
  {
    layer: 'amenities',
    label: 'Amenities (Culture, Sport, Leisure)',
    format: 'point-geojson',
    source: 'Equipaments de Catalunya — Socrata',
    script: 'scripts/download-facilities.mjs',
    apiUrl: 'https://analisi.transparenciacatalunya.cat/resource/',
    socrataId: '8gmd-gz7i',
    notes: 'Filtered by culture / sport / leisure categories.',
    lastYear: '2024',
  },
  {
    layer: 'rentalPrices',
    label: 'Rental Prices (INCASOL)',
    format: 'municipality-json',
    source: 'INCASOL — Socrata',
    script: 'scripts/download-rental-prices.mjs',
    apiUrl: 'https://analisi.transparenciacatalunya.cat/resource/',
    socrataId: 'qww9-bvhh',
    notes: 'avgEurMonth, eurPerSqm per municipality.',
    lastYear: '2024',
  },
  {
    layer: 'employment',
    label: 'Employment & Demographics',
    format: 'municipality-json',
    source: 'Population + Economic — Socrata',
    script: 'scripts/download-employment.mjs',
    apiUrl: 'https://analisi.transparenciacatalunya.cat/resource/',
    socrataId: 'b4rr-d25b / 6nei-4b44',
    notes: 'codi is 6-digit (needs normalization). population, unemploymentPct, avgIncome.',
    lastYear: '2024',
  },
  {
    layer: 'transit',
    label: 'Transit Stations',
    format: 'point-geojson',
    source: 'FGC GTFS + Socrata fallback',
    script: 'scripts/download-transit.mjs',
    apiUrl: 'https://www.fgc.cat/google/google_transit.zip',
    notes: 'FGC, Renfe, Metro, Bus. GTFS zip + Socrata fallback.',
    lastYear: '2024',
  },
  {
    layer: 'municipalities',
    label: 'Municipality Polygons',
    format: 'polygon-geojson',
    source: 'ICGC WFS',
    script: 'scripts/download-municipalities.mjs',
    apiUrl: 'https://geoserveis.icgc.cat/servei/catalunya/divisions-administratives/wfs',
    notes: 'nom, codi, comarca. Reference geometry for all municipality-based layers.',
    lastYear: '2024',
  },
  {
    layer: 'terrain',
    label: 'Terrain Stats',
    format: 'synthetic',
    source: 'Synthetic (seeded PRNG)',
    script: 'scripts/download-synthetic.mjs',
    apiUrl: '-',
    notes: 'avgSlopeDeg, dominantAspect, avgElevationM. Generated, not real.',
    lastYear: 'synthetic',
  },
  {
    layer: 'forest',
    label: 'Forest Cover',
    format: 'synthetic',
    source: 'Synthetic (seeded PRNG)',
    script: 'scripts/download-synthetic.mjs',
    apiUrl: '-',
    notes: 'forestPct, agriculturalPct, urbanPct. Generated from codi hash.',
    lastYear: 'synthetic',
  },
  {
    layer: 'internet',
    label: 'Internet Coverage',
    format: 'synthetic',
    source: 'Synthetic (seeded PRNG)',
    script: 'scripts/download-synthetic.mjs',
    apiUrl: '-',
    notes: 'fiberPct, adslPct, coverageScore. Fully synthetic.',
    lastYear: 'synthetic',
  },
];

const FORMAT_BADGE: Record<DataFormat, { label: string; color: string }> = {
  'municipality-json': { label: 'Municipality JSON', color: '#6c5ce7' },
  'point-geojson': { label: 'Point GeoJSON', color: '#00b894' },
  'polygon-geojson': { label: 'Polygon GeoJSON', color: '#0984e3' },
  'station-json': { label: 'Station JSON', color: '#fdcb6e' },
  synthetic: { label: 'Synthetic', color: '#e17055' },
  grid: { label: 'Grid / Raster', color: '#a29bfe' },
};

export default function DataSourcesPanel() {
  const [copied, setCopied] = useState<string | null>(null);
  const [filter, setFilter] = useState<DataFormat | 'all'>('all');

  const filtered = filter === 'all' ? DATA_SOURCES : DATA_SOURCES.filter((s) => s.format === filter);

  const copyCmd = (script: string) => {
    const cmd = `node ${script}`;
    navigator.clipboard.writeText(cmd).then(() => {
      setCopied(script);
      setTimeout(() => setCopied(null), 2000);
    });
  };

  return (
    <div className="adm-di-card adm-di-card-wide">
      <h4>Data Sources &amp; Re-Fetchers</h4>

      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 10 }}>
        <button
          className={`adm-di-pill ${filter === 'all' ? 'active' : ''}`}
          onClick={() => setFilter('all')}
        >
          All ({DATA_SOURCES.length})
        </button>
        {Object.entries(FORMAT_BADGE).map(([fmt, { label }]) => {
          const count = DATA_SOURCES.filter((s) => s.format === fmt).length;
          if (count === 0) return null;
          return (
            <button
              key={fmt}
              className={`adm-di-pill ${filter === fmt ? 'active' : ''}`}
              onClick={() => setFilter(fmt as DataFormat)}
            >
              {label} ({count})
            </button>
          );
        })}
      </div>

      <div style={{ overflowX: 'auto' }}>
        <table className="adm-stats-table" style={{ width: '100%', fontSize: '0.78em' }}>
          <thead>
            <tr>
              <th>Layer</th>
              <th>Format</th>
              <th>Source</th>
              <th>Script</th>
              <th>API / Socrata</th>
              <th>Year</th>
              <th>Notes</th>
              <th>Re-fetch</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((s) => {
              const badge = FORMAT_BADGE[s.format];
              return (
                <tr key={s.layer}>
                  <td style={{ fontWeight: 600 }}>{s.label}</td>
                  <td>
                    <span
                      style={{
                        background: badge.color + '22',
                        color: badge.color,
                        padding: '2px 6px',
                        borderRadius: 4,
                        fontSize: '0.9em',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {badge.label}
                    </span>
                  </td>
                  <td style={{ color: '#8d95ad' }}>{s.source}</td>
                  <td style={{ fontFamily: 'monospace', fontSize: '0.9em' }}>{s.script}</td>
                  <td style={{ maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {s.socrataId ? (
                      <span title={s.apiUrl}>{s.socrataId}</span>
                    ) : (
                      <a
                        href={s.apiUrl}
                        target="_blank"
                        rel="noreferrer"
                        style={{ color: '#6c5ce7', textDecoration: 'none' }}
                        title={s.apiUrl}
                      >
                        {s.apiUrl === '-' ? '-' : 'link'}
                      </a>
                    )}
                  </td>
                  <td>
                    <span
                      style={{
                        color: s.lastYear === 'synthetic' ? '#e17055' : s.lastYear === 'N/A' ? '#d63031' : '#00b894',
                        fontWeight: 600,
                      }}
                    >
                      {s.lastYear}
                    </span>
                  </td>
                  <td style={{ fontSize: '0.9em', color: '#8d95ad', maxWidth: 220 }}>{s.notes}</td>
                  <td>
                    <button
                      className="adm-btn-secondary"
                      style={{ padding: '2px 8px', fontSize: '0.85em' }}
                      onClick={() => copyCmd(s.script)}
                      title={`Copy: node ${s.script}`}
                    >
                      {copied === s.script ? 'Copied' : 'Copy cmd'}
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <small style={{ display: 'block', marginTop: 6, color: '#666' }}>
        Re-fetch commands run in Node.js (not from browser). Copy and paste into your terminal.
      </small>
    </div>
  );
}
