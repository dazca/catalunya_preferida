/**
 * @file FormulaBar – bottom-docked panel showing the live scoring formula.
 *
 * Displays: Score = w1 x Layer1(params) + w2 x Layer2(params) + ... [+]
 * Users can edit weights inline, toggle layers, and add/remove vote terms
 * directly from the formula.
 */
import { useState, useRef, useEffect, useCallback } from 'react';
import { useAppStore } from '../store';
import { useT } from '../i18n';
import type { Translations } from '../i18n';
import type { LayerMeta, LayerId } from '../types';
import type {
  LayerConfigs,
  VoteMetric,
  VoteTerm,
} from '../types/transferFunction';
import { VOTE_METRIC_OPTIONS, defaultTf } from '../types/transferFunction';
import './FormulaBar.css';

/** Short labels for each vote metric. */
const METRIC_SHORT: Record<VoteMetric, string> = {
  leftPct: 'Left',
  rightPct: 'Right',
  independencePct: 'Indep',
  unionistPct: 'Union',
  turnoutPct: 'Turn',
};

/**
 * Summarise the key parameter(s) for a non-vote layer as compact text.
 */
function layerParamSummary(id: LayerId, configs: LayerConfigs): string {
  switch (id) {
    case 'terrain': {
      const s = configs.terrain.slope.tf;
      const e = configs.terrain.elevation.tf;
      return `s${s.plateauEnd}-${s.decayEnd} e${e.plateauEnd}-${e.decayEnd}`;
    }
    case 'transit': return `${configs.transit.tf.plateauEnd}-${configs.transit.tf.decayEnd}km`;
    case 'forest': return `${configs.forest.tf.plateauEnd}-${configs.forest.tf.decayEnd}%`;
    case 'crime': return `${configs.crime.tf.plateauEnd}-${configs.crime.tf.decayEnd}/k`;
    case 'healthcare': return `${configs.healthcare.tf.plateauEnd}-${configs.healthcare.tf.decayEnd}km`;
    case 'schools': return `${configs.schools.tf.plateauEnd}-${configs.schools.tf.decayEnd}km`;
    case 'internet': return `${configs.internet.tf.plateauEnd}-${configs.internet.tf.decayEnd}%`;
    case 'climate': {
      const t = configs.climate.temperature.tf;
      return `${t.plateauEnd}-${t.decayEnd}C`;
    }
    case 'rentalPrices': return `${configs.rentalPrices.tf.plateauEnd}-${configs.rentalPrices.tf.decayEnd}EUR`;
    case 'employment': return `${configs.employment.tf.plateauEnd}-${configs.employment.tf.decayEnd}%`;
    case 'amenities': return `${configs.amenities.tf.plateauEnd}-${configs.amenities.tf.decayEnd}km`;
    case 'airQuality': {
      const p = configs.airQuality.pm10.tf;
      return `pm${p.plateauEnd}-${p.decayEnd}`;
    }
    default: return '';
  }
}

/**
 * Inline-editable weight input.
 */
function WeightInput({
  value,
  onChange,
}: {
  value: number;
  onChange: (v: number) => void;
}) {
  const [editing, setEditing] = useState(false);
  const ref = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing && ref.current) ref.current.select();
  }, [editing]);

  if (!editing) {
    return (
      <span
        className="fb-weight"
        style={{ cursor: 'pointer' }}
        onClick={() => setEditing(true)}
        title="Click to edit weight"
      >
        {value.toFixed(1)}
      </span>
    );
  }

  return (
    <input
      ref={ref}
      className="fb-weight"
      type="number"
      min={0}
      max={3}
      step={0.1}
      defaultValue={value.toFixed(1)}
      onBlur={(e) => {
        const v = Math.max(0, Math.min(3, parseFloat(e.target.value) || 0));
        onChange(v);
        setEditing(false);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
        if (e.key === 'Escape') setEditing(false);
      }}
    />
  );
}

/**
 * Vote terms sub-section inside the votes layer term in the formula bar.
 */
