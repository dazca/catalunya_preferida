/**
 * @file Data integrity tab for the admin panel.
 * Loads resource data on demand and uses the shared Zustand store for rules & reporting.
 */
import { useMemo, useState, useCallback } from 'react';
import { INTEGRITY_SUGGESTIONS, useAppStore } from '../../store';
import type { MunicipalityCollection, TransitStopCollection, FacilityCollection } from '../../types';
import type { MunicipalityData } from '../../utils/scorer';
import type { IntegrityLayer, DataIntegrityInput } from '../../utils/dataIntegrity';
import '../../components/DataIntegrityPanel.css';

const LAYERS: IntegrityLayer[] = [
  'global', 'votes', 'terrain', 'forest', 'airQuality', 'crime',
  'rentalPrices', 'employment', 'internet', 'climate',
  'transit', 'healthcare', 'schools', 'amenities',
];

/** Build a resource URL that respects Vite base path. */
function resourceUrl(rel: string): string {
  const base = import.meta.env.BASE_URL || '/';
  return `${base.replace(/\/$/, '')}/${rel.replace(/^\//, '')}`;
}

async function fetchJson<T>(path: string): Promise<T | null> {
  try {
    const r = await fetch(path);
    if (!r.ok) return null;
    return (await r.json()) as T;
  } catch {
    return null;
  }
}

function normalizeIne(code: string): string { return code.substring(0, 5); }

function indexByCodi<T extends { codi: string }>(arr: T[] | null): Record<string, T> {
  if (!arr) return {};
  const m: Record<string, T> = {};
  for (const item of arr) m[normalizeIne(item.codi)] = item;
  return m;
}

interface LoadedData {
  municipalities: MunicipalityCollection | null;
  municipalityData: MunicipalityData;
  transitStops: TransitStopCollection | null;
  healthFacilities: FacilityCollection | null;
  schools: FacilityCollection | null;
  amenities: FacilityCollection | null;
}

/** One-shot loader for resource data required by integrity checks. */
async function loadResourceData(): Promise<LoadedData> {
  const [
    municipalities,
    terrainArr,
    votesArr,
    forestArr,
    crimeArr,
    rentalArr,
    employmentArr,
    airArr,
    internetArr,
    transit,
    health,
    schools,
    amenities,
  ] = await Promise.all([
    fetchJson<MunicipalityCollection>(resourceUrl('resources/geo/municipis.geojson')),
    fetchJson<{ codi: string }[]>(resourceUrl('resources/terrain/municipality_terrain_stats.json')),
    fetchJson<{ codi: string }[]>(resourceUrl('resources/votes/municipal_sentiment.json')),
    fetchJson<{ codi: string }[]>(resourceUrl('resources/vegetation/forest_cover.json')),
    fetchJson<{ codi: string }[]>(resourceUrl('resources/crime/crime_by_municipality.json')),
    fetchJson<{ codi: string }[]>(resourceUrl('resources/economy/rental_prices.json')),
    fetchJson<{ codi: string }[]>(resourceUrl('resources/economy/employment.json')),
    fetchJson<{ codi: string }[]>(resourceUrl('resources/air/stations.json')),
    fetchJson<{ codi: string }[]>(resourceUrl('resources/internet/coverage.json')),
    fetchJson<TransitStopCollection>(resourceUrl('resources/transit/all_stations.geojson')),
    fetchJson<FacilityCollection>(resourceUrl('resources/health/facilities.geojson')),
    fetchJson<FacilityCollection>(resourceUrl('resources/education/schools.geojson')),
    fetchJson<FacilityCollection>(resourceUrl('resources/amenities/facilities.geojson')),
  ]);

  return {
    municipalities,
    municipalityData: {
      terrain: indexByCodi(terrainArr),
      votes: indexByCodi(votesArr),
      forest: indexByCodi(forestArr),
      crime: indexByCodi(crimeArr),
      rentalPrices: indexByCodi(rentalArr),
      employment: indexByCodi(employmentArr),
      airQuality: indexByCodi(airArr),
      internet: indexByCodi(internetArr),
      transitDistKm: {},
      healthcareDistKm: {},
      schoolDistKm: {},
      amenityDistKm: {},
    } as MunicipalityData,
    transitStops: transit,
    healthFacilities: health,
    schools,
    amenities,
  };
}

