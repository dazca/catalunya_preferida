/**
 * @file PointAnalysisPanel: floating panel showing score breakdown
 *       for an arbitrary point on the map.
 */
import { useAppStore } from '../store';
import { useT } from '../i18n';
import type { PointScoreResult } from '../utils/pointAnalysis';
import './PointAnalysisPanel.css';

/** Label + unit lookup for rawValues keys. */
const RAW_LABELS: Record<string, { label: string; unit: string }> = {
  transitDistKm: { label: 'Transit', unit: 'km' },
  healthcareDistKm: { label: 'Healthcare', unit: 'km' },
  schoolDistKm: { label: 'School', unit: 'km' },
  amenityDistKm: { label: 'Amenity', unit: 'km' },
  avgTempC: { label: 'Temperature', unit: 'C' },
  avgRainfallMm: { label: 'Rainfall', unit: 'mm' },
  slopeDeg: { label: 'Slope', unit: 'deg' },
  elevationM: { label: 'Elevation', unit: 'm' },
  votePct: { label: 'Vote %', unit: '%' },
  forestPct: { label: 'Forest', unit: '%' },
  pm10: { label: 'PM10', unit: 'ug/m3' },
  no2: { label: 'NO2', unit: 'ug/m3' },
  crimeRate: { label: 'Crime', unit: '/1k' },
  fiberPct: { label: 'Fiber', unit: '%' },
  avgRent: { label: 'Rent', unit: 'EUR/mo' },
  unemploymentPct: { label: 'Unemployment', unit: '%' },
};

interface PointAnalysisPanelProps {
  result: PointScoreResult | null;
}

/** Score value to CSS color. */
function scoreColor(s: number): string {
  if (s > 0.6) return '#4caf50';
  if (s > 0.3) return '#ff9800';
  return '#f44336';
}

export default function PointAnalysisPanel({ result }: PointAnalysisPanelProps) {
  const { setAnalysisPoint, togglePointAnalysisMode } = useAppStore();
  const layers = useAppStore((s) => s.layers);
  const t = useT();

  if (!result) return null;

  const layerLabelMap: Record<string, string> = {};
  for (const l of layers) layerLabelMap[l.id] = l.label;

  const close = () => {
    setAnalysisPoint(null);
    togglePointAnalysisMode();
  };

  return (
    <div className="pa-panel" data-testid="point-analysis-panel">
      <button className="pa-close" onClick={close} aria-label={t('pa.close')}>
        x
      </button>

      <h3 className="pa-title">{t('pa.title')}</h3>

      <div className="pa-coords">
        {result.lat.toFixed(5)}, {result.lon.toFixed(5)}
      </div>

      <div className="pa-municipality">
        {result.municipality
          ? result.municipality.nom
          : t('pa.outside')}
      </div>

      <div className="pa-score-main">
        <span className="pa-score-label">{t('pa.overall')}</span>
        <span
          className="pa-score-value"
          style={{ color: scoreColor(result.score) }}
        >
          {result.disqualified ? 'DQ' : `${(result.score * 100).toFixed(0)}%`}
        </span>
      </div>

      {/* Per-layer breakdown */}
      {Object.keys(result.layerScores).length > 0 && (
        <div className="pa-breakdown">
          <div className="pa-section-title">{t('pa.layerScores')}</div>
          {Object.entries(result.layerScores).map(([id, score]) => (
            <div key={id} className="pa-layer-row">
              <span className="pa-layer-name">
                {layerLabelMap[id] ?? id}
              </span>
              <span
                className="pa-layer-score"
                style={{ color: scoreColor(score!) }}
              >
                {(score! * 100).toFixed(0)}%
              </span>
            </div>
          ))}
        </div>
      )}

      {/* Raw values */}
      {Object.keys(result.rawValues).length > 0 && (
        <div className="pa-breakdown">
          <div className="pa-section-title">{t('pa.rawValues')}</div>
          {Object.entries(result.rawValues)
            .filter(([, v]) => isFinite(v) && v !== Infinity)
            .map(([key, value]) => {
              const meta = RAW_LABELS[key];
              return (
                <div key={key} className="pa-layer-row">
                  <span className="pa-layer-name">
                    {meta?.label ?? key}
                  </span>
                  <span className="pa-raw-value">
                    {value.toFixed(1)} {meta?.unit ?? ''}
                  </span>
                </div>
              );
            })}
        </div>
      )}
    </div>
  );
}
