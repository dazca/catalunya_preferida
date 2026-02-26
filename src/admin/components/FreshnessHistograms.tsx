/**
 * @file Freshness badges and mini-histogram sparklines for integrity dashboard.
 */
import { useMemo } from 'react';
import type { IntegrityLayerStats } from '../../utils/dataIntegrity';
import type { MunicipalityData } from '../../utils/scorer';

interface FreshnessProps {
  stats?: IntegrityLayerStats[] | null;
}

const CURRENT_YEAR = new Date().getFullYear();

function freshnessColor(year: number | null): string {
  if (year === null) return '#8d95ad';
  const age = CURRENT_YEAR - year;
  if (age <= 1) return '#00b894';
  if (age <= 3) return '#fdcb6e';
  if (age <= 6) return '#e17055';
  return '#d63031';
}

function freshnessLabel(year: number | null): string {
  if (year === null) return 'Unknown';
  const age = CURRENT_YEAR - year;
  if (age <= 1) return 'Fresh';
  if (age <= 3) return 'Recent';
  if (age <= 6) return 'Aging';
  return 'Stale';
}

export function FreshnessBadges({ stats }: FreshnessProps) {
  const items = stats ?? [];
  if (items.length === 0) {
    return <div style={{ color: '#8d95ad', fontSize: '0.85em' }}>Run integrity checks to see freshness data.</div>;
  }
  return (
    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
      {items.map((s) => {
          const col = freshnessColor(s.dataYear);
          const label = freshnessLabel(s.dataYear);
          return (
            <div
              key={s.layer}
              style={{
                background: 'rgba(255,255,255,0.03)',
                border: `1px solid ${col}44`,
                borderRadius: 8,
                padding: '8px 12px',
                minWidth: 110,
                textAlign: 'center',
              }}
            >
              <div style={{ fontSize: '0.72em', color: '#8d95ad', marginBottom: 2 }}>{s.layer}</div>
              <div style={{ fontSize: '1.1em', fontWeight: 700, color: col }}>
                {s.dataYear ?? '?'}
              </div>
              <div style={{
                fontSize: '0.68em', color: col, fontWeight: 600,
                padding: '1px 6px', background: col + '18', borderRadius: 4, marginTop: 2,
              }}>
                {label}
              </div>
              <div style={{ fontSize: '0.65em', color: '#8d95ad', marginTop: 3 }}>
                {s.totalRecords} records · {s.municipalityCoverage >= 0 ? `${s.municipalityCoverage}%` : 'point-based'}
              </div>
            </div>
          );
        })}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════════════
   Mini Histogram
   ═══════════════════════════════════════════════════════════════════════════ */

interface HistogramProps {
  municipalityData?: MunicipalityData | null;
}

/** A simple SVG sparkline histogram. */
function MiniHistogram({ values, label, color }: { values: number[]; label: string; color: string }) {
  const bins = useMemo(() => {
    if (values.length === 0) return [];
    const min = Math.min(...values);
    const max = Math.max(...values);
    const range = max - min || 1;
    const NBINS = 20;
    const counts = new Array(NBINS).fill(0) as number[];
    for (const v of values) {
      const idx = Math.min(Math.floor(((v - min) / range) * NBINS), NBINS - 1);
      counts[idx]++;
    }
    const maxCount = Math.max(...counts, 1);
    return counts.map((c) => c / maxCount);
  }, [values]);

  if (values.length === 0) {
    return (
      <div style={{ textAlign: 'center', fontSize: '0.72em', color: '#8d95ad', padding: 4 }}>
        {label}: no data
      </div>
    );
  }

  const W = 120;
  const H = 32;
  const barW = W / bins.length - 1;

  return (
    <div style={{ display: 'inline-block', margin: '0 6px 4px 0' }}>
      <div style={{ fontSize: '0.68em', color: '#8d95ad', marginBottom: 1 }}>{label} ({values.length})</div>
      <svg width={W} height={H} style={{ display: 'block' }}>
        {bins.map((h, i) => (
          <rect
            key={i}
            x={i * (barW + 1)}
            y={H - h * H}
            width={barW}
            height={h * H}
            fill={color}
            opacity={0.7}
            rx={1}
          />
        ))}
      </svg>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.6em', color: '#666' }}>
        <span>{Math.min(...values).toFixed(1)}</span>
        <span>{Math.max(...values).toFixed(1)}</span>
      </div>
    </div>
  );
}

/** Extract numeric arrays from municipality data for histogram display. */
export function DistributionHistograms({ municipalityData }: HistogramProps) {
  const datasets = useMemo(() => {
    if (!municipalityData) return [];
    const extract = <T,>(table: Record<string, T>, field: keyof T): number[] => {
      const values: number[] = [];
      for (const row of Object.values(table)) {
        const v = row[field];
        if (typeof v === 'number' && Number.isFinite(v)) values.push(v);
      }
      return values;
    };

    return [
      { label: 'Left %', values: extract(municipalityData.votes, 'leftPct' as never), color: '#e84393' },
      { label: 'Independence %', values: extract(municipalityData.votes, 'independencePct' as never), color: '#fdcb6e' },
      { label: 'Slope (°)', values: extract(municipalityData.terrain, 'avgSlopeDeg' as never), color: '#00b894' },
      { label: 'Elevation (m)', values: extract(municipalityData.terrain, 'avgElevationM' as never), color: '#6c5ce7' },
      { label: 'Forest %', values: extract(municipalityData.forest, 'forestPct' as never), color: '#00cec9' },
      { label: 'Rent (EUR)', values: extract(municipalityData.rentalPrices, 'avgEurMonth' as never), color: '#e17055' },
      { label: 'Unemployment %', values: extract(municipalityData.employment, 'unemploymentPct' as never), color: '#fd79a8' },
      { label: 'Fiber %', values: extract(municipalityData.internet, 'fiberPct' as never), color: '#0984e3' },
      { label: 'PM10', values: extract(municipalityData.airQuality, 'pm10' as never), color: '#a29bfe' },
      { label: 'Crime rate', values: extract(municipalityData.crime, 'ratePerThousand' as never), color: '#d63031' },
    ];
  }, [municipalityData]);

  if (datasets.length === 0) {
    return <div style={{ color: '#8d95ad', fontSize: '0.85em' }}>Run integrity checks to see distributions.</div>;
  }
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
      {datasets.map((d) => (
        <MiniHistogram key={d.label} values={d.values} label={d.label} color={d.color} />
      ))}
    </div>
  );
}
