/**
 * @file FilterPanel: collapsible panel for a single data layer.
 *       Shows toggle, weight slider, and CurveEditor for transfer functions.
 */
import { useState, useCallback } from 'react';
import { useAppStore } from '../store';
import { useT } from '../i18n';
import type { Translations } from '../i18n';
import type { LayerMeta } from '../types';
import type {
  LayerConfigs,
  LayerTransferConfig,
  TransferFunction,
  VoteTerm,
  VoteMetric,
  VOTE_METRIC_OPTIONS as _VMO,
} from '../types/transferFunction';
import { VOTE_METRIC_OPTIONS } from '../types/transferFunction';
import CurveEditor from './CurveEditor';
import WindRoseEditor from './WindRoseEditor';

interface FilterPanelProps {
  layer: LayerMeta;
}

export default function FilterPanel({ layer }: FilterPanelProps) {
  const [expanded, setExpanded] = useState(false);
  const { configs, toggleLayer, setLayerWeight, updateConfig, soloLayer, setSoloLayer } = useAppStore();
  const isSolo = soloLayer === layer.id;
  const t = useT();
  const layerLabel = t(`layer.${layer.id}.label` as keyof Translations) || layer.label;
  const layerDesc  = t(`layer.${layer.id}.desc` as keyof Translations) || layer.description;

  const handleToggle = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      toggleLayer(layer.id);
    },
    [layer.id, toggleLayer],
  );

  const handleSolo = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      setSoloLayer(isSolo ? null : layer.id);
    },
    [layer.id, isSolo, setSoloLayer],
  );

  return (
    <div className={`filter-panel ${isSolo ? 'solo-active' : ''}`} data-testid={`filter-panel-${layer.id}`}>
      <div className="filter-panel-header" onClick={() => setExpanded(!expanded)}>
        <span className="fp-icon">{layer.icon}</span>
        <div className="fp-info">
          <div className="fp-label">{layerLabel}</div>
          <div className="fp-desc">{layerDesc}</div>
        </div>
        <button
          className={`fp-solo ${isSolo ? 'on' : ''}`}
          onClick={handleSolo}
          title={isSolo ? 'Exit solo' : 'Solo this layer'}
          aria-label={`Solo ${layer.label}`}
        >
          ◎
        </button>
        <button
          className={`fp-toggle ${layer.enabled ? 'on' : 'off'}`}
          onClick={handleToggle}
          aria-label={`Toggle ${layer.label}`}
        />
      </div>

      {expanded && layer.enabled && (
        <div className="fp-body">
          <FilterControls layerId={layer.id} configs={configs} updateConfig={updateConfig} />
          <div className="fp-weight">
            <span>{t('fp.weight')}</span>
            <input
              type="range"
              min="0"
              max="2"
              step="0.1"
              value={layer.weight}
              onChange={(e) => setLayerWeight(layer.id, parseFloat(e.target.value))}
            />
            <span className="fp-value">{layer.weight.toFixed(1)}</span>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Helpers ────────────────────────────────────────────────────────────

/** Render a CurveEditor-based control for a single transfer function sub-layer. */
function TfControls({
  label,
  ltc,
  onChange,
  rangeMax,
  unit,
}: {
  label: string;
  ltc: LayerTransferConfig;
  onChange: (ltc: LayerTransferConfig) => void;
  rangeMax: number;
  unit: string;
}) {
  const updateTf = (newTf: TransferFunction) => onChange({ ...ltc, tf: newTf });
  const t = useT();

  return (
    <div className="tf-controls">
      <div className="tf-header">
        <span className="tf-label">{label}</span>
        <label className="tf-enabled-label">
          <input
            type="checkbox"
            checked={ltc.enabled}
            onChange={(e) => onChange({ ...ltc, enabled: e.target.checked })}
          />
          {t('tf.on')}
        </label>
      </div>

      <div className="tf-compact-row">
        <label className="tf-inline">
          M
          <input
            type="number"
            min="0.1"
            max="3"
            step="0.1"
            value={ltc.tf.multiplier}
            onChange={(e) => updateTf({ ...ltc.tf, multiplier: +e.target.value })}
          />
        </label>

        <label className="tf-inline tf-inline-wide">
          sin(
          <input
            type="number"
            step="0.1"
            value={ltc.tf.plateauEnd}
            onChange={(e) => updateTf({ ...ltc.tf, plateauEnd: +e.target.value })}
          />
          →
          <input
            type="number"
            step="0.1"
            value={ltc.tf.decayEnd}
            onChange={(e) => updateTf({ ...ltc.tf, decayEnd: +e.target.value })}
          />
          )
        </label>

        <label className="tf-inline">
          floor
          <input
            type="number"
            min="0"
            max="1"
            step="0.01"
            value={ltc.tf.floor}
            onChange={(e) => updateTf({ ...ltc.tf, floor: +e.target.value })}
          />
        </label>

        <label className="tf-flag">
          <input
            type="checkbox"
            checked={ltc.tf.mandatory}
            onChange={(e) => updateTf({ ...ltc.tf, mandatory: e.target.checked })}
          />
          {t('tf.req')}
        </label>

        <label className="tf-flag">
          <input
            type="checkbox"
            checked={ltc.tf.invert}
            onChange={(e) => updateTf({ ...ltc.tf, invert: e.target.checked })}
          />
          {t('tf.inv')}
        </label>
      </div>

      <div className="tf-curve-wrap">
        <CurveEditor
          tf={ltc.tf}
          rangeMax={rangeMax}
          unit={unit}
          onChange={updateTf}
        />
      </div>

      <label className="tf-multiplier" style={{ display: 'none' }}>
        Importance:
        <input
          type="range"
          min="0.1"
          max="3"
          step="0.1"
          value={ltc.tf.multiplier}
          onChange={(e) => updateTf({ ...ltc.tf, multiplier: +e.target.value })}
        />
        <span className="fp-value">{ltc.tf.multiplier.toFixed(1)}x</span>
      </label>
    </div>
  );
}

// ── Vote terms editor ──────────────────────────────────────────────────

/** Metric label lookup (no i18n key indirection needed inside the editor). */
const METRIC_LABELS: Record<VoteMetric, string> = {
  leftPct: 'Left %',
  rightPct: 'Right %',
  independencePct: 'Indep %',
  unionistPct: 'Unionist %',
  turnoutPct: 'Turnout %',
};

function VoteTermsEditor({
  terms,
  onChange,
}: {
  terms: VoteTerm[];
  onChange: (terms: VoteTerm[]) => void;
}) {
  const t = useT();
  const addTerm = () => {
    const usedMetrics = new Set(terms.map((t) => t.metric));
    const next = VOTE_METRIC_OPTIONS.find((o) => !usedMetrics.has(o.metric));
    if (!next) return; // all metrics already added
    const id = `v${Date.now()}`;
    onChange([
      ...terms,
      { id, metric: next.metric, value: { enabled: true, tf: { plateauEnd: 0, decayEnd: 100, floor: 0, mandatory: false, multiplier: 1, invert: false } } },
    ]);
  };

  const removeTerm = (id: string) => onChange(terms.filter((t) => t.id !== id));

  const updateTerm = (id: string, patch: Partial<VoteTerm>) =>
    onChange(terms.map((t) => (t.id === id ? { ...t, ...patch } : t)));

  return (
    <div className="vote-terms-editor">
      {terms.map((term) => (
        <div key={term.id} className="vote-term">
          <div className="vote-term-header">
            <select
              value={term.metric}
              onChange={(e) => updateTerm(term.id, { metric: e.target.value as VoteMetric })}
            >
              {VOTE_METRIC_OPTIONS.map((opt) => (
                <option key={opt.metric} value={opt.metric}>
                  {METRIC_LABELS[opt.metric]}
                </option>
              ))}
            </select>
            {terms.length > 1 && (
              <button
                className="vote-term-remove"
                onClick={() => removeTerm(term.id)}
                title="Remove term"
              >
                x
              </button>
            )}
          </div>
          <TfControls
            label={METRIC_LABELS[term.metric]}
            ltc={term.value}
            onChange={(ltc) => updateTerm(term.id, { value: ltc })}
            rangeMax={100}
            unit="%"
          />
        </div>
      ))}
      {terms.length < VOTE_METRIC_OPTIONS.length && (
        <button className="vote-term-add" onClick={addTerm}>
          + {t('fc.votes.addTerm' as keyof Translations)}
        </button>
      )}
    </div>
  );
}

// ── Per-layer filter controls ──────────────────────────────────────────

function FilterControls({
  layerId,
  configs,
  updateConfig,
}: {
  layerId: LayerMeta['id'];
  configs: LayerConfigs;
  updateConfig: <K extends keyof LayerConfigs>(layer: K, values: LayerConfigs[K]) => void;
}) {
  const t = useT();
  switch (layerId) {
    case 'terrain':
      return (
        <>
          <TfControls
            label={t('fc.terrain.slope')}
            ltc={configs.terrain.slope}
            onChange={(ltc) =>
              updateConfig('terrain', { ...configs.terrain, slope: ltc })
            }
            rangeMax={60}
            unit="deg"
          />
          <TfControls
            label={t('fc.terrain.elevation')}
            ltc={configs.terrain.elevation}
            onChange={(ltc) =>
              updateConfig('terrain', { ...configs.terrain, elevation: ltc })
            }
            rangeMax={3000}
            unit="m"
          />
          <div className="tf-controls">
            <div className="tf-header">
              <span className="tf-label">{t('fc.terrain.aspect')}</span>
              <label className="tf-enabled-label">
                M
                <input
                  type="number"
                  min="0"
                  max="3"
                  step="0.1"
                  value={configs.terrain.aspectWeight}
                  onChange={(e) =>
                    updateConfig('terrain', {
                      ...configs.terrain,
                      aspectWeight: Math.max(0, +e.target.value),
                    })
                  }
                  style={{ width: 48 }}
                />
              </label>
            </div>
            <WindRoseEditor
              prefs={configs.terrain.aspect}
              onChange={(aspect) =>
                updateConfig('terrain', { ...configs.terrain, aspect })
              }
            />
          </div>
        </>
      );

    case 'votes':
      return (
        <VoteTermsEditor
          terms={configs.votes.terms}
          onChange={(terms) => updateConfig('votes', { terms })}
        />
      );

    case 'transit':
      return (
        <TfControls
          label={t('fc.transit.dist')}
          ltc={configs.transit}
          onChange={(ltc) => updateConfig('transit', ltc)}
          rangeMax={50}
          unit="km"
        />
      );

    case 'forest':
      return (
        <TfControls
          label={t('fc.forest.cover')}
          ltc={configs.forest}
          onChange={(ltc) => updateConfig('forest', ltc)}
          rangeMax={100}
          unit="%"
        />
      );

    case 'airQuality':
      return (
        <>
          <TfControls
            label={t('fc.airQuality.pm10')}
            ltc={configs.airQuality.pm10}
            onChange={(ltc) =>
              updateConfig('airQuality', { ...configs.airQuality, pm10: ltc })
            }
            rangeMax={100}
            unit="ug/m3"
          />
          <TfControls
            label={t('fc.airQuality.no2')}
            ltc={configs.airQuality.no2}
            onChange={(ltc) =>
              updateConfig('airQuality', { ...configs.airQuality, no2: ltc })
            }
            rangeMax={100}
            unit="ug/m3"
          />
        </>
      );

    case 'crime':
      return (
        <TfControls
          label={t('fc.crime.rate')}
          ltc={configs.crime}
          onChange={(ltc) => updateConfig('crime', ltc)}
          rangeMax={100}
          unit="per 1k"
        />
      );

    case 'healthcare':
      return (
        <TfControls
          label={t('fc.healthcare.dist')}
          ltc={configs.healthcare}
          onChange={(ltc) => updateConfig('healthcare', ltc)}
          rangeMax={50}
          unit="km"
        />
      );

    case 'schools':
      return (
        <TfControls
          label={t('fc.schools.dist')}
          ltc={configs.schools}
          onChange={(ltc) => updateConfig('schools', ltc)}
          rangeMax={30}
          unit="km"
        />
      );

    case 'internet':
      return (
        <TfControls
          label={t('fc.internet.fiber')}
          ltc={configs.internet}
          onChange={(ltc) => updateConfig('internet', ltc)}
          rangeMax={100}
          unit="%"
        />
      );

    case 'climate':
      return (
        <>
          <TfControls
            label={t('fc.climate.temp')}
            ltc={configs.climate.temperature}
            onChange={(ltc) =>
              updateConfig('climate', { ...configs.climate, temperature: ltc })
            }
            rangeMax={35}
            unit="C"
          />
          <TfControls
            label={t('fc.climate.rain')}
            ltc={configs.climate.rainfall}
            onChange={(ltc) =>
              updateConfig('climate', { ...configs.climate, rainfall: ltc })
            }
            rangeMax={1500}
            unit="mm"
          />
        </>
      );

    case 'rentalPrices':
      return (
        <TfControls
          label={t('fc.rental.monthly')}
          ltc={configs.rentalPrices}
          onChange={(ltc) => updateConfig('rentalPrices', ltc)}
          rangeMax={3000}
          unit="EUR"
        />
      );

    case 'employment':
      return (
        <TfControls
          label={t('fc.employment.unemployed')}
          ltc={configs.employment}
          onChange={(ltc) => updateConfig('employment', ltc)}
          rangeMax={40}
          unit="%"
        />
      );

    case 'amenities':
      return (
        <TfControls
          label={t('fc.amenities.dist')}
          ltc={configs.amenities}
          onChange={(ltc) => updateConfig('amenities', ltc)}
          rangeMax={50}
          unit="km"
        />
      );

    default:
      return <p style={{ fontSize: 12, color: '#999' }}>No filters available for this layer.</p>;
  }
}