function VoteTermsInline({
  terms,
  onChange,
}: {
  terms: VoteTerm[];
  onChange: (terms: VoteTerm[]) => void;
}) {
  const [showPicker, setShowPicker] = useState(false);
  const pickerRef = useRef<HTMLDivElement>(null);

  // Close picker on outside click
  useEffect(() => {
    if (!showPicker) return;
    const handler = (e: MouseEvent) => {
      if (pickerRef.current && !pickerRef.current.contains(e.target as Node)) {
        setShowPicker(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [showPicker]);

  const usedMetrics = new Set(terms.map((t) => t.metric));

  const addTerm = (metric: VoteMetric) => {
    const id = `v${Date.now()}`;
    onChange([
      ...terms,
      {
        id,
        metric,
        value: {
          enabled: true,
          tf: defaultTf(0, 100, false, 0),
        },
      },
    ]);
    setShowPicker(false);
  };

  const removeTerm = (id: string) => {
    if (terms.length <= 1) return;
    onChange(terms.filter((t) => t.id !== id));
  };

  return (
    <span className="fb-params" style={{ position: 'relative' }}>
      (
      {terms.map((term, i) => (
        <span key={term.id}>
          {i > 0 && <span style={{ color: '#464f65' }}>, </span>}
          <span className="fb-vote-tag">
            {METRIC_SHORT[term.metric]}
            {terms.length > 1 && (
              <span className="fb-vote-remove" onClick={() => removeTerm(term.id)}>
                x
              </span>
            )}
          </span>
        </span>
      ))}
      {terms.length < VOTE_METRIC_OPTIONS.length && (
        <button
          className="fb-vote-add"
          onClick={() => setShowPicker(!showPicker)}
          title="Add vote metric"
        >
          +
        </button>
      )}
      )
      {showPicker && (
        <div className="fb-vote-picker" ref={pickerRef}>
          {VOTE_METRIC_OPTIONS.map((opt) => (
            <button
              key={opt.metric}
              className={usedMetrics.has(opt.metric) ? 'disabled' : ''}
              onClick={() => addTerm(opt.metric)}
            >
              {METRIC_SHORT[opt.metric]}
            </button>
          ))}
        </div>
      )}
    </span>
  );
}

/**
 * The [+] button dropdown to enable disabled layers.
 */
function AddLayerDropdown({
  layers,
  onEnable,
}: {
  layers: LayerMeta[];
  onEnable: (id: LayerId) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const t = useT();

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const disabled = layers.filter((l) => !l.enabled);

  return (
    <div style={{ position: 'relative', flexShrink: 0 }} ref={ref}>
      <button
        className="fb-add-btn"
        onClick={() => setOpen(!open)}
        title="Add layer to formula"
      >
        +
      </button>
      {open && disabled.length > 0 && (
        <div className="fb-add-dropdown">
          <div className="fb-add-dropdown-title">
            {t('fb.addLayer' as keyof Translations)}
          </div>
          {disabled.map((l) => (
            <button
              key={l.id}
              className="fb-add-dropdown-item"
              onClick={() => {
                onEnable(l.id);
                setOpen(false);
              }}
            >
              <span className="fb-dd-icon">{l.icon}</span>
              {t(`layer.${l.id}.label` as keyof Translations) || l.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/* ── Root component ─────────────────────────────────────────────────── */

export default function FormulaBar() {
  const {
    layers,
    configs,
    toggleLayer,
    setLayerWeight,
    updateConfig,
  } = useAppStore();
  const t = useT();
  const [collapsed, setCollapsed] = useState(false);

  const enabledLayers = layers.filter((l) => l.enabled);

  const handleEnableLayer = useCallback(
    (id: LayerId) => {
      const layer = layers.find((l) => l.id === id);
      if (layer && !layer.enabled) toggleLayer(id);
    },
    [layers, toggleLayer],
  );

  return (
    <div className={`formula-bar ${collapsed ? 'collapsed' : ''}`}>
      <button
        className="formula-bar-toggle"
        onClick={() => setCollapsed(!collapsed)}
      >
        {collapsed
          ? (t('fb.show' as keyof Translations) || 'Formula')
          : (t('fb.hide' as keyof Translations) || 'Hide')}
      </button>

      <div className="formula-bar-inner">
        <span className="fb-label">Score =</span>

        {enabledLayers.map((layer, idx) => (
          <span key={layer.id} style={{ display: 'contents' }}>
            {idx > 0 && <span className="fb-op">+</span>}

            <span className={`fb-term ${layer.enabled ? '' : 'disabled'}`}>
              <WeightInput
                value={layer.weight}
                onChange={(w) => setLayerWeight(layer.id, w)}
              />
              <span className="fb-op">&times;</span>
              <span className="fb-icon">{layer.icon}</span>
              <span
                className="fb-name"
                onClick={() => toggleLayer(layer.id)}
                title="Click to toggle"
              >
                {t(`layer.${layer.id}.label` as keyof Translations) || layer.label}
              </span>

              {/* Vote terms inline editor */}
              {layer.id === 'votes' && (
                <VoteTermsInline
                  terms={configs.votes.terms}
                  onChange={(terms) => updateConfig('votes', { terms })}
                />
              )}

              {/* Non-vote layers: show param summary */}
              {layer.id !== 'votes' && (
                <span className="fb-params">
                  <span className="fb-param-tag">
                    {layerParamSummary(layer.id, configs)}
                  </span>
                </span>
              )}
            </span>
          </span>
        ))}

        <AddLayerDropdown layers={layers} onEnable={handleEnableLayer} />
      </div>
    </div>
  );
}
