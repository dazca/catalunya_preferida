/**
 * @file Data integrity tab for the admin panel — comprehensive dashboard.
 * Integrates: spatial gap map, coverage matrix, freshness badges, histograms,
 * sentiment editor, data sources registry, municipality deep-dive, and the
 * original rules/report panel.
 */
import { useMemo, useState, useCallback, useEffect } from 'react';
import { INTEGRITY_SUGGESTIONS, useAppStore } from '../../store';
import type { MunicipalityCollection, TransitStopCollection, FacilityCollection } from '../../types';
import type { MunicipalityData } from '../../utils/scorer';
import type { IntegrityLayer, DataIntegrityInput } from '../../utils/dataIntegrity';
import { normalizeMunicipalityGeometries } from '../../utils/municipalityGeometry';
import IntegrityMap from '../components/IntegrityMap';
import DataSourcesPanel from '../components/DataSourcesPanel';
import SentimentEditor, { DEFAULT_SENTIMENT_CONFIG } from '../components/SentimentEditor';
import type { SentimentConfig } from '../components/SentimentEditor';
import CoverageMatrix from '../components/CoverageMatrix';
import MunicipalityDeepDive from '../components/MunicipalityDeepDive';
import { FreshnessBadges, DistributionHistograms } from '../components/FreshnessHistograms';
import '../../components/DataIntegrityPanel.css';

/* ─── Constants ─── */
const LAYERS: IntegrityLayer[] = [
  'global', 'votes', 'terrain', 'forest', 'airQuality', 'crime',
  'rentalPrices', 'employment', 'internet', 'climate',
  'transit', 'healthcare', 'schools', 'amenities',
];

type SubTab = 'overview' | 'map' | 'matrix' | 'sources' | 'sentiment' | 'report';
const SUB_TABS: { id: SubTab; label: string }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'map', label: 'Spatial Map' },
  { id: 'matrix', label: 'Coverage Matrix' },
  { id: 'sources', label: 'Data Sources' },
  { id: 'sentiment', label: 'Party Sentiment' },
  { id: 'report', label: 'Issues & Rules' },
];

/* ─── Helpers ─── */
function resourceUrl(rel: string): string {
  const base = import.meta.env.BASE_URL || '/';
  return `${base.replace(/\/$/, '')}/${rel.replace(/^\//, '')}`;
}

async function fetchJson<T>(path: string): Promise<T | null> {
  try {
    const r = await fetch(path);
    if (!r.ok) return null;
    return (await r.json()) as T;
  } catch { return null; }
}

function normalizeIne(code: string): string { return code.substring(0, 5); }

function indexByCodi<T extends { codi: string }>(arr: T[] | null): Record<string, T> {
  if (!arr) return {};
  const m: Record<string, T> = {};
  for (const item of arr) m[normalizeIne(item.codi)] = item;
  return m;
}

interface RawArrays {
  terrain: { codi: string }[] | null;
  votes: { codi: string }[] | null;
  forest: { codi: string }[] | null;
  crime: { codi: string }[] | null;
  rental: { codi: string }[] | null;
  employment: { codi: string }[] | null;
  air: { codi: string }[] | null;
  internet: { codi: string }[] | null;
}

interface LoadedData {
  municipalities: MunicipalityCollection | null;
  municipalityData: MunicipalityData;
  transitStops: TransitStopCollection | null;
  healthFacilities: FacilityCollection | null;
  schools: FacilityCollection | null;
  amenities: FacilityCollection | null;
  rawArrays: RawArrays;
}