export default function IntegrityTab() {
  const {
    integrityRules,
    updateIntegrityRules,
    resetIntegrityRules,
    runIntegrityChecks,
    integrityReport,
    importIntegrityProfile,
    exportIntegrityProfile,
  } = useAppStore();

  const [selectedLayer, setSelectedLayer] = useState<IntegrityLayer>('votes');
  const [profileInput, setProfileInput] = useState('');
  const [importError, setImportError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadStatus, setLoadStatus] = useState('');
  const [cachedData, setCachedData] = useState<DataIntegrityInput | null>(null);

  const selectedLayerIssues = useMemo(() => {
    return integrityReport?.layers.find((l) => l.layer === selectedLayer)?.issues ?? [];
  }, [integrityReport, selectedLayer]);

  const runNow = useCallback(async () => {
    setLoading(true);
    setLoadStatus('Loading resource data…');
    try {
      let data = cachedData;
      if (!data) {
        data = await loadResourceData();
        setCachedData(data);
      }
      setLoadStatus('Running integrity checks…');
      runIntegrityChecks(data);
      setLoadStatus('');
    } catch (e: unknown) {
      setLoadStatus(`Error: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setLoading(false);
    }
  }, [cachedData, runIntegrityChecks]);

  const doImport = useCallback(async () => {
    const res = importIntegrityProfile(profileInput);
    if (res.ok) {
      setImportError(null);
      await runNow();
    } else {
      setImportError(res.error ?? 'Invalid profile JSON');
    }
  }, [profileInput, importIntegrityProfile, runNow]);

  const download = (filename: string, content: string) => {
    const blob = new Blob([content], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div>
      <h1 className="adm-title">Data Integrity</h1>
      <p className="adm-desc">
        Runtime validation, taxonomy, and tuning for dataset rules. Data is loaded on demand from the public resources directory.
      </p>

      {loadStatus && <div className="adm-progress" style={{ marginBottom: 12 }}>{loadStatus}</div>}

      <div className="di-panel" style={{ position: 'relative', inset: 'auto', width: '100%', height: 'auto', maxHeight: 'none', borderRadius: 8 }}>
        <div className="di-header">
          <div>
            <div className="di-title">Data Integrity Admin</div>
            <div className="di-subtitle">Runtime datasets: validation, taxonomy and tuning</div>
          </div>
          <div className="di-header-actions">
            <button className="di-btn" onClick={runNow} disabled={loading}>
              {loading ? 'Loading…' : 'Run checks'}
            </button>
          </div>
        </div>

        <div className="di-grid">
          <section className="di-card">
            <h4>What we can do</h4>
            <ul className="di-suggestions">
              {INTEGRITY_SUGGESTIONS.map((s) => (
                <li key={s.id}>
                  <span>{s.label}</span>
                  <strong>{Math.round(s.probability * 100)}%</strong>
                </li>
              ))}
            </ul>
          </section>

          <section className="di-card">
            <h4>Rules</h4>
            <label>
              Required coverage %
              <input
                type="number"
                value={integrityRules.requiredCoveragePct}
                min={0} max={100}
                onChange={(e) => updateIntegrityRules({ requiredCoveragePct: Number(e.target.value) })}
              />
            </label>
            <label>
              Max blanks % per layer
              <input
                type="number"
                value={integrityRules.maxBlankPctPerLayer}
                min={0} max={100}
                onChange={(e) => updateIntegrityRules({ maxBlankPctPerLayer: Number(e.target.value) })}
              />
            </label>
            <label>
              Outlier z-score threshold
              <input
                type="number"
                value={integrityRules.maxOutlierZScore}
                min={1} max={10} step={0.5}
                onChange={(e) => updateIntegrityRules({ maxOutlierZScore: Number(e.target.value) })}
              />
            </label>
            <label>
              Stale year threshold
              <input
                type="number"
                value={integrityRules.staleYearThreshold}
                min={1} max={30}
                onChange={(e) => updateIntegrityRules({ staleYearThreshold: Number(e.target.value) })}
              />
            </label>
            <button className="di-btn di-btn-secondary" onClick={resetIntegrityRules}>Reset rules</button>
          </section>

          <section className="di-card">
            <h4>Party taxonomy (votes)</h4>
            <label>
              Left parties (comma-separated)
              <textarea
                value={integrityRules.leftParties.join(', ')}
                onChange={(e) => updateIntegrityRules({ leftParties: e.target.value.split(',').map((v) => v.trim()).filter(Boolean) })}
              />
            </label>
            <label>
              Independence parties (comma-separated)
              <textarea
                value={integrityRules.independenceParties.join(', ')}
                onChange={(e) => updateIntegrityRules({ independenceParties: e.target.value.split(',').map((v) => v.trim()).filter(Boolean) })}
              />
            </label>
            <small>Current scoring uses aggregated vote fields. Taxonomy is persisted here for integrity governance and script alignment.</small>
          </section>

          <section className="di-card di-card-wide">
            <h4>Report</h4>
            <div className="di-summary">
              <span>Total: {integrityReport?.totalIssues ?? 0}</span>
              <span>Errors: {integrityReport?.bySeverity.error ?? 0}</span>
              <span>Warnings: {integrityReport?.bySeverity.warning ?? 0}</span>
              <span>Info: {integrityReport?.bySeverity.info ?? 0}</span>
            </div>

            <div className="di-layer-filter">
              {LAYERS.map((layer) => (
                <button
                  key={layer}
                  className={`di-pill ${selectedLayer === layer ? 'active' : ''}`}
                  onClick={() => setSelectedLayer(layer)}
                >
                  {layer}
                </button>
              ))}
            </div>

            <div className="di-issues">
              {selectedLayerIssues.length === 0 && <div className="di-empty">No issues in {selectedLayer}</div>}
              {selectedLayerIssues.map((issue) => (
                <div key={issue.id} className={`di-issue ${issue.severity}`}>
                  <div className="di-issue-head">
                    <strong>{issue.code}</strong>
                    <span>{issue.severity.toUpperCase()}</span>
                  </div>
                  <div>{issue.message}</div>
                  <div className="di-issue-meta">Affected: {issue.affectedCount}</div>
                  {issue.sampleCodes.length > 0 && (
                    <div className="di-issue-samples">Samples: {issue.sampleCodes.join(', ')}</div>
                  )}
                </div>
              ))}
            </div>

            <div className="di-actions">
              <button className="di-btn di-btn-secondary" onClick={() => download('integrity-profile.json', exportIntegrityProfile())}>
                Export profile
              </button>
              <button
                className="di-btn di-btn-secondary"
                onClick={() => download('integrity-report.json', JSON.stringify(integrityReport ?? {}, null, 2))}
                disabled={!integrityReport}
              >
                Export report
              </button>
            </div>
          </section>

          <section className="di-card di-card-wide">
            <h4>Import profile JSON</h4>
            <textarea
              className="di-import"
              placeholder="Paste profile JSON here"
              value={profileInput}
              onChange={(e) => setProfileInput(e.target.value)}
            />
            <div className="di-actions">
              <button className="di-btn" onClick={doImport}>Import + Run</button>
            </div>
            {importError && <div className="di-error">{importError}</div>}
          </section>
        </div>
      </div>
    </div>
  );
}
