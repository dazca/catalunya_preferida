import { useMemo, useState } from 'react';
import { INTEGRITY_SUGGESTIONS, useAppStore } from '../store';
import type { FacilityCollection, MunicipalityCollection, TransitStopCollection } from '../types';
import type { MunicipalityData } from '../utils/scorer';
import type { IntegrityLayer } from '../utils/dataIntegrity';
import './DataIntegrityPanel.css';

interface Props {
  municipalities: MunicipalityCollection | null;
  municipalityData: MunicipalityData;
  transitStops: TransitStopCollection | null;
  healthFacilities: FacilityCollection | null;
  schools: FacilityCollection | null;
  amenities: FacilityCollection | null;
}

const LAYERS: IntegrityLayer[] = [
  'global',
  'votes',
  'terrain',
  'forest',
  'airQuality',
  'crime',
  'rentalPrices',
  'employment',
  'internet',
  'climate',
  'transit',
  'healthcare',
  'schools',
  'amenities',
];

export default function DataIntegrityPanel(props: Props) {
  const {
    dataIntegrityPanelOpen,
    setDataIntegrityPanelOpen,
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

  const selectedLayerIssues = useMemo(() => {
    const match = integrityReport?.layers.find((l) => l.layer === selectedLayer);
    return match?.issues ?? [];
  }, [integrityReport, selectedLayer]);

  if (!dataIntegrityPanelOpen) return null;

  const runNow = () => {
    runIntegrityChecks({
      municipalities: props.municipalities,
      municipalityData: props.municipalityData,
      transitStops: props.transitStops,
      healthFacilities: props.healthFacilities,
      schools: props.schools,
      amenities: props.amenities,
    });
  };

  const doImport = () => {
    const res = importIntegrityProfile(profileInput);
    if (res.ok) {
      setImportError(null);
      runNow();
    } else {
      setImportError(res.error ?? 'Invalid profile JSON');
    }
  };

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
    <div className="di-backdrop" onMouseDown={() => setDataIntegrityPanelOpen(false)}>
      <div className="di-panel" onMouseDown={(e) => e.stopPropagation()}>
        <div className="di-header">
          <div>
            <div className="di-title">Data Integrity Admin</div>
            <div className="di-subtitle">Runtime datasets: validation, taxonomy and tuning</div>
          </div>
          <div className="di-header-actions">
            <button className="di-btn" onClick={runNow}>Run checks</button>
            <button className="di-btn" onClick={() => setDataIntegrityPanelOpen(false)}>Close</button>
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
                min={0}
                max={100}
                onChange={(e) => updateIntegrityRules({ requiredCoveragePct: Number(e.target.value) })}
              />
            </label>
            <label>
              Max blanks % per layer
              <input
                type="number"
                value={integrityRules.maxBlankPctPerLayer}
                min={0}
                max={100}
                onChange={(e) => updateIntegrityRules({ maxBlankPctPerLayer: Number(e.target.value) })}
              />
            </label>
            <label>
              Outlier z-score threshold
              <input
                type="number"
                value={integrityRules.maxOutlierZScore}
                min={1}
                max={10}
                step={0.5}
                onChange={(e) => updateIntegrityRules({ maxOutlierZScore: Number(e.target.value) })}
              />
            </label>
            <label>
              Stale year threshold
              <input
                type="number"
                value={integrityRules.staleYearThreshold}
                min={1}
                max={30}
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