async function loadResourceData(): Promise<LoadedData> {
  const [
    municipalities, terrainArr, votesArr, forestArr, crimeArr,
    rentalArr, employmentArr, airArr, internetArr,
    transit, health, schools, amenities,
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

  const normalizedMunicipalities = normalizeMunicipalityGeometries(municipalities);

  return {
    municipalities: normalizedMunicipalities,
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
    rawArrays: {
      terrain: terrainArr, votes: votesArr, forest: forestArr,
      crime: crimeArr, rental: rentalArr, employment: employmentArr,
      air: airArr, internet: internetArr,
    },
  };
}

/* ─── Sentiment persistence key ─── */
const SENTIMENT_KEY = 'catpref-sentiment-config';
function loadSentimentConfig(): SentimentConfig {
  try {
    const raw = localStorage.getItem(SENTIMENT_KEY);
    if (raw) return JSON.parse(raw) as SentimentConfig;
  } catch { /* ignore */ }
  return DEFAULT_SENTIMENT_CONFIG;
}

/* ─── CSV export ─── */
function reportToCsv(report: NonNullable<ReturnType<typeof useAppStore.getState>['integrityReport']>): string {
  const header = 'layer,severity,code,message,affectedCount,sampleCodes';
  const rows = report.layers.flatMap((l) =>
    l.issues.map((i) =>
      [l.layer, i.severity, i.code, `"${i.message.replace(/"/g, '""')}"`, i.affectedCount, `"${i.sampleCodes.join(';')}"`].join(',')
    )
  );
  return [header, ...rows].join('\n');
}

/* ═══════════════════════════════════════════════ */
export default function IntegrityTab() {
  const {
    integrityRules, updateIntegrityRules, resetIntegrityRules,
    runIntegrityChecks, integrityReport,
    importIntegrityProfile, exportIntegrityProfile,
  } = useAppStore();

  /* Sub-tab state */
  const [subTab, setSubTab] = useState<SubTab>('overview');
  const [selectedLayer, setSelectedLayer] = useState<IntegrityLayer>('votes');
  const [profileInput, setProfileInput] = useState('');
  const [importError, setImportError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadStatus, setLoadStatus] = useState('');
  const [cachedData, setCachedData] = useState<LoadedData | null>(null);

  /* Sentiment config (local state, persisted to localStorage) */
  const [sentimentConfig, setSentimentConfig] = useState<SentimentConfig>(loadSentimentConfig);
  const handleSentimentChange = useCallback((cfg: SentimentConfig) => {
    setSentimentConfig(cfg);
    localStorage.setItem(SENTIMENT_KEY, JSON.stringify(cfg));
  }, []);

  /* Municipality deep-dive */
  const [deepDiveCodi, setDeepDiveCodi] = useState<string | null>(null);

  /* Derived from cached data */
  const municipalityList = useMemo(() => {
    if (!cachedData?.municipalities) return [];
    return cachedData.municipalities.features.map((f) => ({
      codi: normalizeIne(f.properties.codi),
      name: f.properties.nom ?? f.properties.codi,
    }));
  }, [cachedData]);

  const muniNames = useMemo(() => {
    const out: Record<string, string> = {};
    for (const m of municipalityList) out[m.codi] = m.name;
    return out;
  }, [municipalityList]);

  const dataCodesByLayer = useMemo(() => {
    if (!cachedData) return {} as Record<string, string[]>;
    const md = cachedData.municipalityData;
    return {
      votes: Object.keys(md.votes),
      terrain: Object.keys(md.terrain),
      forest: Object.keys(md.forest),
      crime: Object.keys(md.crime),
      rentalPrices: Object.keys(md.rentalPrices),
      employment: Object.keys(md.employment),
      airQuality: Object.keys(md.airQuality),
      internet: Object.keys(md.internet),
    } as Record<string, string[]>;
  }, [cachedData]);

  const pointCollections = useMemo(() => {
    if (!cachedData) {
      return {
        transit: null,
        healthcare: null,
        schools: null,
        amenities: null,
      };
    }
    return {
      transit: cachedData.transitStops ?? null,
      healthcare: cachedData.healthFacilities ?? null,
      schools: cachedData.schools ?? null,
      amenities: cachedData.amenities ?? null,
    };
  }, [cachedData]);

  const selectedLayerIssues = useMemo(
    () => integrityReport?.layers.find((l) => l.layer === selectedLayer)?.issues ?? [],
    [integrityReport, selectedLayer],
  );

  const mapCoverageInfo = useMemo(() => {
    const totalMunicipalities = municipalityList.length;
    if (totalMunicipalities === 0) return null;
    const coveredFromReport = integrityReport?.coverageByLayer?.[selectedLayer]?.length;
    const coveredFromData = dataCodesByLayer[selectedLayer]?.length;
    const covered = Math.max(0, Math.min(totalMunicipalities, coveredFromReport ?? coveredFromData ?? 0));
    const missing = Math.max(0, totalMunicipalities - covered);
    return { covered, missing, total: totalMunicipalities };
  }, [municipalityList.length, integrityReport, selectedLayer, dataCodesByLayer]);

  // Load resources automatically so saved integrity reports can be explored without re-running checks.
  useEffect(() => {
    if (cachedData) return;
    let cancelled = false;
    const run = async () => {
      try {
        setLoadStatus((prev) => prev || 'Loading resource data…');
        const data = await loadResourceData();
        if (cancelled) return;
        setCachedData(data);
        setLoadStatus((prev) => (prev === 'Loading resource data…' ? '' : prev));
      } catch (e: unknown) {
        if (cancelled) return;
        setLoadStatus(`Error: ${e instanceof Error ? e.message : String(e)}`);
      }
    };
    void run();
    return () => { cancelled = true; };
  }, [cachedData]);

  /* Run integrity checks */
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
      const rawArrays: DataIntegrityInput['rawArrays'] = {
        votes: data.rawArrays.votes,
        terrain: data.rawArrays.terrain,
        forest: data.rawArrays.forest,
        crime: data.rawArrays.crime,
        rentalPrices: data.rawArrays.rental,
        employment: data.rawArrays.employment,
        airQuality: data.rawArrays.air,
        internet: data.rawArrays.internet,
      };
      runIntegrityChecks({ ...data, rawArrays });
      setLoadStatus('');
    } catch (e: unknown) {
      setLoadStatus(`Error: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setLoading(false);
    }
  }, [cachedData, runIntegrityChecks]);

  const doImport = useCallback(async () => {
    const res = importIntegrityProfile(profileInput);
    if (res.ok) { setImportError(null); await runNow(); }
    else { setImportError(res.error ?? 'Invalid profile JSON'); }
  }, [profileInput, importIntegrityProfile, runNow]);

  const download = (filename: string, content: string) => {
    const blob = new Blob([content], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename; a.click();
    URL.revokeObjectURL(url);
  };

  /* ─── Render ─── */
  return (
    <div>
      <h1 className="adm-title">Data Integrity Dashboard</h1>
      <p className="adm-desc">
        Comprehensive validation, spatial coverage, data freshness, party sentiment, and re-fetch management.
      </p>

      {loadStatus && <div className="adm-progress" style={{ marginBottom: 12 }}>{loadStatus}</div>}

      {/* Top action bar */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
        <button className="di-btn" onClick={runNow} disabled={loading}>
          {loading ? 'Loading…' : 'Run Integrity Checks'}
        </button>
        {integrityReport && (
          <>
            <button className="di-btn di-btn-secondary" onClick={() => download('integrity-report.csv', reportToCsv(integrityReport))}>
              Export CSV
            </button>
            <button className="di-btn di-btn-secondary" onClick={() => download('integrity-report.json', JSON.stringify(integrityReport, null, 2))}>
              Export JSON
            </button>
          </>
        )}
      </div>

      {/* Sub-tab navigation */}
      <div className="di-layer-filter" style={{ marginBottom: 16 }}>
        {SUB_TABS.map((t) => (
          <button key={t.id} className={`di-pill ${subTab === t.id ? 'active' : ''}`} onClick={() => setSubTab(t.id)}>
            {t.label}
          </button>
        ))}
      </div>

      {/* ── Overview sub-tab ── */}
      {subTab === 'overview' && (
        <div className="di-panel" style={{ position: 'relative', inset: 'auto', width: '100%', height: 'auto', maxHeight: 'none', borderRadius: 8 }}>
          <div className="di-grid">
            {/* Summary card */}
            <section className="di-card">
              <h4>Summary</h4>
              <div className="di-summary">
                <span>Total: {integrityReport?.totalIssues ?? '—'}</span>
                <span style={{ color: '#e74c3c' }}>Errors: {integrityReport?.bySeverity.error ?? '—'}</span>
                <span style={{ color: '#e67e22' }}>Warnings: {integrityReport?.bySeverity.warning ?? '—'}</span>
                <span>Info: {integrityReport?.bySeverity.info ?? '—'}</span>
              </div>
              {!integrityReport && <p style={{ opacity: 0.6, marginTop: 8 }}>Press "Run Integrity Checks" to generate a report.</p>}
            </section>

            {/* Suggestions card */}
            <section className="di-card">
              <h4>What we can do</h4>
              <ul className="di-suggestions">
                {INTEGRITY_SUGGESTIONS.map((s) => (
                  <li key={s.id}><span>{s.label}</span><strong>{Math.round(s.probability * 100)}%</strong></li>
                ))}
              </ul>
            </section>

            {/* Freshness badges */}
            <section className="di-card di-card-wide">
              <h4>Data Freshness</h4>
              <FreshnessBadges stats={integrityReport?.layerStats} />
            </section>

            {/* Distribution histograms */}
            {cachedData && (
              <section className="di-card di-card-wide">
                <h4>Value Distributions</h4>
                <DistributionHistograms municipalityData={cachedData.municipalityData} />
              </section>
            )}
          </div>
        </div>
      )}

      {/* ── Spatial Map sub-tab ── */}
      {subTab === 'map' && (
        <div style={{ borderRadius: 8, overflow: 'hidden', border: '1px solid #333' }}>
          <IntegrityMap
            municipalities={cachedData?.municipalities ?? null}
            dataCodesByLayer={dataCodesByLayer}
            pointCollections={pointCollections}
            report={integrityReport ?? null}
            selectedLayer={selectedLayer}
            onSelectLayer={setSelectedLayer}
            onClickMunicipality={setDeepDiveCodi}
          />
          {!cachedData && <p style={{ padding: 16, opacity: 0.6 }}>Loading municipality data…</p>}
          {mapCoverageInfo && (
            <p style={{ padding: '8px 12px', margin: 0, fontSize: '0.8em', color: '#8d95ad' }}>
              Coverage for <strong>{selectedLayer}</strong>: {mapCoverageInfo.covered}/{mapCoverageInfo.total} municipalities with data; missing {mapCoverageInfo.missing}.
              {mapCoverageInfo.missing === 0 ? ' If you still see white pockets, those are geometry gaps/non-municipal areas in the source map, not missing integrity data.' : ''}
            </p>
          )}
        </div>
      )}

      {/* ── Coverage Matrix sub-tab ── */}
      {subTab === 'matrix' && (
        <CoverageMatrix
          muniNames={muniNames}
          coverageByLayer={integrityReport?.coverageByLayer ?? {}}
          report={integrityReport ?? null}
        />
      )}

      {/* ── Data Sources sub-tab ── */}
      {subTab === 'sources' && <DataSourcesPanel />}

      {/* ── Party Sentiment sub-tab ── */}
      {subTab === 'sentiment' && <SentimentEditor config={sentimentConfig} onChange={handleSentimentChange} />}

      {/* ── Issues & Rules sub-tab ── */}
      {subTab === 'report' && (
        <div className="di-panel" style={{ position: 'relative', inset: 'auto', width: '100%', height: 'auto', maxHeight: 'none', borderRadius: 8 }}>
          <div className="di-grid">
            {/* Rules card */}
            <section className="di-card">
              <h4>Rules</h4>
              <label>Required coverage %
                <input type="number" value={integrityRules.requiredCoveragePct} min={0} max={100}
                  onChange={(e) => updateIntegrityRules({ requiredCoveragePct: Number(e.target.value) })} />
              </label>
              <label>Max blanks % per layer
                <input type="number" value={integrityRules.maxBlankPctPerLayer} min={0} max={100}
                  onChange={(e) => updateIntegrityRules({ maxBlankPctPerLayer: Number(e.target.value) })} />
              </label>
              <label>Outlier z-score threshold
                <input type="number" value={integrityRules.maxOutlierZScore} min={1} max={10} step={0.5}
                  onChange={(e) => updateIntegrityRules({ maxOutlierZScore: Number(e.target.value) })} />
              </label>
              <label>Stale year threshold
                <input type="number" value={integrityRules.staleYearThreshold} min={1} max={30}
                  onChange={(e) => updateIntegrityRules({ staleYearThreshold: Number(e.target.value) })} />
              </label>
              {/* New rule toggles */}
              <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <input type="checkbox" checked={integrityRules.crossLayerCheck ?? true}
                  onChange={(e) => updateIntegrityRules({ crossLayerCheck: e.target.checked })} />
                Cross-layer correlation check
              </label>
              <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <input type="checkbox" checked={integrityRules.coordBoundsCheck ?? true}
                  onChange={(e) => updateIntegrityRules({ coordBoundsCheck: e.target.checked })} />
                Coordinate bounds check
              </label>
              <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <input type="checkbox" checked={integrityRules.brokenRefCheck ?? true}
                  onChange={(e) => updateIntegrityRules({ brokenRefCheck: e.target.checked })} />
                Broken references check
              </label>
              <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <input type="checkbox" checked={integrityRules.duplicateCodiCheck ?? true}
                  onChange={(e) => updateIntegrityRules({ duplicateCodiCheck: e.target.checked })} />
                Duplicate codi check
              </label>
              <button className="di-btn di-btn-secondary" onClick={resetIntegrityRules} style={{ marginTop: 8 }}>Reset rules</button>
            </section>

            {/* Party taxonomy */}
            <section className="di-card">
              <h4>Party taxonomy (votes)</h4>
              <label>Left parties (comma-separated)
                <textarea value={integrityRules.leftParties.join(', ')}
                  onChange={(e) => updateIntegrityRules({ leftParties: e.target.value.split(',').map((v) => v.trim()).filter(Boolean) })} />
              </label>
              <label>Independence parties (comma-separated)
                <textarea value={integrityRules.independenceParties.join(', ')}
                  onChange={(e) => updateIntegrityRules({ independenceParties: e.target.value.split(',').map((v) => v.trim()).filter(Boolean) })} />
              </label>
              <small>Taxonomy is persisted in store for integrity governance and script alignment.</small>
            </section>

            {/* Issues list */}
            <section className="di-card di-card-wide">
              <h4>Issues by Layer</h4>
              <div className="di-summary">
                <span>Total: {integrityReport?.totalIssues ?? 0}</span>
                <span>Errors: {integrityReport?.bySeverity.error ?? 0}</span>
                <span>Warnings: {integrityReport?.bySeverity.warning ?? 0}</span>
                <span>Info: {integrityReport?.bySeverity.info ?? 0}</span>
              </div>
              <div className="di-layer-filter">
                {LAYERS.map((layer) => (
                  <button key={layer} className={`di-pill ${selectedLayer === layer ? 'active' : ''}`}
                    onClick={() => setSelectedLayer(layer)}>
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
            </section>

            {/* Import / Export */}
            <section className="di-card di-card-wide">
              <h4>Import / Export Profile</h4>
              <div className="di-actions" style={{ marginBottom: 8 }}>
                <button className="di-btn di-btn-secondary" onClick={() => download('integrity-profile.json', exportIntegrityProfile())}>
                  Export profile
                </button>
              </div>
              <textarea className="di-import" placeholder="Paste profile JSON here"
                value={profileInput} onChange={(e) => setProfileInput(e.target.value)} />
              <div className="di-actions">
                <button className="di-btn" onClick={doImport}>Import + Run</button>
              </div>
              {importError && <div className="di-error">{importError}</div>}
            </section>
          </div>
        </div>
      )}

      {/* ── Municipality deep-dive modal ── */}
      {deepDiveCodi && cachedData && (
        <MunicipalityDeepDive
          codi={deepDiveCodi}
          nom={
            cachedData.municipalities?.features.find(
              (f) => normalizeIne(f.properties.codi) === deepDiveCodi,
            )?.properties.nom ?? deepDiveCodi
          }
          municipalityData={cachedData.municipalityData}
          report={integrityReport ?? null}
          onClose={() => setDeepDiveCodi(null)}
        />
      )}
    </div>
  );
}
