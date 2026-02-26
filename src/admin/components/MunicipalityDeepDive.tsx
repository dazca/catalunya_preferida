/**
 * @file Municipality deep-dive panel.
 * Click a municipality → see all its data across every layer in one card.
 */
import { useMemo } from 'react';
import type { MunicipalityData } from '../../utils/scorer';
import type { IntegrityReport, IntegrityLayer } from '../../utils/dataIntegrity';

interface Props {
  codi: string;
  nom: string;
  municipalityData: MunicipalityData;
  report: IntegrityReport | null;
  onClose: () => void;
}

interface FieldInfo {
  label: string;
  value: string | number | undefined;
  status: 'ok' | 'missing' | 'warning';
}

export default function MunicipalityDeepDive({ codi, nom, municipalityData, report, onClose }: Props) {
  const sections = useMemo(() => {
    const result: Array<{ layer: string; fields: FieldInfo[] }> = [];

    // Votes
    const votes = municipalityData.votes[codi] as Record<string, unknown> | undefined;
    result.push({
      layer: 'Votes',
      fields: [
        { label: 'Left %', value: votes?.leftPct as number | undefined, status: votes?.leftPct != null ? 'ok' : 'missing' },
        { label: 'Right %', value: votes?.rightPct as number | undefined, status: votes?.rightPct != null ? 'ok' : 'missing' },
        { label: 'Independence %', value: votes?.independencePct as number | undefined, status: votes?.independencePct != null ? 'ok' : 'missing' },
        { label: 'Unionist %', value: votes?.unionistPct as number | undefined, status: votes?.unionistPct != null ? 'ok' : 'missing' },
        { label: 'Turnout %', value: votes?.turnoutPct as number | undefined, status: (votes?.turnoutPct as number) === 0 ? 'warning' : votes?.turnoutPct != null ? 'ok' : 'missing' },
        { label: 'Year', value: votes?.year as number | undefined, status: votes?.year != null ? 'ok' : 'missing' },
      ],
    });

    // Terrain
    const terrain = municipalityData.terrain[codi] as Record<string, unknown> | undefined;
    result.push({
      layer: 'Terrain',
      fields: [
        { label: 'Avg Slope (°)', value: terrain?.avgSlopeDeg as number | undefined, status: terrain?.avgSlopeDeg != null ? 'ok' : 'missing' },
        { label: 'Avg Elevation (m)', value: terrain?.avgElevationM as number | undefined, status: terrain?.avgElevationM != null ? 'ok' : 'missing' },
        { label: 'Dominant Aspect', value: terrain?.dominantAspect as string | undefined, status: terrain?.dominantAspect != null ? 'ok' : 'missing' },
      ],
    });

    // Forest
    const forest = municipalityData.forest[codi] as Record<string, unknown> | undefined;
    result.push({
      layer: 'Forest',
      fields: [
        { label: 'Forest %', value: forest?.forestPct as number | undefined, status: forest?.forestPct != null ? 'ok' : 'missing' },
        { label: 'Agricultural %', value: forest?.agriculturalPct as number | undefined, status: forest?.agriculturalPct != null ? 'ok' : 'missing' },
        { label: 'Urban %', value: forest?.urbanPct as number | undefined, status: forest?.urbanPct != null ? 'ok' : 'missing' },
      ],
    });

    // Crime
    const crime = municipalityData.crime[codi] as Record<string, unknown> | undefined;
    result.push({
      layer: 'Crime',
      fields: [
        { label: 'Total Offenses', value: crime?.totalOffenses as number | undefined, status: crime ? 'ok' : 'missing' },
        { label: 'Rate/1000', value: crime?.ratePerThousand as number | undefined, status: crime ? 'ok' : 'missing' },
      ],
    });

    // Rental Prices
    const rental = municipalityData.rentalPrices[codi] as Record<string, unknown> | undefined;
    result.push({
      layer: 'Rental Prices',
      fields: [
        { label: 'Avg EUR/month', value: rental?.avgEurMonth as number | undefined, status: rental?.avgEurMonth != null ? 'ok' : 'missing' },
        { label: 'EUR/m²', value: rental?.eurPerSqm as number | undefined, status: rental?.eurPerSqm != null ? 'ok' : 'missing' },
      ],
    });

    // Employment
    const empl = municipalityData.employment[codi] as Record<string, unknown> | undefined;
    result.push({
      layer: 'Employment',
      fields: [
        { label: 'Population', value: empl?.population as number | undefined, status: empl?.population != null ? 'ok' : 'missing' },
        { label: 'Unemployment %', value: empl?.unemploymentPct as number | undefined, status: empl?.unemploymentPct != null ? 'ok' : 'missing' },
        { label: 'Avg Income', value: empl?.avgIncome as number | undefined, status: empl?.avgIncome != null ? 'ok' : 'missing' },
      ],
    });

    // Internet
    const internet = municipalityData.internet[codi] as Record<string, unknown> | undefined;
    result.push({
      layer: 'Internet',
      fields: [
        { label: 'Fiber %', value: internet?.fiberPct as number | undefined, status: internet?.fiberPct != null ? 'ok' : 'missing' },
        { label: 'ADSL %', value: internet?.adslPct as number | undefined, status: internet?.adslPct != null ? 'ok' : 'missing' },
      ],
    });

    // Air Quality
    const air = municipalityData.airQuality[codi] as Record<string, unknown> | undefined;
    result.push({
      layer: 'Air Quality',
      fields: [
        { label: 'PM10', value: air?.pm10 as number | undefined, status: air?.pm10 != null ? 'ok' : 'missing' },
        { label: 'NO₂', value: air?.no2 as number | undefined, status: air?.no2 != null ? 'ok' : 'missing' },
      ],
    });

    // Distances
    const transitDist = municipalityData.transitDistKm[codi];
    const healthDist = municipalityData.healthcareDistKm[codi];
    const schoolDist = municipalityData.schoolDistKm[codi];
    const amenityDist = municipalityData.amenityDistKm[codi];
    result.push({
      layer: 'Distances (km)',
      fields: [
        { label: 'Transit', value: transitDist != null ? Math.round(transitDist * 100) / 100 : undefined, status: transitDist != null ? 'ok' : 'missing' },
        { label: 'Healthcare', value: healthDist != null ? Math.round(healthDist * 100) / 100 : undefined, status: healthDist != null ? 'ok' : 'missing' },
        { label: 'School', value: schoolDist != null ? Math.round(schoolDist * 100) / 100 : undefined, status: schoolDist != null ? 'ok' : 'missing' },
        { label: 'Amenity', value: amenityDist != null ? Math.round(amenityDist * 100) / 100 : undefined, status: amenityDist != null ? 'ok' : 'missing' },
      ],
    });

    return result;
  }, [codi, municipalityData]);

  // Issues for this municipality from report
  const muniIssues = useMemo(() => {
    if (!report) return [];
    const issues: Array<{ layer: IntegrityLayer; severity: string; code: string; message: string }> = [];
    for (const lr of report.layers) {
      for (const issue of lr.issues) {
        if (issue.affectedCodis?.includes(codi) || issue.sampleCodes.includes(codi)) {
          issues.push({ layer: lr.layer, severity: issue.severity, code: issue.code, message: issue.message });
        }
      }
    }
    return issues;
  }, [report, codi]);

  // Count statuses
  const totalFields = sections.reduce((acc, s) => acc + s.fields.length, 0);
  const missingFields = sections.reduce((acc, s) => acc + s.fields.filter(f => f.status === 'missing').length, 0);
  const completeness = totalFields > 0 ? Math.round(((totalFields - missingFields) / totalFields) * 100) : 0;

  return (
    <div
      style={{
        position: 'fixed', inset: 0, zIndex: 1000,
        background: 'rgba(0,0,0,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: 20,
      }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div style={{
        background: '#0f1115', border: '1px solid #2d3440', borderRadius: 12,
        width: 'min(800px, 95vw)', maxHeight: '85vh', overflow: 'auto', padding: 20,
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
          <div>
            <h3 style={{ margin: 0, fontSize: '1.1em', color: '#e0e0e0' }}>{nom}</h3>
            <span style={{ fontSize: '0.82em', color: '#8d95ad', fontFamily: 'monospace' }}>{codi}</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <span style={{
              padding: '4px 12px', borderRadius: 6, fontSize: '0.85em', fontWeight: 600,
              background: completeness >= 80 ? 'rgba(0,184,148,0.15)' : completeness >= 50 ? 'rgba(253,203,110,0.15)' : 'rgba(214,48,49,0.15)',
              color: completeness >= 80 ? '#00b894' : completeness >= 50 ? '#fdcb6e' : '#d63031',
            }}>
              {completeness}% complete
            </span>
            <button
              onClick={onClose}
              style={{ background: 'none', border: '1px solid #2d3440', borderRadius: 6, color: '#aab1c7', cursor: 'pointer', padding: '4px 10px', fontSize: '0.85em' }}
            >
              Close
            </button>
          </div>
        </div>

        {/* Data sections */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 10 }}>
          {sections.map((section) => {
            const hasMissing = section.fields.some(f => f.status === 'missing');
            return (
              <div key={section.layer} style={{
                background: hasMissing ? 'rgba(214,48,49,0.05)' : 'rgba(255,255,255,0.02)',
                border: `1px solid ${hasMissing ? 'rgba(214,48,49,0.3)' : '#2d3440'}`,
                borderRadius: 8, padding: 10,
              }}>
                <h4 style={{ fontSize: '0.82em', color: '#6c5ce7', margin: '0 0 6px', fontWeight: 600 }}>
                  {section.layer}
                </h4>
                {section.fields.map((f) => (
                  <div key={f.label} style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.78em', padding: '2px 0', borderBottom: '1px solid rgba(45,52,64,0.3)' }}>
                    <span style={{ color: '#aab1c7' }}>{f.label}</span>
                    <span style={{
                      fontWeight: 600,
                      color: f.status === 'ok' ? '#e0e0e0' : f.status === 'warning' ? '#fdcb6e' : '#d63031',
                    }}>
                      {f.value != null ? (typeof f.value === 'number' ? (Number.isInteger(f.value) ? f.value : f.value.toFixed(2)) : f.value) : '—'}
                    </span>
                  </div>
                ))}
              </div>
            );
          })}
        </div>

        {/* Issues */}
        {muniIssues.length > 0 && (
          <div style={{ marginTop: 14 }}>
            <h4 style={{ fontSize: '0.85em', color: '#d63031', margin: '0 0 6px' }}>
              Issues ({muniIssues.length})
            </h4>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              {muniIssues.map((issue, i) => (
                <div key={i} style={{
                  padding: '4px 8px', borderRadius: 4, fontSize: '0.78em',
                  borderLeft: `3px solid ${issue.severity === 'error' ? '#d63031' : issue.severity === 'warning' ? '#fdcb6e' : '#6c5ce7'}`,
                  background: 'rgba(45,52,64,0.2)',
                }}>
                  <strong>{issue.layer}</strong> — {issue.code}: {issue.message}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
