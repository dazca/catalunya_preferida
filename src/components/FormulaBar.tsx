/**
 * @file FormulaBar â€“ bottom-docked scoring formula bar.
 *
 * Shows: Score = icon(w) + icon(w) + ... [+]
 *
 * - Each layer is an icon + weight chip.
 * - Hover opens an editing popover; click pins it.
 * - [x] on the popover removes the layer.
 * - Solo button isolates the layer's heatmap contribution.
 * - Scroll/drag on weight to adjust.
 * - Scroll on icon area adjusts multiplier; Ctrl+scroll shifts plateauEnd.
 * - [+] button lets the user pick a disabled layer, instantly adds it and
 *   opens its editing popover so they can tweak the sinusoidal.
 * - Ctrl+Z / Ctrl+Y undo / redo (wired in App).
 */
import { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { useAppStore } from '../store';
import { useT } from '../i18n';
import type { Translations } from '../i18n';
import type { LayerMeta, LayerId } from '../types';
import type {
  LayerConfigs,
  LayerTransferConfig,
  TransferFunction,
  TfShape,
  VoteMetric,
} from '../types/transferFunction';
import { validateCustomFormula, visualToRawFormula, LAYER_VAR, layerTf } from '../utils/formulaEngine';
import { normalizeUserFormulaInput } from '../utils/formulaEngine';
import { parseFormula, serializeAst, walkAst, type AstNode, type CallNode } from '../utils/formulaParser';
import { detectSimpleStructure, type SimpleStructure, type SimpleTerm } from '../utils/formulaParser';
import CurveEditor from './CurveEditor';
import WindRoseEditor from './WindRoseEditor';
import './FormulaBar.css';

/** Mapping from vote sub-layer IDs to their VoteMetric key. */
const VOTE_ID_TO_METRIC: Record<string, VoteMetric> = {
  votesLeft: 'leftPct',
  votesRight: 'rightPct',
  votesIndep: 'independencePct',
  votesUnionist: 'unionistPct',
  votesTurnout: 'turnoutPct',
};

const TF_FN_NAMES = new Set(['SIN', 'INVSIN', 'RANGE', 'INVRANGE']);

function fmtN(v: number): string {
  return Number.isInteger(v) ? String(v) : parseFloat(v.toFixed(2)).toString();
}

function tfFnName(tf: TransferFunction): 'SIN' | 'INVSIN' | 'RANGE' | 'INVRANGE' {
  switch (tf.shape ?? 'sin') {
    case 'invsin': return 'INVSIN';
    case 'range': return 'RANGE';
    case 'invrange': return 'INVRANGE';
    default: return 'SIN';
  }
}

function buildLayerFormulaTerm(id: LayerId, configs: LayerConfigs): string | null {
  const tf = layerTf(id, configs);
  const varName = LAYER_VAR[id];
  if (!tf || !varName) return null;
  const fn = tfFnName(tf);
  const args = [varName, fmtN(tf.plateauEnd), fmtN(tf.decayEnd)];
  const high = tf.ceiling ?? 1;
  if (high !== 1 || tf.floor !== 0) args.push(fmtN(high), fmtN(tf.floor));
  return `1 * ${fn}(${args.join(', ')})`;
}

function opPrec(op: string): number {
  if (['<', '>', '<=', '>=', '==', '!='].includes(op)) return 1;
  if (op === '+' || op === '-') return 2;
  if (op === '*' || op === '/') return 3;
  if (op === '^') return 4;
  return 0;
}

function needsParen(child: AstNode, parentOp: string, side: 'left' | 'right'): boolean {
  if (child.kind !== 'binop') return false;
  const cp = opPrec(child.op);
  const pp = opPrec(parentOp);
  if (cp < pp) return true;
  if (cp === pp && side === 'right' && (parentOp === '-' || parentOp === '/')) return true;
  return false;
}

function tfCallFromNode(node: AstNode): { call: CallNode; varName: string } | null {
  if (node.kind !== 'call') return null;
  if (!TF_FN_NAMES.has(node.name)) return null;
  const first = node.args[0];
  if (!first || first.kind !== 'identifier') return null;
  return { call: node, varName: first.name };
}

function weightedTfTerm(node: AstNode): { weight: number; call: CallNode; varName: string; weightNode: AstNode | null } | null {
  if (node.kind !== 'binop' || node.op !== '*') return null;
  const L = node.left;
  const R = node.right;
  if (L.kind === 'number') {
    const tf = tfCallFromNode(R);
    if (tf) return { weight: L.value, call: tf.call, varName: tf.varName, weightNode: L };
  }
  if (R.kind === 'number') {
    const tf = tfCallFromNode(L);
    if (tf) return { weight: R.value, call: tf.call, varName: tf.varName, weightNode: R };
  }
  if (L.kind === 'call' && L.name === 'WEIGHT' && L.args[0]?.kind === 'number') {
    const tf = tfCallFromNode(R);
    if (tf) return { weight: L.args[0].value, call: tf.call, varName: tf.varName, weightNode: L.args[0] };
  }
  if (R.kind === 'call' && R.name === 'WEIGHT' && R.args[0]?.kind === 'number') {
    const tf = tfCallFromNode(L);
    if (tf) return { weight: R.args[0].value, call: tf.call, varName: tf.varName, weightNode: R.args[0] };
  }
  return null;
}

/** Detect comparison with a known layer variable: `var < N` or `N > var` etc. */
const CMP_OPS = new Set(['<', '>', '<=', '>=', '==', '!=']);
function comparisonFromNode(node: AstNode): { varName: string; op: string; value: number; valueNode: AstNode } | null {
  if (node.kind !== 'binop' || !CMP_OPS.has(node.op)) return null;
  // var OP number
  if (node.left.kind === 'identifier' && node.right.kind === 'number') {
    return { varName: node.left.name, op: node.op, value: node.right.value, valueNode: node.right };
  }
  // number OP var  â†’  flip
  if (node.right.kind === 'identifier' && node.left.kind === 'number') {
    const flipOp: Record<string, string> = { '<': '>', '>': '<', '<=': '>=', '>=': '<=', '==': '==', '!=': '!=' };
    return { varName: node.right.name, op: flipOp[node.op] ?? node.op, value: node.left.value, valueNode: node.left };
  }
  return null;
}

/* â”€â”€â”€ Vote term labels â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */
const METRIC_LABELS: Record<VoteMetric, string> = {
  leftPct: 'Left %',
  rightPct: 'Right %',
  independencePct: 'Indep %',
  unionistPct: 'Unionist %',
  turnoutPct: 'Turnout %',
};

/* â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
   TfControls â€“ single transfer-function editor inside popover.
   â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• */

const SHAPE_OPTIONS: { value: TfShape; label: string; tip: string }[] = [
  { value: 'sin',      label: 'SIN',      tip: 'Sinusoidal decay: 1 â†’ floor' },
  { value: 'invsin',   label: 'INVSIN',   tip: 'Sinusoidal rise: floor â†’ 1' },
  { value: 'range',    label: 'RANGE',    tip: 'Linear decay: 1 â†’ floor' },
  { value: 'invrange', label: 'INVRANGE', tip: 'Linear rise: floor â†’ 1' },
];

function TfControls({
  label,
  ltc,
  onChange,
  rangeMax,
  unit,
  canChangeTier = true,
  onTierChange,
}: {
  label: string;
  ltc: LayerTransferConfig;
  onChange: (ltc: LayerTransferConfig) => void;
  rangeMax: number;
  unit: string;
  canChangeTier?: boolean;
  /** Structural tier change callback; when provided, Req/Imp checkboxes
   *  call this instead of patching the TF flags directly. */
  onTierChange?: (tier: 'guard' | 'important' | 'sum') => void;
}) {
  const t = useT();
  const tf = ltc.tf;
  const updateTf = (newTf: TransferFunction) => onChange({ ...ltc, tf: newTf });
  const shape = tf.shape ?? 'sin';
  const tierDisabledTitle = canChangeTier ? undefined : 'Simplify raw formula first';

  return (
    <div className="fb-tf-controls">
      {/* Header: label */}
      <div className="fb-tf-header">
        <span className="fb-tf-label">{label}</span>
      </div>

      {/* Row 1: Shape toggle + flags */}
      <div className="fb-tf-row fb-tf-row-shape">
        <div className="fb-tf-shape-group">
          {SHAPE_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              className={`fb-tf-shape-btn${shape === opt.value ? ' active' : ''}`}
              title={opt.tip}
              onClick={() => updateTf({ ...tf, shape: opt.value })}
            >
              {opt.label}
            </button>
          ))}
        </div>
        <div className="fb-tf-flags">
          <label className="fb-tf-flag" title={tierDisabledTitle ?? "Required â€” disqualifies municipalities outside range"}>
            <input type="checkbox" checked={tf.mandatory} disabled={!canChangeTier}
              onChange={(e) => {
                if (onTierChange) {
                  onTierChange(e.target.checked ? 'guard' : 'sum');
                } else {
                  updateTf({ ...tf, mandatory: e.target.checked, ...(e.target.checked ? { important: false } : {}) });
                }
              }} />
            <span className="fb-tf-flag-label">{t('tf.req')}</span>
          </label>
          <label className="fb-tf-flag" title={tierDisabledTitle ?? "Important â€” multiplicative soft gate outside the sum"}>
            <input type="checkbox" checked={tf.important} disabled={!canChangeTier}
              onChange={(e) => {
                if (onTierChange) {
                  onTierChange(e.target.checked ? 'important' : 'sum');
                } else {
                  updateTf({ ...tf, important: e.target.checked, ...(e.target.checked ? { mandatory: false } : {}) });
                }
              }} />
            <span className="fb-tf-flag-label">Imp</span>
          </label>
        </div>
      </div>

      {/* Row 2: Range parameters */}
      <div className="fb-tf-row fb-tf-row-params">
        <label className="fb-tf-param" title="Start of transition zone">
          <span className="fb-tf-param-label">From</span>
          <input type="number" step="0.1" value={tf.plateauEnd}
            onChange={(e) => updateTf({ ...tf, plateauEnd: +e.target.value })} />
          <span className="fb-tf-unit">{unit}</span>
        </label>
        <span className="fb-tf-arrow">â†’</span>
        <label className="fb-tf-param" title="End of transition zone">
          <span className="fb-tf-param-label">To</span>
          <input type="number" step="0.1" value={tf.decayEnd}
            onChange={(e) => updateTf({ ...tf, decayEnd: +e.target.value })} />
          <span className="fb-tf-unit">{unit}</span>
        </label>
      </div>

      {/* Row 3: Ceiling/Floor (aka strength up/down) */}
      <div className="fb-tf-row fb-tf-row-floor">
        <label className="fb-tf-param" title="Upper output bound (Ceiling / Strength up)">
          <span className="fb-tf-param-label">Ceiling â†‘</span>
          <input type="number" min="0" max="1" step="0.01" value={tf.ceiling ?? 1}
            onChange={(e) => {
              const next = Math.max(0, Math.min(1, +e.target.value));
              const low = tf.floor;
              updateTf({ ...tf, ceiling: Math.max(next, low) });
            }} />
        </label>
        <label className="fb-tf-param" title="Lower output bound (Floor / Strength down)">
          <span className="fb-tf-param-label">Floor â†“</span>
          <input type="number" min="0" max="1" step="0.01" value={tf.floor}
            onChange={(e) => {
              const next = Math.max(0, Math.min(1, +e.target.value));
              const high = tf.ceiling ?? 1;
              updateTf({ ...tf, floor: Math.min(next, high) });
            }} />
        </label>
      </div>

      {/* Curve preview */}
      <div className="fb-tf-curve">
        <CurveEditor tf={tf} rangeMax={rangeMax} unit={unit} onChange={updateTf} />
      </div>
    </div>
  );
}

/* â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
   LayerEditorContent â€“ renders the full filter editor for any layer
   inside the popover.
   â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• */

function LayerEditorContent({ layerId, canChangeTier = true, onTierChange }: { layerId: LayerId; canChangeTier?: boolean; onTierChange?: (tier: 'guard' | 'important' | 'sum') => void }) {
  const { configs, updateConfig } = useAppStore();
  const t = useT();

  switch (layerId) {
    case 'terrainSlope':
      return <TfControls label={t('fc.terrain.slope')} ltc={configs.terrain.slope}
        onChange={(ltc) => updateConfig('terrain', { ...configs.terrain, slope: ltc })}
        rangeMax={60} unit="deg" canChangeTier={canChangeTier} onTierChange={onTierChange} />;
    case 'terrainElevation':
      return <TfControls label={t('fc.terrain.elevation')} ltc={configs.terrain.elevation}
        onChange={(ltc) => updateConfig('terrain', { ...configs.terrain, elevation: ltc })}
        rangeMax={3000} unit="m" canChangeTier={canChangeTier} onTierChange={onTierChange} />;
    case 'terrainAspect':
      return (
        <div className="fb-tf-controls">
          <div className="fb-tf-header">
            <span className="fb-tf-label">{t('fc.terrain.aspect')}</span>
            <label className="fb-tf-enabled">
              M
              <input type="number" min="0" max="3" step="0.1"
                value={configs.terrain.aspectWeight}
                onChange={(e) => updateConfig('terrain', { ...configs.terrain, aspectWeight: Math.max(0, +e.target.value) })}
                style={{ width: 48 }} />
            </label>
          </div>
          <WindRoseEditor prefs={configs.terrain.aspect}
            onChange={(aspect) => updateConfig('terrain', { ...configs.terrain, aspect })} />
        </div>
      );
    case 'votesLeft':
    case 'votesRight':
    case 'votesIndep':
    case 'votesUnionist':
    case 'votesTurnout': {
      const metric = VOTE_ID_TO_METRIC[layerId];
      const term = configs.votes.terms.find((tm) => tm.metric === metric);
      if (!term) return null;
      return <TfControls
        label={METRIC_LABELS[metric]}
        ltc={term.value}
        onChange={(ltc) => {
          const terms = configs.votes.terms.map((tm) =>
            tm.metric === metric ? { ...tm, value: ltc } : tm,
          );
          updateConfig('votes', { terms });
        }}
        rangeMax={100} unit="%" canChangeTier={canChangeTier} onTierChange={onTierChange} />;
    }
    case 'transit':
      return <TfControls label={t('fc.transit.dist')} ltc={configs.transit}
        onChange={(ltc) => updateConfig('transit', ltc)} rangeMax={50} unit="km" canChangeTier={canChangeTier} onTierChange={onTierChange} />;
    case 'forest':
      return <TfControls label={t('fc.forest.cover')} ltc={configs.forest}
        onChange={(ltc) => updateConfig('forest', ltc)} rangeMax={100} unit="%" canChangeTier={canChangeTier} onTierChange={onTierChange} />;
    case 'airQualityPm10':
      return <TfControls label={t('fc.airQuality.pm10')} ltc={configs.airQuality.pm10}
        onChange={(ltc) => updateConfig('airQuality', { ...configs.airQuality, pm10: ltc })}
        rangeMax={100} unit="ug/m3" canChangeTier={canChangeTier} onTierChange={onTierChange} />;
    case 'airQualityNo2':
      return <TfControls label={t('fc.airQuality.no2')} ltc={configs.airQuality.no2}
        onChange={(ltc) => updateConfig('airQuality', { ...configs.airQuality, no2: ltc })}
        rangeMax={100} unit="ug/m3" canChangeTier={canChangeTier} onTierChange={onTierChange} />;
    case 'crime':
      return <TfControls label={t('fc.crime.rate')} ltc={configs.crime}
        onChange={(ltc) => updateConfig('crime', ltc)} rangeMax={100} unit="per 1k" canChangeTier={canChangeTier} onTierChange={onTierChange} />;
    case 'healthcare':
      return <TfControls label={t('fc.healthcare.dist')} ltc={configs.healthcare}
        onChange={(ltc) => updateConfig('healthcare', ltc)} rangeMax={50} unit="km" canChangeTier={canChangeTier} onTierChange={onTierChange} />;
    case 'schools':
      return <TfControls label={t('fc.schools.dist')} ltc={configs.schools}
        onChange={(ltc) => updateConfig('schools', ltc)} rangeMax={30} unit="km" canChangeTier={canChangeTier} onTierChange={onTierChange} />;
    case 'internet':
      return <TfControls label={t('fc.internet.fiber')} ltc={configs.internet}
        onChange={(ltc) => updateConfig('internet', ltc)} rangeMax={100} unit="%" canChangeTier={canChangeTier} onTierChange={onTierChange} />;
    case 'climateTemp':
      return <TfControls label={t('fc.climate.temp')} ltc={configs.climate.temperature}
        onChange={(ltc) => updateConfig('climate', { ...configs.climate, temperature: ltc })}
        rangeMax={35} unit="C" canChangeTier={canChangeTier} onTierChange={onTierChange} />;
    case 'climateRainfall':
      return <TfControls label={t('fc.climate.rain')} ltc={configs.climate.rainfall}
        onChange={(ltc) => updateConfig('climate', { ...configs.climate, rainfall: ltc })}
        rangeMax={1500} unit="mm" canChangeTier={canChangeTier} onTierChange={onTierChange} />;
    case 'rentalPrices':
      return <TfControls label={t('fc.rental.monthly')} ltc={configs.rentalPrices}
        onChange={(ltc) => updateConfig('rentalPrices', ltc)} rangeMax={3000} unit="EUR" canChangeTier={canChangeTier} onTierChange={onTierChange} />;
    case 'employment':
      return <TfControls label={t('fc.employment.unemployed')} ltc={configs.employment}
        onChange={(ltc) => updateConfig('employment', ltc)} rangeMax={40} unit="%" canChangeTier={canChangeTier} onTierChange={onTierChange} />;
    case 'amenities':
      return <TfControls label={t('fc.amenities.dist')} ltc={configs.amenities}
        onChange={(ltc) => updateConfig('amenities', ltc)} rangeMax={50} unit="km" canChangeTier={canChangeTier} onTierChange={onTierChange} />;
    default:
      return null;
  }
}

/* â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
   EditPopover â€“ floating editor panel above a chip on hover / pin.
   â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• */

function EditPopover({
  layer,
  anchorRect,
  weightValue,
  pinned,
  duplicateCount,
  canChangeTier = true,
  onTierChange,
  onPin,
  onClose,
  onRemove,
  onWeightChange,
  onMouseEnter,
  onMouseLeave,
}: {
  layer: LayerMeta;
  anchorRect: DOMRect | null;
  weightValue: number;
  pinned: boolean;
  duplicateCount?: number;
  canChangeTier?: boolean;
  onTierChange?: (tier: 'guard' | 'important' | 'sum') => void;
  onPin: () => void;
  onClose: () => void;
  onRemove: () => void;
  onWeightChange?: (next: number) => void;
  onMouseEnter?: () => void;
  onMouseLeave?: () => void;
}) {
  const { soloLayer, setSoloLayer } = useAppStore();
  const t = useT();
  const isSolo = soloLayer === layer.id;
  const [editingWeight, setEditingWeight] = useState(false);
  const [weightDraft, setWeightDraft] = useState(weightValue.toFixed(2));

  useEffect(() => {
    if (!editingWeight) setWeightDraft(weightValue.toFixed(2));
  }, [editingWeight, weightValue]);

  const commitWeightDraft = useCallback(() => {
    const parsed = parseFloat(weightDraft);
    if (Number.isFinite(parsed)) onWeightChange?.(Math.max(0, parsed));
    setEditingWeight(false);
  }, [onWeightChange, weightDraft]);

  // Position above the chip, clamped to viewport
  const style = useMemo(() => {
    if (!anchorRect) return { bottom: 60, left: 16 };
    const left = Math.max(8, Math.min(anchorRect.left + anchorRect.width / 2 - 180, window.innerWidth - 380));
    return { bottom: window.innerHeight - anchorRect.top + 8, left };
  }, [anchorRect]);

  return (
    <div className={`fb-popover ${pinned ? 'pinned' : ''}`}
      style={{ position: 'fixed', bottom: style.bottom, left: style.left, zIndex: 2400 }}
      onClick={onPin}
      onMouseDown={(e) => e.stopPropagation()}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}>
      {/* Header */}
      <div className="fb-popover-header">
        <span className="fb-popover-icon">{layer.icon}</span>
        <span className="fb-popover-title">
          {t(`layer.${layer.id}.label` as keyof Translations) || layer.label}
        </span>
        <div className="fb-popover-actions">
          <button className="fb-popover-minimize"
            onClick={(e) => { e.stopPropagation(); onClose(); }}
            title="Minimize editor">
            â€”
          </button>
          <button className={`fb-popover-solo ${isSolo ? 'active' : ''}`}
            onClick={(e) => { e.stopPropagation(); setSoloLayer(isSolo ? null : layer.id); }}
            title={isSolo ? t('solo.button.on' as keyof Translations) : t('solo.button.off' as keyof Translations)}>
            â—Ž
          </button>
          <button className="fb-popover-remove" onClick={(e) => { e.stopPropagation(); onRemove(); }}
            title="Remove layer">
            Ã—
          </button>
        </div>
      </div>

      {/* Weight slider */}
      <div className="fb-popover-weight">
        <span>{t('fp.weight')}</span>
        <input type="range" min="0" max={Math.max(2, weightValue)} step="0.1" value={weightValue}
          onChange={(e) => onWeightChange?.(parseFloat(e.target.value))} />
        {editingWeight ? (
          <input
            className="fb-popover-wval fb-popover-wval-input"
            type="number"
            min="0"
            step="0.1"
            value={weightDraft}
            onChange={(e) => setWeightDraft(e.target.value)}
            onBlur={commitWeightDraft}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitWeightDraft();
              if (e.key === 'Escape') { setWeightDraft(weightValue.toFixed(2)); setEditingWeight(false); }
            }}
            autoFocus
          />
        ) : (
          <span className="fb-popover-wval" onClick={() => setEditingWeight(true)} title="Click to edit weight">
            {weightValue.toFixed(1)}
          </span>
        )}
      </div>

      {duplicateCount && duplicateCount > 1 && (
        <div className="fb-formula-warning" style={{ marginBottom: 8 }}>
          <span className="fb-formula-warning-icon">!</span>
          This layer is added {duplicateCount} times
        </div>
      )}

      {/* Layer-specific controls */}
      <div className="fb-popover-body">
        <LayerEditorContent layerId={layer.id} canChangeTier={canChangeTier} onTierChange={onTierChange} />
      </div>
    </div>
  );
}

/* â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
   AddLayerButton â€“ [+] dropdown with hierarchical submenu groups.
   â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• */

/** Groups that get a hover-submenu in the [+] dropdown. */
const ADD_LAYER_GROUPS: { groupLabel: string; groupIcon: string; ids: LayerId[] }[] = [
  { groupLabel: 'Terrain', groupIcon: 'â›°', ids: ['terrainSlope', 'terrainElevation', 'terrainAspect'] },
  { groupLabel: 'Vote Sentiment', groupIcon: 'ðŸ—³', ids: ['votesLeft', 'votesRight', 'votesIndep', 'votesUnionist', 'votesTurnout'] },
  { groupLabel: 'Air Quality', groupIcon: 'ðŸŒ¬', ids: ['airQualityPm10', 'airQualityNo2'] },
  { groupLabel: 'Climate', groupIcon: 'â˜€', ids: ['climateTemp', 'climateRainfall'] },
];
const FLAT_IDS: LayerId[] = ['transit', 'forest', 'soil', 'crime', 'healthcare', 'schools', 'internet', 'noise', 'rentalPrices', 'employment', 'amenities'];

function AddLayerButton({
  enabledLayers,
  allLayers,
  onAdd,
  allowDuplicateAdds,
  varTfCounts,
}: {
  enabledLayers: LayerMeta[];
  allLayers: LayerMeta[];
  onAdd: (id: LayerId) => void;
  allowDuplicateAdds?: boolean;
  varTfCounts?: Map<LayerId, number>;
}) {
  const [open, setOpen] = useState(false);
  const [hoveredGroup, setHoveredGroup] = useState<number | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const [pos, setPos] = useState<{ bottom: number; left: number } | null>(null);
  const t = useT();

  const enabledSet = useMemo(() => new Set(enabledLayers.map((l) => l.id)), [enabledLayers]);
  const layerMap = useMemo(() => {
    const m = new Map<LayerId, LayerMeta>();
    for (const l of allLayers) m.set(l.id, l);
    return m;
  }, [allLayers]);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const handleOpen = () => {
    if (!open && btnRef.current) {
      const rect = btnRef.current.getBoundingClientRect();
      setPos({
        bottom: window.innerHeight - rect.top + 6,
        left: Math.max(8, rect.left + rect.width / 2 - 120),
      });
    }
    setOpen(!open);
    setHoveredGroup(null);
  };

  return (
    <div className="fb-add-wrap" ref={ref}>
      <button className="fb-add-btn" ref={btnRef}
        onClick={handleOpen}
        title={t('fb.addLayer' as keyof Translations)}>
        +
      </button>
      {open && pos && (
        <div className="fb-add-dropdown"
          style={{ position: 'fixed', bottom: pos.bottom, left: pos.left }}>
          <div className="fb-add-dropdown-title">{t('fb.addLayer' as keyof Translations)}</div>

          {/* Group entries with hover submenus */}
          {ADD_LAYER_GROUPS.map((group, gi) => {
            return (
              <div key={gi} className="fb-add-group"
                onMouseEnter={() => setHoveredGroup(gi)}
                onMouseLeave={() => setHoveredGroup(null)}>
                <div className="fb-add-group-label">
                  <span className="fb-dd-icon">{group.groupIcon}</span>
                  {group.groupLabel}
                  <span className="fb-add-group-arrow">â–¸</span>
                </div>
                {hoveredGroup === gi && (
                  <div className="fb-add-submenu">
                    {group.ids.map((id) => {
                      const l = layerMap.get(id);
                      if (!l) return null;
                      const isAdded = enabledSet.has(id);
                      const disabled = isAdded && !allowDuplicateAdds;
                      return (
                        <button key={id} className={`fb-add-dropdown-item ${isAdded ? 'is-added' : ''}`}
                          onClick={() => {
                            if (disabled) return;
                            onAdd(id);
                            setOpen(false);
                          }}
                          disabled={disabled}
                          title={disabled ? 'Already added' : isAdded ? 'Add again' : ''}>
                          <span className="fb-dd-icon">{l.icon}</span>
                          {t(`layer.${id}.label` as keyof Translations) || l.label}
                          {isAdded && <span className="fb-add-check">{allowDuplicateAdds ? `+${varTfCounts?.get(id) ?? 1}` : 'âœ“'}</span>}
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}

          {/* Flat entries */}
          {FLAT_IDS.map((id) => {
            const l = layerMap.get(id);
            if (!l) return null;
            const isAdded = enabledSet.has(id);
            const disabled = isAdded && !allowDuplicateAdds;
            return (
              <button key={id} className={`fb-add-dropdown-item ${isAdded ? 'is-added' : ''}`}
                onClick={() => {
                  if (disabled) return;
                  onAdd(id);
                  setOpen(false);
                }}
                disabled={disabled}
                title={disabled ? 'Already added' : isAdded ? 'Add again' : ''}>
                <span className="fb-dd-icon">{l.icon}</span>
                {t(`layer.${id}.label` as keyof Translations) || l.label}
                {isAdded && <span className="fb-add-check">{allowDuplicateAdds ? `+${varTfCounts?.get(id) ?? 1}` : 'âœ“'}</span>}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

/* â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
   ViewMenuDropdown â€“ map view settings, inlined in the formula bar.
   â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• */

function ViewMenuDropdown({ anchorRef }: { anchorRef: React.RefObject<HTMLDivElement | null> }) {
  const view = useAppStore((s) => s.view);
  const setView = useAppStore((s) => s.setView);

  // Compute fixed position from anchor
  const style = useMemo(() => {
    if (!anchorRef.current) return { bottom: 60, right: 16 };
    const rect = anchorRef.current.getBoundingClientRect();
    return {
      bottom: window.innerHeight - rect.top + 8,
      right: Math.max(8, window.innerWidth - rect.right),
    };
  }, [anchorRef]);

  return (
    <div className="fb-view-dropdown"
      style={{ position: 'fixed', bottom: style.bottom, right: style.right }}
      onMouseDown={(e) => e.stopPropagation()}>
      <div className="fb-view-title">Map Settings</div>

      <div className="fb-view-section">
        <span className="fb-view-section-label">Terrain</span>
        <label className="fb-view-toggle">
          <input type="checkbox" checked={view.show3dTerrain}
            onChange={(e) => setView({ show3dTerrain: e.target.checked })} />
          <span>3D</span>
        </label>
        <label className="fb-view-toggle">
          <input type="checkbox" checked={view.showHillshade}
            onChange={(e) => setView({ showHillshade: e.target.checked })} />
          <span>Hillshade</span>
        </label>
        <label className="fb-view-toggle">
          <input type="checkbox" checked={view.showElevationTint}
            onChange={(e) => setView({ showElevationTint: e.target.checked })} />
          <span>Elevation</span>
        </label>
        {view.show3dTerrain && (
          <div className="fb-view-slider">
            <span className="fb-view-slider-label">Exag</span>
            <input type="range" min={0.5} max={3} step={0.1}
              value={view.terrainExaggeration}
              onChange={(e) => setView({ terrainExaggeration: +e.target.value })} />
            <span className="fb-view-slider-val">{view.terrainExaggeration.toFixed(1)}</span>
          </div>
        )}
      </div>

      <div className="fb-view-section">
        <span className="fb-view-section-label">Data</span>
        <label className="fb-view-toggle">
          <input type="checkbox" checked={view.showHeatmap}
            onChange={(e) => setView({ showHeatmap: e.target.checked })} />
          <span>Heatmap</span>
        </label>
        <label className="fb-view-toggle">
          <input type="checkbox" checked={view.showChoropleth}
            onChange={(e) => setView({ showChoropleth: e.target.checked })} />
          <span>Choropleth</span>
        </label>
        {view.showHeatmap && (
          <div className="fb-view-slider">
            <span className="fb-view-slider-label">Opacity</span>
            <input type="range" min={0.1} max={1} step={0.05}
              value={view.heatmapOpacity}
              onChange={(e) => setView({ heatmapOpacity: +e.target.value })} />
            <span className="fb-view-slider-val">{view.heatmapOpacity.toFixed(2)}</span>
          </div>
        )}
      </div>

      <div className="fb-view-section">
        <span className="fb-view-section-label">Overlays</span>
        <label className="fb-view-toggle">
          <input type="checkbox" checked={view.showBorders}
            onChange={(e) => setView({ showBorders: e.target.checked })} />
          <span>Borders</span>
        </label>
        <label className="fb-view-toggle">
          <input type="checkbox" checked={view.maskDisqualifiedAsBlack}
            onChange={(e) => setView({ maskDisqualifiedAsBlack: e.target.checked })} />
          <span>Required mask black</span>
        </label>
      </div>
    </div>
  );
}

/* â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
   FormulaBar â€“ root component
   â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• */

export default function FormulaBar() {
  const {
    layers,
    configs,
    toggleLayer,
    soloLayer,
    toggleLang,
    lang,
    customFormula,
    setCustomFormula,
    formulaMode,
    setFormulaMode,
    setLayerWeight,
    updateConfig,
    layerOrder,
    setLayerOrder,
  } = useAppStore();
  const t = useT();

  const [collapsed, setCollapsed] = useState(false);
  const [viewOpen, setViewOpen] = useState(false);
  const [formulaOpen, setFormulaOpen] = useState(false);
  const [formulaDraft, setFormulaDraft] = useState(customFormula);
  const viewWrapRef = useRef<HTMLDivElement>(null);
  const formulaWrapRef = useRef<HTMLDivElement>(null);

  // Popover state
  const [hoveredChip, setHoveredChip] = useState<{ key: string; layerId: LayerId } | null>(null);
  const [pinnedChip, setPinnedChip] = useState<{ key: string; layerId: LayerId } | null>(null);
  const [popoverRect, setPopoverRect] = useState<DOMRect | null>(null);
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const chipRefs = useRef<Map<string, HTMLSpanElement>>(new Map());
  const isDraggingRef = useRef(false);
  const suppressPopoverUntilRef = useRef(0);
  const activeChip = pinnedChip ?? hoveredChip;
  const activeChipKey = activeChip?.key ?? null;
  const activeId = activeChip?.layerId ?? null;
  const activeLayer = activeId ? layers.find((l) => l.id === activeId) : null;

  const suppressPopover = useCallback((cooldownMs = 0) => {
    suppressPopoverUntilRef.current = Date.now() + cooldownMs;
    setPinnedChip(null);
    setHoveredChip(null);
  }, []);

  const isPopoverSuppressed = useCallback(
    () => isDraggingRef.current || Date.now() < suppressPopoverUntilRef.current,
    [],
  );

  // Drag-to-reorder state
  type SectionKind = 'guard' | 'important' | 'sum';
  const [dragReorder, setDragReorder] = useState<{ section: SectionKind; fromIdx: number } | null>(null);
  const [dropTarget, setDropTarget] = useState<{ section: SectionKind; idx: number } | null>(null);

  // Context menu state
  const [contextMenu, setContextMenu] = useState<{ chipKey: string; layerId: LayerId; x: number; y: number; section: SectionKind } | null>(null);

  const enabledLayers = layers.filter((l) => l.enabled);

  /** Deterministic raw formula generated from the current visual state. */
  const visualRawFormula = useMemo(
    () => visualToRawFormula(enabledLayers, configs, layerOrder),
    [enabledLayers, configs, layerOrder],
  );


  const normalizedCustom = useMemo(
    () => normalizeUserFormulaInput(customFormula).trim(),
    [customFormula],
  );

  const visualFormulaSource = useMemo(
    () => normalizedCustom || visualRawFormula,
    [normalizedCustom, visualRawFormula],
  );

  const visualAst = useMemo(() => {
    try {
      return parseFormula(visualFormulaSource);
    } catch {
      return null;
    }
  }, [visualFormulaSource]);

  /** Structural analysis of the formula for sectioned rendering. */
  const formulaSections = useMemo(() => {
    if (!visualAst) return null;
    return detectSimpleStructure(visualAst);
  }, [visualAst]);

  const buildFormulaFromSections = useCallback((sections: SimpleStructure): string => {
    const termToCall = (term: SimpleTerm) => {
      const args = [fmtN(term.M), fmtN(term.N)];
      if (term.high != null || term.low != null) {
        args.push(fmtN(term.high ?? 1), fmtN(term.low ?? 0));
      }
      return `${term.fn}(${term.varName}, ${args.join(', ')})`;
    };

    const guardParts = sections.guards.map((g) => `(${serializeAst(g)})`);
    const extraParts = sections.extras.map((e) => serializeAst(e));
    const importantParts = sections.importantTerms.map((t) => termToCall(t));
    const sumTerms = sections.terms.map((t) => `weight(${fmtN(t.weight)}) * ${termToCall(t)}`);

    // Build inner (non-guard) portion
    const innerFactors: string[] = [...extraParts, ...importantParts];
    if (sumTerms.length > 0) {
      const sumExpr = sumTerms.length > 1 ? `(${sumTerms.join(' + ')})` : sumTerms[0];
      innerFactors.push(sumExpr);
    }

    let innerStr = innerFactors.join(' * ');
    if (sumTerms.length > 0) innerStr += ' / weights';

    // Re-wrap with math function if present
    if (sections.wrapper && innerStr) {
      innerStr = `${sections.wrapper.fn}(${innerStr})`;
    }

    const factors: string[] = [...guardParts];
    if (innerStr) factors.push(innerStr);

    if (factors.length === 0) return '';
    return factors.join(' * ');
  }, []);

  const activeSumIndex = useMemo(() => {
    if (!activeChipKey?.startsWith('sum-')) return null;
    const idx = Number.parseInt(activeChipKey.slice(4), 10);
    return Number.isFinite(idx) ? idx : null;
  }, [activeChipKey]);

  const activeTermWeight = useMemo(() => {
    if (activeSumIndex == null || !formulaSections) return null;
    return formulaSections.terms[activeSumIndex]?.weight ?? null;
  }, [activeSumIndex, formulaSections]);

  const duplicateTfLayers = useMemo(() => {
    if (!visualAst) return [] as { id: LayerId; count: number; icon: string; label: string }[];
    const byVar = new Map<string, number>();
    walkAst(visualAst, (node) => {
      const tf = tfCallFromNode(node);
      if (!tf) return;
      byVar.set(tf.varName, (byVar.get(tf.varName) ?? 0) + 1);
    });

    const varToLayer = new Map<string, LayerMeta>();
    for (const layer of layers) {
      const varName = LAYER_VAR[layer.id];
      if (varName) varToLayer.set(varName, layer);
    }

    const out: { id: LayerId; count: number; icon: string; label: string }[] = [];
    for (const [varName, count] of byVar.entries()) {
      if (count < 2) continue;
      const layer = varToLayer.get(varName);
      if (!layer) continue;
      out.push({
        id: layer.id,
        count,
        icon: layer.icon,
        label: t(`layer.${layer.id}.label` as keyof Translations) || layer.label,
      });
    }
    return out;
  }, [layers, t, visualAst]);

  const activeDuplicateCount = useMemo(() => {
    if (!activeId) return 0;
    return duplicateTfLayers.find((dup) => dup.id === activeId)?.count ?? 0;
  }, [activeId, duplicateTfLayers]);

  const ensureLayerEnabled = useCallback((id: LayerId) => {
    const layer = layers.find((l) => l.id === id);
    if (layer && !layer.enabled) toggleLayer(id);
  }, [layers, toggleLayer]);

  const handlePopoverWeightChange = useCallback((next: number) => {
    const clamped = Math.max(0, parseFloat(next.toFixed(2)));

    if (normalizedCustom && formulaSections && activeSumIndex != null && formulaSections.terms[activeSumIndex]) {
      const nextTerms = formulaSections.terms.map((term, i) =>
        i === activeSumIndex ? { ...term, weight: clamped } : term,
      );
      const nextFormula = buildFormulaFromSections({
        ...formulaSections,
        terms: nextTerms,
        totalWeight: nextTerms.reduce((acc, t) => acc + t.weight, 0),
      });
      setCustomFormula(nextFormula);
      setFormulaDraft(nextFormula);

      if (activeId && activeDuplicateCount <= 1) {
        ensureLayerEnabled(activeId);
        setLayerWeight(activeId, clamped);
      }
      return;
    }

    if (activeId) {
      ensureLayerEnabled(activeId);
      setLayerWeight(activeId, clamped);
    }
  }, [activeDuplicateCount, activeId, activeSumIndex, buildFormulaFromSections, ensureLayerEnabled, formulaSections, normalizedCustom, setCustomFormula, setLayerWeight, setFormulaDraft]);

  const allowDuplicateAdds = formulaMode !== 'raw' && !!normalizedCustom;

  /**
   * The formula shown in the raw textarea.  When in Visual mode the store's
   * customFormula is empty â€” but we seed the textarea from visualRawFormula
   * when opening or switching to Raw.
   */

  const formulaValidation = useMemo(
    () => {
      // In Raw mode, validate the draft text
      if (formulaMode === 'raw') return validateCustomFormula(formulaDraft);
      // In Visual mode, always valid
      return { ok: true } as const;
    },
    [formulaDraft, formulaMode],
  );

  const handleToggleCollapsed = useCallback(() => {
    setCollapsed((prev) => {
      const next = !prev;
      if (next) {
        setPinnedChip(null);
        setHoveredChip(null);
        setViewOpen(false);
        setFormulaOpen(false);
      }
      return next;
    });
  }, []);

  /* â”€â”€ Popover hover keep-alive â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */
  const handlePopoverEnter = useCallback(() => {
    if (hoverTimer.current) clearTimeout(hoverTimer.current);
  }, []);

  const handlePopoverLeave = useCallback(() => {
    if (!pinnedChip) {
      hoverTimer.current = setTimeout(() => setHoveredChip(null), 300);
    }
  }, [pinnedChip]);

  const handlePopoverPin = useCallback(() => {
    if (activeChip && !pinnedChip) {
      setPinnedChip(activeChip);
      setHoveredChip(null);
    }
  }, [activeChip, pinnedChip]);

  const handlePopoverClose = useCallback(() => {
    setPinnedChip(null);
    setHoveredChip(null);
  }, []);

  /* â”€â”€ Chip hover / click handlers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */
  const handleChipHover = useCallback((chipKey: string, id: LayerId) => {
    if (isPopoverSuppressed()) return;
    if (hoverTimer.current) clearTimeout(hoverTimer.current);
    const el = chipRefs.current.get(chipKey);
    if (el) setPopoverRect(el.getBoundingClientRect());
    setHoveredChip({ key: chipKey, layerId: id });
  }, [isPopoverSuppressed]);

  const handleChipLeave = useCallback(() => {
    if (!pinnedChip) {
      hoverTimer.current = setTimeout(() => setHoveredChip(null), 300);
    }
  }, [pinnedChip]);

  const handleChipClick = useCallback((chipKey: string, id: LayerId) => {
    if (isPopoverSuppressed()) return;
    ensureLayerEnabled(id);
    const el = chipRefs.current.get(chipKey);
    if (el) setPopoverRect(el.getBoundingClientRect());
    if (pinnedChip?.key === chipKey) {
      setPinnedChip(null);
    } else {
      setPinnedChip({ key: chipKey, layerId: id });
      setHoveredChip(null);
    }
  }, [ensureLayerEnabled, isPopoverSuppressed, pinnedChip]);

  const handlePopoverRemove = useCallback(() => {
    if (!activeId) return;

    // â”€â”€ Section-based removal (sum-N, imp-N, guard-N, extra-N) â”€â”€
    if (normalizedCustom && formulaSections && activeChipKey) {
      const secMatch = activeChipKey.match(/^(sum|imp|guard|extra)-(\d+)/);
      if (secMatch) {
        const section = secMatch[1];
        const idx = parseInt(secMatch[2], 10);
        let next: SimpleStructure;
        switch (section) {
          case 'sum':
            next = { ...formulaSections, terms: formulaSections.terms.filter((_, i) => i !== idx) };
            break;
          case 'imp':
            next = { ...formulaSections, importantTerms: formulaSections.importantTerms.filter((_, i) => i !== idx) };
            break;
          case 'guard':
            next = { ...formulaSections, guards: formulaSections.guards.filter((_, i) => i !== idx) };
            break;
          case 'extra':
            next = { ...formulaSections, extras: formulaSections.extras.filter((_, i) => i !== idx) };
            break;
          default:
            return;
        }
        next.totalWeight = next.terms.reduce((acc, t) => acc + t.weight, 0);
        const nextFormula = buildFormulaFromSections(next);
        setCustomFormula(nextFormula);
        setFormulaDraft(nextFormula);

        // If layer no longer appears in the rebuilt formula, disable it
        const varName = LAYER_VAR[activeId];
        if (varName && nextFormula) {
          try {
            const nextAst = parseFormula(nextFormula);
            let stillUsed = false;
            walkAst(nextAst, (node) => {
              if (stillUsed) return;
              const tf = tfCallFromNode(node);
              if (tf && tf.varName === varName) { stillUsed = true; return; }
              const cmp = comparisonFromNode(node);
              if (cmp && cmp.varName === varName) stillUsed = true;
            });
            if (!stillUsed) {
              const layer = layers.find((l) => l.id === activeId);
              if (layer?.enabled) toggleLayer(activeId);
            }
          } catch { /* parse failure â€” leave layer as-is */ }
        } else if (!nextFormula) {
          // Formula emptied out â€” disable layer
          const layer = layers.find((l) => l.id === activeId);
          if (layer?.enabled) toggleLayer(activeId);
        }

        setPinnedChip(null);
        setHoveredChip(null);
        return;
      }
    }

    // â”€â”€ AST-based removal (root-... chip keys from non-sectioned rendering) â”€â”€
    if (normalizedCustom && visualAst && activeChipKey && activeChipKey.startsWith('root')) {
      const removeByKey = (node: AstNode, targetKey: string, currentKey: string): AstNode | null => {
        if (currentKey === targetKey) return null;
        if (node.kind === 'binop') {
          const left = removeByKey(node.left, targetKey, `${currentKey}-l`);
          const right = removeByKey(node.right, targetKey, `${currentKey}-r`);
          if (!left && !right) return null;
          if (!left) return right;
          if (!right) return left;
          return { ...node, left, right };
        }
        if (node.kind === 'unary') {
          const expr = removeByKey(node.expr, targetKey, `${currentKey}-u`);
          if (!expr) return null;
          return { ...node, expr };
        }
        return node;
      };

      const nextAst = removeByKey(visualAst, activeChipKey, 'root');
      const nextFormula = nextAst ? serializeAst(nextAst) : '';
      setCustomFormula(nextFormula);
      setFormulaDraft(nextFormula);

      // If this layer no longer exists in formula, disable it in visual pipeline.
      if (nextAst) {
        const varName = LAYER_VAR[activeId];
        if (varName) {
          let stillUsed = false;
          walkAst(nextAst, (node) => {
            if (stillUsed) return;
            const tf = tfCallFromNode(node);
            if (tf && tf.varName === varName) {
              stillUsed = true;
              return;
            }
            const cmp = comparisonFromNode(node);
            if (cmp && cmp.varName === varName) stillUsed = true;
          });
          if (!stillUsed) {
            const layer = layers.find((l) => l.id === activeId);
            if (layer?.enabled) toggleLayer(activeId);
          }
        }
      }

      setPinnedChip(null);
      setHoveredChip(null);
      return;
    }

    // Pure visual mode fallback: remove layer from enabled set.
    toggleLayer(activeId);
    setPinnedChip(null);
    setHoveredChip(null);
  }, [activeChipKey, activeId, buildFormulaFromSections, formulaSections, layers, normalizedCustom, setCustomFormula, toggleLayer, visualAst]);

  /* â”€â”€ [+] adds layer and pins its popover â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */
  const handleAddLayer = useCallback((id: LayerId) => {
    if (allowDuplicateAdds) {
      const tf = layerTf(id, configs);
      const varName = LAYER_VAR[id];
      if (tf && varName) {
        ensureLayerEnabled(id);
        const fn = tfFnName(tf);
        const high = tf.ceiling ?? 1;
        const newTerm: SimpleTerm = {
          weight: 1,
          fn,
          varName,
          M: tf.plateauEnd,
          N: tf.decayEnd,
          ...(high !== 1 || tf.floor !== 0 ? { high, low: tf.floor } : {}),
        };

        // Insert into the structural sum when possible, otherwise fall back
        if (formulaSections) {
          const next = buildFormulaFromSections({
            ...formulaSections,
            terms: [...formulaSections.terms, newTerm],
          });
          setCustomFormula(next);
          setFormulaDraft(next);
        } else {
          const raw = buildLayerFormulaTerm(id, configs);
          if (raw) {
            const base = normalizedCustom;
            const next = base ? `${base} + ${raw}` : raw;
            setCustomFormula(next);
            setFormulaDraft(next);
          }
        }
        setPinnedChip({ key: `layer:${id}`, layerId: id });
        return;
      }
    }

    const layer = layers.find((l) => l.id === id);
    if (layer && !layer.enabled) toggleLayer(id);
    // Open editing popover for the newly added layer
    setPinnedChip({ key: `layer:${id}`, layerId: id });
  }, [allowDuplicateAdds, buildFormulaFromSections, configs, ensureLayerEnabled, formulaSections, layers, normalizedCustom, setCustomFormula, toggleLayer]);

  /* â”€â”€ Reverse lookup: variable name â†’ LayerId â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */
  const varToLayerId = useMemo(() => {
    const m = new Map<string, LayerId>();
    for (const [id, varName] of Object.entries(LAYER_VAR)) m.set(varName, id as LayerId);
    return m;
  }, []);

  /** Per-layer TF call count across the entire AST (for +N badges). */
  const varTfCounts = useMemo(() => {
    const m = new Map<LayerId, number>();
    if (!visualAst) return m;
    walkAst(visualAst, (node) => {
      const tf = tfCallFromNode(node);
      if (!tf) return;
      const lid = varToLayerId.get(tf.varName);
      if (lid) m.set(lid, (m.get(lid) ?? 0) + 1);
    });
    return m;
  }, [visualAst, varToLayerId]);

  /* â”€â”€ Context-menu handler (right-click on chip) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */
  const handleChipContextMenu = useCallback((
    e: React.MouseEvent,
    chipKey: string,
    layerId: LayerId,
    section: 'guard' | 'important' | 'sum',
  ) => {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({ chipKey, layerId, x: e.clientX, y: e.clientY, section });
  }, []);

  /* â”€â”€ Close context menu on outside click â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */
  useEffect(() => {
    if (!contextMenu) return;
    const handler = () => setContextMenu(null);
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [contextMenu]);

  /* â”€â”€ Change layer tier (mandatory / important / sum) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */
  const patchTfFlag = useCallback((id: LayerId, patch: Partial<{ mandatory: boolean; important: boolean }>) => {
    const c = configs;
    const patchTfInner = (tf: TransferFunction) => ({ ...tf, ...patch });
    switch (id) {
      case 'terrainSlope':
        updateConfig('terrain', { ...c.terrain, slope: { ...c.terrain.slope, tf: patchTfInner(c.terrain.slope.tf) } });
        break;
      case 'terrainElevation':
        updateConfig('terrain', { ...c.terrain, elevation: { ...c.terrain.elevation, tf: patchTfInner(c.terrain.elevation.tf) } });
        break;
      case 'transit': updateConfig('transit', { ...c.transit, tf: patchTfInner(c.transit.tf) }); break;
      case 'forest': updateConfig('forest', { ...c.forest, tf: patchTfInner(c.forest.tf) }); break;
      case 'airQualityPm10':
        updateConfig('airQuality', { ...c.airQuality, pm10: { ...c.airQuality.pm10, tf: patchTfInner(c.airQuality.pm10.tf) } });
        break;
      case 'airQualityNo2':
        updateConfig('airQuality', { ...c.airQuality, no2: { ...c.airQuality.no2, tf: patchTfInner(c.airQuality.no2.tf) } });
        break;
      case 'crime': updateConfig('crime', { ...c.crime, tf: patchTfInner(c.crime.tf) }); break;
      case 'healthcare': updateConfig('healthcare', { ...c.healthcare, tf: patchTfInner(c.healthcare.tf) }); break;
      case 'schools': updateConfig('schools', { ...c.schools, tf: patchTfInner(c.schools.tf) }); break;
      case 'internet': updateConfig('internet', { ...c.internet, tf: patchTfInner(c.internet.tf) }); break;
      case 'climateTemp':
        updateConfig('climate', { ...c.climate, temperature: { ...c.climate.temperature, tf: patchTfInner(c.climate.temperature.tf) } });
        break;
      case 'climateRainfall':
        updateConfig('climate', { ...c.climate, rainfall: { ...c.climate.rainfall, tf: patchTfInner(c.climate.rainfall.tf) } });
        break;
      case 'rentalPrices': updateConfig('rentalPrices', { ...c.rentalPrices, tf: patchTfInner(c.rentalPrices.tf) }); break;
      case 'employment': updateConfig('employment', { ...c.employment, tf: patchTfInner(c.employment.tf) }); break;
      case 'amenities': updateConfig('amenities', { ...c.amenities, tf: patchTfInner(c.amenities.tf) }); break;
      default: {
        const metric = VOTE_ID_TO_METRIC[id];
        if (metric) {
          const terms = c.votes.terms.map((tm) =>
            tm.metric === metric ? { ...tm, value: { ...tm.value, tf: patchTfInner(tm.value.tf) } } : tm,
          );
          updateConfig('votes', { terms });
        }
        break;
      }
    }
  }, [configs, updateConfig]);

  /** Move a term between sections (guard â†” important â†” sum).
   *  When a customFormula is active, structurally edits formulaSections.
   *  Otherwise patches the store TF flags. */
  const handleTierChange = useCallback((
    layerId: LayerId,
    chipKey: string,
    newTier: 'guard' | 'important' | 'sum',
  ) => {
    // Determine current section from chipKey
    const secMatch = chipKey.match(/^(sum|imp|guard)-(\d+)/);
    const currentSection = secMatch ? secMatch[1] as 'sum' | 'imp' | 'guard' : null;
    const currentIdx = secMatch ? parseInt(secMatch[2], 10) : -1;

    // If custom formula is active and we have sections, structurally modify
    if (normalizedCustom && formulaSections && currentSection) {
      const next: SimpleStructure = { ...formulaSections,
        guards: [...formulaSections.guards],
        importantTerms: [...formulaSections.importantTerms],
        terms: [...formulaSections.terms],
        extras: [...formulaSections.extras],
      };

      // Extract the term/guard from its current section
      let term: SimpleTerm | null = null;
      let guardNode: { varName: string; op: string; value: number } | null = null;

      if (currentSection === 'sum' && currentIdx < next.terms.length) {
        term = next.terms[currentIdx];
        next.terms.splice(currentIdx, 1);
      } else if (currentSection === 'imp' && currentIdx < next.importantTerms.length) {
        term = next.importantTerms[currentIdx];
        next.importantTerms.splice(currentIdx, 1);
      } else if (currentSection === 'guard' && currentIdx < next.guards.length) {
        const g = next.guards[currentIdx];
        next.guards.splice(currentIdx, 1);
        // Extract guard info
        if (g.left.kind === 'identifier' && g.right.kind === 'number') {
          guardNode = { varName: g.left.name, op: g.op, value: g.right.value };
        }
      }

      // Insert into the new section
      if (newTier === 'guard') {
        // Convert term â†’ comparison guard: `var < decayEnd`
        const varName = term?.varName ?? guardNode?.varName;
        const guardVal = term?.N ?? guardNode?.value ?? 100;
        if (varName) {
          const guardAst: import('../utils/formulaParser').BinopNode = {
            kind: 'binop',
            op: '<',
            left: { kind: 'identifier', name: varName },
            right: { kind: 'number', value: guardVal },
          };
          next.guards.push(guardAst);
        }
      } else if (newTier === 'important') {
        if (term) {
          next.importantTerms.push(term);
        } else if (guardNode) {
          // guard â†’ important: create a TF term from store config defaults
          const lid = varToLayerId.get(guardNode.varName);
          const tf = lid ? layerTf(lid, configs) : null;
          const newTerm: SimpleTerm = {
            weight: 1,
            fn: tf ? tfFnName(tf) : 'SIN',
            varName: guardNode.varName,
            M: tf?.plateauEnd ?? 0,
            N: tf?.decayEnd ?? guardNode.value,
          };
          if (tf && ((tf.ceiling ?? 1) !== 1 || tf.floor !== 0)) {
            newTerm.high = tf.ceiling ?? 1;
            newTerm.low = tf.floor;
          }
          next.importantTerms.push(newTerm);
        }
      } else {
        // sum
        if (term) {
          // Preserve weight if it already had one, else default to 1
          if (term.weight === 0) term = { ...term, weight: 1 };
          next.terms.push(term);
        } else if (guardNode) {
          // guard â†’ sum: create a TF term from store config defaults
          const lid = varToLayerId.get(guardNode.varName);
          const tf = lid ? layerTf(lid, configs) : null;
          const newTerm: SimpleTerm = {
            weight: 1,
            fn: tf ? tfFnName(tf) : 'SIN',
            varName: guardNode.varName,
            M: tf?.plateauEnd ?? 0,
            N: tf?.decayEnd ?? guardNode.value,
          };
          if (tf && ((tf.ceiling ?? 1) !== 1 || tf.floor !== 0)) {
            newTerm.high = tf.ceiling ?? 1;
            newTerm.low = tf.floor;
          }
          next.terms.push(newTerm);
        }
      }

      next.totalWeight = next.terms.reduce((acc, t) => acc + t.weight, 0);
      const nextFormula = buildFormulaFromSections(next);
      setCustomFormula(nextFormula);
      setFormulaDraft(nextFormula);
    }

    // Also patch store flags so visual mode stays in sync
    switch (newTier) {
      case 'guard':
        patchTfFlag(layerId, { mandatory: true, important: false });
        break;
      case 'important':
        patchTfFlag(layerId, { mandatory: false, important: true });
        break;
      case 'sum':
        patchTfFlag(layerId, { mandatory: false, important: false });
        break;
    }

    // If no custom formula was active, clear stale drafts so visual mode
    // regenerates from the updated configs immediately.
    if (!normalizedCustom) {
      setCustomFormula('');
      setFormulaDraft('');
    }
  }, [buildFormulaFromSections, configs, formulaSections, normalizedCustom, patchTfFlag, setCustomFormula, varToLayerId]);

  const handleContextAction = useCallback((action: 'mandatory' | 'important' | 'sum' | 'remove') => {
    if (!contextMenu) return;
    const { layerId, chipKey } = contextMenu;
    if (action === 'remove') {
      handlePopoverRemove();
    } else {
      const tier = action === 'mandatory' ? 'guard' : action;
      handleTierChange(layerId, chipKey, tier as 'guard' | 'important' | 'sum');
    }
    setContextMenu(null);
  }, [contextMenu, handlePopoverRemove, handleTierChange]);

  /* â”€â”€ Pointer-based chip drag (angle-disambiguated) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
   *
   * pointerdown on a chip records start position + context.
   * After 5 px of movement the angle decides the mode:
   *   â€¢ horizontal Â±14Â° â†’ chip reorder
   *   â€¢ vertical   Â±20Â° from 90Â° â†’ value adjustment (weight / param)
   * â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */
  const REORDER_HALF_ANGLE = 14;  // degrees from horizontal
  const ADJUST_HALF_ANGLE = 20;   // degrees from vertical
  const INTENT_THRESHOLD = 5;     // px before deciding

  type ChipDragIntent = 'pending' | 'reorder' | 'adjust' | 'none';
  const chipDragRef = useRef<{
    intent: ChipDragIntent;
    startX: number;
    startY: number;
    pointerId: number;
    section: SectionKind;
    idx: number;
    /* value-adjust fields (only when target is a draggable number) */
    adjustStartVal: number;
    adjustStep: number;
    adjustCb: ((v: number) => void) | null;
    /** When true, skip angle gate and go straight to adjust mode. */
    adjustOnly: boolean;
  } | null>(null);

  /** All chip elements by section-idx key, for hit-testing during reorder. */
  const sectionChipRefs = useRef<Map<string, HTMLSpanElement>>(new Map());
  /** Section container elements for cross-section drag detection. */
  const sectionElRefs = useRef<Map<SectionKind, HTMLSpanElement>>(new Map());

  const executeReorder = useCallback((section: SectionKind, fromIdx: number, toIdx: number) => {
    if (fromIdx === toIdx) return;

    // Custom formula path: structurally reorder inside formulaSections, rebuild
    if (normalizedCustom && formulaSections) {
      const next: SimpleStructure = { ...formulaSections,
        guards: [...formulaSections.guards],
        importantTerms: [...formulaSections.importantTerms],
        terms: [...formulaSections.terms],
        extras: [...formulaSections.extras],
      };
      let arr: unknown[] | null = null;
      switch (section) {
        case 'sum': arr = next.terms; break;
        case 'important': arr = next.importantTerms; break;
        case 'guard': arr = next.guards; break;
      }
      if (arr && fromIdx < arr.length) {
        const [moved] = arr.splice(fromIdx, 1);
        arr.splice(toIdx, 0, moved);
        next.totalWeight = next.terms.reduce((acc, t) => acc + t.weight, 0);
        const nextFormula = buildFormulaFromSections(next);
        setCustomFormula(nextFormula);
        setFormulaDraft(nextFormula);
      }
      return;
    }

    // Pure visual mode: reorder via layerOrder (sum section only)
    if (section === 'sum' && formulaSections) {
      const sumTerms = formulaSections.terms;
      const sumVarNames = sumTerms.map(t => t.varName);
      const sumLayerIds = sumVarNames.map(vn => varToLayerId.get(vn)).filter(Boolean) as LayerId[];
      const newOrder = [...sumLayerIds];
      const [moved] = newOrder.splice(fromIdx, 1);
      newOrder.splice(toIdx, 0, moved);
      const sumSet = new Set(sumLayerIds);
      const otherLayers = layerOrder.filter(id => !sumSet.has(id));
      setLayerOrder([...otherLayers, ...newOrder]);
    }
  }, [buildFormulaFromSections, formulaSections, layerOrder, normalizedCustom, setCustomFormula, setLayerOrder, varToLayerId]);

  /** Find the closest chip index in a given section based on pointer X. */
  const findDropIndex = useCallback((section: SectionKind, clientX: number, fromIdx: number): number => {
    let best = fromIdx;
    let bestDist = Infinity;
    sectionChipRefs.current.forEach((el, key) => {
      if (!key.startsWith(section + '-')) return;
      const idx = parseInt(key.split('-')[1], 10);
      const rect = el.getBoundingClientRect();
      const cx = rect.left + rect.width / 2;
      const dist = Math.abs(clientX - cx);
      if (dist < bestDist) { bestDist = dist; best = idx; }
    });
    return best;
  }, []);

  /** Detect which section the pointer is hovering over by DOM position. */
  const findHoveredSection = useCallback((clientX: number, clientY: number): SectionKind | null => {
    let bestSection: SectionKind | null = null;
    let bestDist = Infinity;
    sectionElRefs.current.forEach((el, sec) => {
      const rect = el.getBoundingClientRect();
      // Check vertical overlap (generous â€” chip might be above or below)
      if (clientY < rect.top - 20 || clientY > rect.bottom + 20) return;
      // Horizontal distance: if inside rect â†’ 0, else distance to nearest edge
      const dx = clientX < rect.left ? rect.left - clientX : clientX > rect.right ? clientX - rect.right : 0;
      if (dx < bestDist) { bestDist = dx; bestSection = sec; }
    });
    return bestSection;
  }, []);

  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      const cd = chipDragRef.current;
      if (!cd) return;

      const dx = e.clientX - cd.startX;
      const dy = e.clientY - cd.startY;
      const dist = Math.sqrt(dx * dx + dy * dy);

      if (cd.intent === 'pending') {
        if (dist < INTENT_THRESHOLD) return; // wait for threshold

        // When the user started on a draggable number (adjustOnly flag),
        // skip angle gating and go straight to value-adjust mode.
        if (cd.adjustOnly && cd.adjustCb) {
          cd.intent = 'adjust';
          document.body.style.cursor = 'ns-resize';
        } else {
          const angleDeg = Math.abs(Math.atan2(dy, dx) * 180 / Math.PI);
          // Horizontal band: angle âˆˆ [0, REORDER_HALF_ANGLE] or [180-R, 180]
          const isHorizontal = angleDeg < REORDER_HALF_ANGLE || angleDeg > (180 - REORDER_HALF_ANGLE);
          // Vertical band: angle âˆˆ [90-A, 90+A]
          const isVertical = Math.abs(angleDeg - 90) < ADJUST_HALF_ANGLE;

          if (isHorizontal) {
            cd.intent = 'reorder';
            setDragReorder({ section: cd.section, fromIdx: cd.idx });
            document.body.style.cursor = 'grabbing';
          } else if (isVertical && cd.adjustCb) {
            cd.intent = 'adjust';
            document.body.style.cursor = 'ns-resize';
          } else {
            cd.intent = 'none'; // diagonal â€” ignore
          }
        }
      }

      if (cd.intent === 'reorder') {
        // Detect if pointer has moved into a different section area
        const hoveredSection = findHoveredSection(e.clientX, e.clientY);
        const targetSection = hoveredSection ?? cd.section;
        const toIdx = findDropIndex(targetSection, e.clientX, targetSection === cd.section ? cd.idx : 0);
        setDropTarget({ section: targetSection, idx: toIdx });
      }

      if (cd.intent === 'adjust' && cd.adjustCb) {
        const upDy = cd.startY - e.clientY; // up = positive
        cd.adjustCb(parseFloat((cd.adjustStartVal + upDy * cd.adjustStep).toFixed(2)));
      }
    };

    const onUp = (e: PointerEvent) => {
      const cd = chipDragRef.current;
      if (!cd) return;
      if (cd.intent === 'reorder' && dropTarget) {
        if (dropTarget.section !== cd.section) {
          // Cross-section drop -> tier change
          const chipKey = `${cd.section === 'guard' ? 'guard' : cd.section === 'important' ? 'imp' : 'sum'}-${cd.idx}`;
          let layerId: LayerId | null = null;
          if (formulaSections) {
            const sec = cd.section;
            if (sec === 'sum' && cd.idx < formulaSections.terms.length) {
              layerId = varToLayerId.get(formulaSections.terms[cd.idx].varName) ?? null;
            } else if (sec === 'important' && cd.idx < formulaSections.importantTerms.length) {
              layerId = varToLayerId.get(formulaSections.importantTerms[cd.idx].varName) ?? null;
            } else if (sec === 'guard' && cd.idx < formulaSections.guards.length) {
              const g = formulaSections.guards[cd.idx];
              if (g.left.kind === 'identifier') layerId = varToLayerId.get(g.left.name) ?? null;
            }
          }
          if (layerId) {
            handleTierChange(layerId, chipKey, dropTarget.section);
          }
        } else {
          executeReorder(cd.section, cd.idx, dropTarget.idx);
        }
      }
      chipDragRef.current = null;
      isDraggingRef.current = false;
      suppressPopover(260);
      setDragReorder(null);
      setDropTarget(null);
      document.body.style.cursor = '';
      try { (e.target as HTMLElement).releasePointerCapture(cd.pointerId); } catch { /* ok */ }
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
  }, [dropTarget, executeReorder, findDropIndex, findHoveredSection, formulaSections, handleTierChange, suppressPopover, varToLayerId]);

  /** Start chip drag intent tracking. Call from onPointerDown on the chip. */
  const startChipDrag = useCallback((
    e: React.PointerEvent,
    section: SectionKind,
    idx: number,
    adjustVal?: number,
    adjustStep?: number,
    adjustCb?: (v: number) => void,
  ) => {
    e.preventDefault();
    e.stopPropagation();
    isDraggingRef.current = true;
    suppressPopover();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    // Detect if target is a draggable number element â€” skip angle gate if so
    const target = e.target as HTMLElement;
    const isNumberTarget = target.classList.contains('fb-chip-weight')
      || target.classList.contains('fb-chip-param-m')
      || target.classList.contains('fb-chip-param-n')
      || target.classList.contains('fb-cmp-val');
    chipDragRef.current = {
      intent: 'pending',
      startX: e.clientX,
      startY: e.clientY,
      pointerId: e.pointerId,
      section,
      idx,
      adjustStartVal: adjustVal ?? 0,
      adjustStep: adjustStep ?? 0.01,
      adjustCb: adjustCb ?? null,
      adjustOnly: isNumberTarget && !!adjustCb,
    };
  }, [suppressPopover]);

  /* â”€â”€ Drag-to-adjust helper â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */
  const dragState = useRef<{
    startY: number;
    startVal: number;
    step: number;
    onDelta: (val: number) => void;
  } | null>(null);

  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      const ds = dragState.current;
      if (!ds) return;
      const dy = ds.startY - e.clientY; // up = positive
      ds.onDelta(parseFloat((ds.startVal + dy * ds.step).toFixed(2)));
    };
    const onUp = () => {
      if (!dragState.current) return;
      dragState.current = null;
      isDraggingRef.current = false;
      suppressPopover(260);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
  }, [suppressPopover]);

  const startDrag = useCallback((e: React.PointerEvent, startVal: number, onDelta: (v: number) => void, step: number) => {
    e.preventDefault();
    e.stopPropagation();
    isDraggingRef.current = true;
    suppressPopover();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    dragState.current = { startY: e.clientY, startVal, step, onDelta };
  }, [suppressPopover]);

  /* â”€â”€ Mutate an AST number node and re-serialize into customFormula â”€â”€ */
  const patchAstNumber = useCallback((node: AstNode, newVal: number) => {
    if (!visualAst) return;
    if (node.kind === 'number') node.value = newVal;
    const newFormula = serializeAst(visualAst);
    setCustomFormula(newFormula);
    setFormulaDraft(newFormula);
  }, [visualAst, setCustomFormula]);

  /* â”€â”€ Patch a single TF parameter in the store (standard visual mode) â”€â”€ */
  const patchTfParam = useCallback((id: LayerId, param: 'plateauEnd' | 'decayEnd', value: number) => {
    const c = configs;
    switch (id) {
      case 'terrainSlope':
        updateConfig('terrain', { ...c.terrain, slope: { ...c.terrain.slope, tf: { ...c.terrain.slope.tf, [param]: value } } });
        break;
      case 'terrainElevation':
        updateConfig('terrain', { ...c.terrain, elevation: { ...c.terrain.elevation, tf: { ...c.terrain.elevation.tf, [param]: value } } });
        break;
      case 'transit':
        updateConfig('transit', { ...c.transit, tf: { ...c.transit.tf, [param]: value } });
        break;
      case 'forest':
        updateConfig('forest', { ...c.forest, tf: { ...c.forest.tf, [param]: value } });
        break;
      case 'airQualityPm10':
        updateConfig('airQuality', { ...c.airQuality, pm10: { ...c.airQuality.pm10, tf: { ...c.airQuality.pm10.tf, [param]: value } } });
        break;
      case 'airQualityNo2':
        updateConfig('airQuality', { ...c.airQuality, no2: { ...c.airQuality.no2, tf: { ...c.airQuality.no2.tf, [param]: value } } });
        break;
      case 'crime':
        updateConfig('crime', { ...c.crime, tf: { ...c.crime.tf, [param]: value } });
        break;
      case 'healthcare':
        updateConfig('healthcare', { ...c.healthcare, tf: { ...c.healthcare.tf, [param]: value } });
        break;
      case 'schools':
        updateConfig('schools', { ...c.schools, tf: { ...c.schools.tf, [param]: value } });
        break;
      case 'internet':
        updateConfig('internet', { ...c.internet, tf: { ...c.internet.tf, [param]: value } });
        break;
      case 'climateTemp':
        updateConfig('climate', { ...c.climate, temperature: { ...c.climate.temperature, tf: { ...c.climate.temperature.tf, [param]: value } } });
        break;
      case 'climateRainfall':
        updateConfig('climate', { ...c.climate, rainfall: { ...c.climate.rainfall, tf: { ...c.climate.rainfall.tf, [param]: value } } });
        break;
      case 'rentalPrices':
        updateConfig('rentalPrices', { ...c.rentalPrices, tf: { ...c.rentalPrices.tf, [param]: value } });
        break;
      case 'employment':
        updateConfig('employment', { ...c.employment, tf: { ...c.employment.tf, [param]: value } });
        break;
      case 'amenities':
        updateConfig('amenities', { ...c.amenities, tf: { ...c.amenities.tf, [param]: value } });
        break;
      default: {
        const metric = VOTE_ID_TO_METRIC[id];
        if (metric) {
          const terms = c.votes.terms.map((tm) =>
            tm.metric === metric ? { ...tm, value: { ...tm.value, tf: { ...tm.value.tf, [param]: value } } } : tm,
          );
          updateConfig('votes', { terms });
        }
        break;
      }
    }
  }, [configs, updateConfig]);

  /* â”€â”€ Compact chip for a recognized TF term â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */
  const showParams = formulaMode === 'visual' || formulaMode === 'math'; // visual-short & math-short hide M,N
  const isMathMode = formulaMode === 'math-short' || formulaMode === 'math';
  const renderCompactChip = useCallback((
    layerId: LayerId | null,
    icon: string,
    weightNode: AstNode | null,
    weightVal: number,
    call: CallNode,
    chipKey: string,
  ): React.ReactNode => {
    const mArg = call.args[1]; // plateauEnd
    const nArg = call.args[2]; // decayEnd
    const mVal = mArg?.kind === 'number' ? mArg.value : null;
    const nVal = nArg?.kind === 'number' ? nArg.value : null;
    const isActive = activeChipKey === chipKey;
    const isSolo = layerId != null && soloLayer === layerId;
    const isCustom = !!normalizedCustom;
    const duplicateCount = layerId ? (duplicateTfLayers.find((d) => d.id === layerId)?.count ?? 0) : 0;
    const canSyncStore = !isCustom || duplicateCount <= 1;
    const chipCls = `fb-chip${isActive ? ' active' : ''}${isSolo ? ' solo' : ''}`;
    const title = `${call.name}(${call.args.map((a) => a.kind === 'number' ? fmtN(a.value) : a.kind === 'identifier' ? a.name : 'â€¦').join(', ')})`;

    /* drag callbacks: always sync store configs; also patch AST in custom mode */
    const onWeightDrag = (v: number) => {
      const clamped = Math.max(0, parseFloat(v.toFixed(2)));
      if (layerId && canSyncStore) {
        ensureLayerEnabled(layerId);
        setLayerWeight(layerId, clamped);
      }
      if (isCustom && weightNode) patchAstNumber(weightNode, clamped);
    };
    const onMDrag = mArg ? (v: number) => {
      if (layerId && canSyncStore) {
        ensureLayerEnabled(layerId);
        patchTfParam(layerId, 'plateauEnd', v);
      }
      if (isCustom) patchAstNumber(mArg, v);
    } : undefined;
    const onNDrag = nArg ? (v: number) => {
      if (layerId && canSyncStore) {
        ensureLayerEnabled(layerId);
        patchTfParam(layerId, 'decayEnd', v);
      }
      if (isCustom) patchAstNumber(nArg, v);
    } : undefined;

    /** Step per pixel: weight is fine-grained, M/N proportional to magnitude */
    const wStep = 0.01;
    const paramStep = (val: number) => Math.max(0.2, Math.abs(val) * 0.002);

    return (
      <span
        key={chipKey}
        className={chipCls}
        title={title}
        ref={(el) => { if (el) chipRefs.current.set(chipKey, el); }}
        onMouseEnter={() => layerId && handleChipHover(chipKey, layerId)}
        onMouseLeave={handleChipLeave}
        onClick={(e) => { e.stopPropagation(); layerId && handleChipClick(chipKey, layerId); }}
      >
        <span
          className="fb-chip-weight"
          onPointerDown={(e) => startDrag(e, weightVal, onWeightDrag, wStep)}
        >
          {fmtN(weightVal)}
        </span>
        <span className="fb-chip-icon">{icon}</span>
        {showParams && mVal != null && (
          <span
            className="fb-chip-param"
            onPointerDown={onMDrag ? (e) => startDrag(e, mVal, onMDrag, paramStep(mVal)) : undefined}
          >
            {fmtN(mVal)}
          </span>
        )}
        {showParams && mVal != null && nVal != null && <span className="fb-chip-comma">,</span>}
        {showParams && nVal != null && (
          <span
            className="fb-chip-param"
            onPointerDown={onNDrag ? (e) => startDrag(e, nVal, onNDrag, paramStep(nVal)) : undefined}
          >
            {fmtN(nVal)}
          </span>
        )}
      </span>
    );
  }, [activeChipKey, duplicateTfLayers, ensureLayerEnabled, soloLayer, normalizedCustom, configs, setLayerWeight, patchAstNumber, patchTfParam, startDrag, handleChipHover, handleChipLeave, handleChipClick, showParams]);

  const renderVisualNode = useCallback((node: AstNode, key: string): React.ReactNode => {
    /* â”€â”€ Weighted TF term: w * SHAPE(var, M, N) â†’ compact chip â”€â”€ */
    const weighted = weightedTfTerm(node);
    if (weighted) {
      const layerId = varToLayerId.get(weighted.varName) ?? null;
      const layer = layerId ? layers.find((l) => l.id === layerId) : null;
      return renderCompactChip(layerId, layer?.icon ?? 'Æ’', weighted.weightNode, weighted.weight, weighted.call, key);
    }

    /* â”€â”€ Bare TF call: SHAPE(var, M, N) without weight â†’ chip w=1 â”€â”€ */
    const tf = tfCallFromNode(node);
    if (tf) {
      const layerId = varToLayerId.get(tf.varName) ?? null;
      const layer = layerId ? layers.find((l) => l.id === layerId) : null;
      return renderCompactChip(layerId, layer?.icon ?? 'Æ’', null, 1, tf.call, key);
    }

    /* â”€â”€ Comparison: var < N  â†’  visual badge â”€â”€ */
    const cmp = comparisonFromNode(node);
    if (cmp) {
      const layerId = varToLayerId.get(cmp.varName) ?? null;
      const layer = layerId ? layers.find((l) => l.id === layerId) : null;
      const isActive = activeChipKey === key;
      const cls = `fb-chip fb-cmp-chip${isActive ? ' active' : ''}`;
      const onCmpDrag = (v: number) => {
        if (layerId) ensureLayerEnabled(layerId);
        patchAstNumber(cmp.valueNode, Math.max(0, parseFloat(v.toFixed(2))));
      };
      return (
        <span
          className={cls}
          key={key}
          title={`${cmp.varName} ${cmp.op} ${fmtN(cmp.value)}`}
          ref={(el) => { if (el) chipRefs.current.set(key, el); }}
          onMouseEnter={() => layerId && handleChipHover(key, layerId)}
          onMouseLeave={handleChipLeave}
          onClick={(e) => { e.stopPropagation(); layerId && handleChipClick(key, layerId); }}
        >
          <span className="fb-chip-icon">{layer?.icon ?? cmp.varName}</span>
          <span className="fb-cmp-op">{cmp.op}</span>
          <span className="fb-cmp-val" onPointerDown={(e) => startDrag(e, cmp.value, onCmpDrag, 0.05)}>{fmtN(cmp.value)}</span>
        </span>
      );
    }

    /* â”€â”€ Generic AST nodes â”€â”€ */
    if (node.kind === 'number') {
      const numStep = Math.max(0.01, Math.abs(node.value) * 0.005);
      return (
        <span
          className="fb-ast-token fb-draggable-num"
          key={key}
          title={`${fmtN(node.value)} â€” drag â†• to adjust`}
          onPointerDown={(e) => startDrag(e, node.value, (v) => patchAstNumber(node, parseFloat(v.toFixed(4))), numStep)}
        >
          {fmtN(node.value)}
        </span>
      );
    }
    if (node.kind === 'identifier') return <span className="fb-ast-token" key={key}>{node.name}</span>;
    if (node.kind === 'unary') {
      return (
        <span className="fb-ast-expr" key={key}>
          <span className="fb-op">{node.op}</span>
          {renderVisualNode(node.expr, `${key}-u`)}
        </span>
      );
    }
    if (node.kind === 'call') {
      /* Math-mode rendering for known wrapper functions */
      if (isMathMode && node.args.length === 1) {
        const inner = renderVisualNode(node.args[0], `${key}-arg0`);
        if (node.name === 'SQRT') {
          return (
            <span className="fb-paren-group fb-radical" key={key} title="SQRT(â€¦)">
              <span className="fb-radical-sign">âˆš</span>
              <span className="fb-radical-content">{inner}</span>
            </span>
          );
        }
        if (node.name === 'ABS') {
          return (
            <span className="fb-paren-group fb-abs-wrap" key={key} title="ABS(â€¦)">
              <span className="fb-abs-bar">|</span>
              {inner}
              <span className="fb-abs-bar">|</span>
            </span>
          );
        }
        const MATH_FN_LABELS: Record<string, string> = {
          LOG: 'log', LOG2: 'logâ‚‚', LOG10: 'logâ‚â‚€',
          EXP: 'eË£', SIGN: 'sgn', FLOOR: 'âŒŠâŒ‹', CEIL: 'âŒˆâŒ‰', ROUND: 'â‰ˆ',
          COS: 'cos', SIN: 'sin', TAN: 'tan', ACOS: 'acos', ASIN: 'asin', ATAN: 'atan',
        };
        const mathLabel = MATH_FN_LABELS[node.name];
        if (mathLabel) {
          return (
            <span className="fb-paren-group fb-math-fn" key={key} title={`${node.name}(â€¦)`}>
              <span className="fb-math-fn-label">{mathLabel}</span>
              <span className="fb-paren">(</span>
              {inner}
              <span className="fb-paren">)</span>
            </span>
          );
        }
      }
      return (
        <span className="fb-ast-token fb-paren-group" key={key}>
          {node.name}(
          {node.args.map((a, i) => (
            <span key={`${key}-a${i}`}>
              {i > 0 && <span className="fb-op">,</span>}
              {renderVisualNode(a, `${key}-arg${i}`)}
            </span>
          ))}
          )
        </span>
      );
    }
    if (node.kind === 'binop') {
      const left = renderVisualNode(node.left, `${key}-l`);
      const right = renderVisualNode(node.right, `${key}-r`);
      const leftWrapped = needsParen(node.left, node.op, 'left');
      const rightWrapped = needsParen(node.right, node.op, 'right');
      return (
        <span className="fb-ast-expr" key={key}>
          {leftWrapped ? <span className="fb-paren-group"><span className="fb-paren">(</span>{left}<span className="fb-paren">)</span></span> : left}
          <span className="fb-op">{node.op}</span>
          {rightWrapped ? <span className="fb-paren-group"><span className="fb-paren">(</span>{right}<span className="fb-paren">)</span></span> : right}
        </span>
      );
    }
    return <span className="fb-ast-token" key={key}>?</span>;
  }, [activeChipKey, ensureLayerEnabled, handleChipClick, handleChipHover, handleChipLeave, isMathMode, layers, patchAstNumber, renderCompactChip, startDrag, varToLayerId]);

  /* â”€â”€ Render a SimpleTerm as a chip â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */
  const renderSimpleTerm = useCallback((term: SimpleTerm, chipKey: string, section: 'guard' | 'important' | 'sum', idx: number) => {
    const layerId = varToLayerId.get(term.varName) ?? null;
    const layer = layerId ? layers.find((l) => l.id === layerId) : null;
    const icon = layer?.icon ?? 'Æ’';
    const isActive = activeChipKey === chipKey;
    const isSolo = layerId != null && soloLayer === layerId;
    const sectionKey = section === 'important' ? 'important' : section;
    const isDragging = dragReorder?.section === sectionKey && dragReorder?.fromIdx === idx;
    const cls = `fb-chip${isActive ? ' active' : ''}${isSolo ? ' solo' : ''}${isDragging ? ' fb-chip-dragging' : ''}`;
    const title = `${term.fn}(${term.varName}, ${fmtN(term.M)}, ${fmtN(term.N)})`;
    const isDragTarget = dropTarget?.section === section && dropTarget?.idx === idx;

    /* weight-adjust callback for vertical drag on the weight badge */
    const onWeightDrag = section === 'sum' ? (v: number) => {
      const clamped = Math.max(0, parseFloat(v.toFixed(2)));
      if (layerId) { ensureLayerEnabled(layerId); setLayerWeight(layerId, clamped); }
    } : undefined;

    const onMDrag = showParams && layerId ? (v: number) => {
      ensureLayerEnabled(layerId);
      patchTfParam(layerId, 'plateauEnd', v);
    } : undefined;

    const onNDrag = showParams && layerId ? (v: number) => {
      ensureLayerEnabled(layerId);
      patchTfParam(layerId, 'decayEnd', v);
    } : undefined;

    const paramStep = (val: number) => Math.max(0.2, Math.abs(val) * 0.002);

    return (
      <span
        key={chipKey}
        className={`${cls}${isDragTarget ? ' fb-drop-before' : ''}`}
        title={title}
        ref={(el) => {
          if (el) { chipRefs.current.set(chipKey, el); sectionChipRefs.current.set(`${section}-${idx}`, el); }
        }}
        onPointerDown={(e) => {
          // Only primary button
          if (e.button !== 0) return;
          // Determine if user pressed on a weight / param element
          const target = e.target as HTMLElement;
          const isWeight = target.classList.contains('fb-chip-weight');
          const isM = target.classList.contains('fb-chip-param-m');
          const isN = target.classList.contains('fb-chip-param-n');
          startChipDrag(e, section, idx,
            isWeight ? term.weight : isM ? term.M : isN ? term.N : undefined,
            isWeight ? 0.01 : isM ? paramStep(term.M) : isN ? paramStep(term.N) : undefined,
            isWeight ? onWeightDrag : isM ? onMDrag : isN ? onNDrag : undefined,
          );
        }}
        onMouseEnter={() => layerId && handleChipHover(chipKey, layerId)}
        onMouseLeave={handleChipLeave}
        onClick={(e) => { e.stopPropagation(); layerId && handleChipClick(chipKey, layerId); }}
        onContextMenu={(e) => layerId && handleChipContextMenu(e, chipKey, layerId, section)}
      >
        {section === 'sum' && (
          <span className="fb-chip-weight" title={`weight(${fmtN(term.weight)})`}>{fmtN(term.weight)}</span>
        )}
        <span className="fb-chip-icon">{icon}</span>
        {showParams && (
          <>
            <span className="fb-chip-param fb-chip-param-m">{fmtN(term.M)}</span>
            <span className="fb-chip-comma">,</span>
            <span className="fb-chip-param fb-chip-param-n">{fmtN(term.N)}</span>
          </>
        )}
      </span>
    );
  }, [activeChipKey, dragReorder, dropTarget, ensureLayerEnabled, handleChipClick, handleChipContextMenu, handleChipHover, handleChipLeave, layers, patchTfParam, setLayerWeight, showParams, soloLayer, startChipDrag, varToLayerId]);

  /* â”€â”€ Render a guard chip (comparison) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */
  const renderGuardChip = useCallback((guard: { varName: string; op: string; value: number }, chipKey: string, idx: number) => {
    const layerId = varToLayerId.get(guard.varName) ?? null;
    const layer = layerId ? layers.find((l) => l.id === layerId) : null;
    const isActive = activeChipKey === chipKey;
    const isDragTarget = dropTarget?.section === 'guard' && dropTarget?.idx === idx;
    const cls = `fb-chip fb-cmp-chip${isActive ? ' active' : ''}${isDragTarget ? ' fb-drop-before' : ''}`;

    /* Threshold-adjust callback: patches the guard's BinopNode.right.value,
       rebuilds formula from sections. */
    const onThresholdDrag = formulaSections ? (v: number) => {
      const clamped = Math.max(0, parseFloat(v.toFixed(1)));
      const nextGuards = formulaSections.guards.map((g, gi) => {
        if (gi !== idx) return g;
        return { ...g, right: { kind: 'number' as const, value: clamped } };
      });
      const nextFormula = buildFormulaFromSections({ ...formulaSections, guards: nextGuards });
      setCustomFormula(nextFormula);
      setFormulaDraft(nextFormula);
    } : undefined;
    const thresholdStep = Math.max(0.2, Math.abs(guard.value) * 0.002);

    return (
      <span
        className={cls}
        key={chipKey}
        title={`${guard.varName} ${guard.op} ${fmtN(guard.value)}`}
        ref={(el) => {
          if (el) { chipRefs.current.set(chipKey, el); sectionChipRefs.current.set(`guard-${idx}`, el); }
        }}
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          const target = e.target as HTMLElement;
          const isVal = target.classList.contains('fb-cmp-val');
          startChipDrag(e, 'guard', idx,
            isVal ? guard.value : undefined,
            isVal ? thresholdStep : undefined,
            isVal ? onThresholdDrag : undefined,
          );
        }}
        onMouseEnter={() => layerId && handleChipHover(chipKey, layerId)}
        onMouseLeave={handleChipLeave}
        onClick={(e) => { e.stopPropagation(); layerId && handleChipClick(chipKey, layerId); }}
        onContextMenu={(e) => layerId && handleChipContextMenu(e, chipKey, layerId, 'guard')}
      >
        <span className="fb-chip-icon">{layer?.icon ?? guard.varName}</span>
        <span className="fb-cmp-op">{guard.op}</span>
        <span className="fb-cmp-val">{fmtN(guard.value)}</span>
      </span>
    );
  }, [activeChipKey, buildFormulaFromSections, dropTarget, formulaSections, handleChipClick, handleChipContextMenu, handleChipHover, handleChipLeave, layers, setCustomFormula, startChipDrag, varToLayerId]);

  /* -- Sectioned formula renderer ------------------------------------------------ */
  const renderSectionedFormula = useMemo(() => {
    if (!formulaSections) return null;
    const { guards, importantTerms, terms, totalWeight, extras, wrapper } = formulaSections;

    // Extract guard info for rendering
    const guardInfos = guards.map(g => {
      const left = g.left;
      const right = g.right;
      if (left.kind === 'identifier' && right.kind === 'number') {
        return { varName: left.name, op: g.op, value: right.value };
      }
      return null;
    }).filter(Boolean) as { varName: string; op: string; value: number }[];

    const hasGuards = guardInfos.length > 0;
    const hasExtras = extras.length > 0;
    const hasImportant = importantTerms.length > 0;
    const hasSum = terms.length > 0;
    const hasInner = hasExtras || hasImportant || hasSum;

    /* Inner content: everything the wrapper wraps (extras x important x sum/weights) */
    const innerContent = hasInner ? (
      <>
        {/* Extras section */}
        {hasExtras && (
          <span className="fb-section fb-section-extras">
            {extras.map((ex, i) => (
              <span key={`extra-${i}`} className="fb-section-item fb-extra-factor">
                {i > 0 && <span className="fb-op fb-section-op">×</span>}
                {renderVisualNode(ex, `extra-${i}`)}
              </span>
            ))}
          </span>
        )}

        {/* Section divider: extras x important/sum */}
        {hasExtras && (hasImportant || hasSum) && (
          <span className="fb-section-divider">×</span>
        )}

        {/* Important section */}
        {hasImportant && (
          <span className={`fb-section fb-section-important${dropTarget?.section === 'important' ? ' fb-section-drop-target' : ''}`}
            ref={(el) => { if (el) sectionElRefs.current.set('important', el); }}>
            {importantTerms.map((term, i) => (
              <span key={`imp-${i}`} className="fb-section-item">
                {i > 0 && <span className="fb-op fb-section-op">×</span>}
                {renderSimpleTerm(term, `imp-${i}`, 'important', i)}
              </span>
            ))}
          </span>
        )}

        {/* Section divider: important x sum */}
        {hasImportant && hasSum && (
          <span className="fb-section-divider">×</span>
        )}

        {/* Sum section */}
        {hasSum && (
          <span className={`fb-paren-group fb-section fb-section-sum${dropTarget?.section === 'sum' ? ' fb-section-drop-target' : ''}`}
            ref={(el) => { if (el) sectionElRefs.current.set('sum', el); }}>
            <span className="fb-paren">(</span>
            {terms.map((term, i) => (
              <span key={`sum-${i}`} className="fb-section-item">
                {i > 0 && <span className="fb-op">+</span>}
                {renderSimpleTerm(term, `sum-${i}`, 'sum', i)}
              </span>
            ))}
            <span className="fb-paren">)</span>
            {totalWeight !== 1 && (
              <>
                <span className="fb-op">/</span>
                <span className="fb-ast-token" title={`weights = ${fmtN(totalWeight)}`}>{fmtN(totalWeight)}</span>
              </>
            )}
          </span>
        )}
      </>
    ) : null;

    /** Math-mode mapping for common wrapper functions. */
    const MATH_WRAPPERS: Record<string, { render: 'radical' | 'abs' | 'fn'; label?: string }> = {
      SQRT:  { render: 'radical' },
      ABS:   { render: 'abs' },
      LOG:   { render: 'fn', label: 'log' },
      LOG2:  { render: 'fn', label: 'log\u2082' },
      LOG10: { render: 'fn', label: 'log\u2081\u2080' },
      EXP:   { render: 'fn', label: 'e\u02e3' },
      SIGN:  { render: 'fn', label: 'sgn' },
      FLOOR: { render: 'fn', label: '\u230a\u230b' },
      CEIL:  { render: 'fn', label: '\u2308\u2309' },
      ROUND: { render: 'fn', label: '\u2248' },
      COS:   { render: 'fn', label: 'cos' },
      TAN:   { render: 'fn', label: 'tan' },
      ACOS:  { render: 'fn', label: 'acos' },
      ASIN:  { render: 'fn', label: 'asin' },
      ATAN:  { render: 'fn', label: 'atan' },
    };

    return (
      <span className="fb-ast-formula fb-sectioned">
        {/* Guard section */}
        {hasGuards && (
          <span className={`fb-paren-group fb-section fb-section-guard${dropTarget?.section === 'guard' ? ' fb-section-drop-target' : ''}`}
            ref={(el) => { if (el) sectionElRefs.current.set('guard', el); }}>
            {guardInfos.map((g, i) => (
              <span key={`guard-${i}`} className="fb-section-item">
                {i > 0 && <span className="fb-op fb-section-op">×</span>}
                {renderGuardChip(g, `guard-${i}`, i)}
              </span>
            ))}
          </span>
        )}

        {/* Section divider: guards x wrapper/inner */}
        {hasGuards && hasInner && (
          <span className="fb-section-divider">×</span>
        )}

        {/* Wrapper (SQRT, ABS, LOG, \u2026) around inner content */}
        {wrapper && hasInner ? (
          isMathMode && MATH_WRAPPERS[wrapper.fn] ? (
            /* Math rendering: \u221a with overline, |\u2026|, fn(\u2026) */
            MATH_WRAPPERS[wrapper.fn].render === 'radical' ? (
              <span className="fb-paren-group fb-section fb-section-wrapper fb-radical" title={`${wrapper.fn}(\u2026)`}>
                <span className="fb-radical-sign">√</span>
                <span className="fb-radical-content">{innerContent}</span>
              </span>
            ) : MATH_WRAPPERS[wrapper.fn].render === 'abs' ? (
              <span className="fb-paren-group fb-section fb-section-wrapper fb-abs-wrap" title={`${wrapper.fn}(\u2026)`}>
                <span className="fb-abs-bar">|</span>
                {innerContent}
                <span className="fb-abs-bar">|</span>
              </span>
            ) : (
              <span className="fb-paren-group fb-section fb-section-wrapper fb-math-fn" title={`${wrapper.fn}(\u2026)`}>
                <span className="fb-math-fn-label">{MATH_WRAPPERS[wrapper.fn].label}</span>
                <span className="fb-paren">(</span>
                {innerContent}
                <span className="fb-paren">)</span>
              </span>
            )
          ) : (
            /* Standard rendering: FN( \u2026 ) */
            <span className="fb-paren-group fb-section fb-section-wrapper">
              <span className="fb-wrapper-fn">{wrapper.fn}</span>
              <span className="fb-paren">(</span>
              {innerContent}
              <span className="fb-paren">)</span>
            </span>
          )
        ) : (
          innerContent
        )}
      </span>
    );
  }, [dragReorder, dropTarget, formulaSections, isMathMode, renderGuardChip, renderSimpleTerm, renderVisualNode]);

  /* â”€â”€ Close popover on outside click (hover or pinned) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */
  useEffect(() => {
    if (!activeChip) return;
    const handler = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (target.closest('.fb-popover') || target.closest('.fb-chip') || target.closest('.fb-add-wrap')) return;
      setPinnedChip(null);
      setHoveredChip(null);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [activeChip]);

  /* â”€â”€ Close view dropdown on outside click â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */
  useEffect(() => {
    if (!viewOpen) return;
    const handler = (e: MouseEvent) => {
      if (viewWrapRef.current && !viewWrapRef.current.contains(e.target as Node)) setViewOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [viewOpen]);

  // â”€â”€ Auto-sync formula draft with visual state in Raw mode â”€â”€â”€
  // When the user hasn't manually edited the formula (it still matches the
  // previous auto-generated formula), keep the textarea draft in sync with
  // visual changes. Do NOT write into store here, otherwise Apply can be
  // overwritten by this effect.
  const prevVisualRef = useRef(visualRawFormula);
  useEffect(() => {
    if (formulaMode === 'raw') {
      const prev = prevVisualRef.current;
      // If the stored formula matches the previous auto-generated one,
      // it wasn't manually edited â€” auto-sync textarea only.
      const stored = normalizeUserFormulaInput(customFormula);
      if (stored === prev || !stored) {
        setFormulaDraft(visualRawFormula);
      }
    }
    prevVisualRef.current = visualRawFormula;
  }, [visualRawFormula, formulaMode, customFormula]);

  // Sync draft from store or visual state
  useEffect(() => {
    if (formulaMode === 'raw') {
      // If the store has a non-empty formula, use it; otherwise seed from visual
      const stored = normalizeUserFormulaInput(customFormula);
      setFormulaDraft(stored || visualRawFormula);
    }
  }, [customFormula, formulaMode, visualRawFormula]);

  useEffect(() => {
    if (!formulaOpen) return;
    const handler = (e: MouseEvent) => {
      if (formulaWrapRef.current && !formulaWrapRef.current.contains(e.target as Node)) {
        setFormulaOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [formulaOpen]);

  return (
    <>
      {/* â”€â”€ Editing popover â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */}
      {activeLayer && (
        <EditPopover
          layer={activeLayer}
          anchorRect={popoverRect}
          weightValue={activeTermWeight ?? activeLayer.weight}
          pinned={!!pinnedChip}
          duplicateCount={activeDuplicateCount}
          canChangeTier={!normalizedCustom || (!!formulaSections && formulaSections.extras.length === 0)}
          onTierChange={activeChipKey ? (tier) => handleTierChange(activeLayer.id, activeChipKey, tier) : undefined}
          onPin={handlePopoverPin}
          onClose={handlePopoverClose}
          onRemove={handlePopoverRemove}
          onWeightChange={handlePopoverWeightChange}
          onMouseEnter={handlePopoverEnter}
          onMouseLeave={handlePopoverLeave}
        />
      )}

      {/* â”€â”€ Context menu (right-click on chip) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */}
      {contextMenu && (
        <div
          className="fb-context-menu"
          style={{ position: 'fixed', top: contextMenu.y, left: contextMenu.x, zIndex: 2500 }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          {contextMenu.section !== 'guard' && (
            <button className="fb-context-item" onClick={() => handleContextAction('mandatory')}>
              ðŸ›¡ Make mandatory
            </button>
          )}
          {contextMenu.section !== 'important' && (
            <button className="fb-context-item" onClick={() => handleContextAction('important')}>
              â­ Make important
            </button>
          )}
          {contextMenu.section !== 'sum' && (
            <button className="fb-context-item" onClick={() => handleContextAction('sum')}>
              Î£ Move to sum
            </button>
          )}
          <button className="fb-context-item fb-context-remove" onClick={() => handleContextAction('remove')}>
            Ã— Remove
          </button>
        </div>
      )}

      {/* â”€â”€ Formula bar â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */}
      <div className={`formula-bar ${collapsed ? 'collapsed' : ''}`}>
        <button className="formula-bar-toggle"
          onClick={handleToggleCollapsed}>
          {collapsed
            ? (t('fb.show' as keyof Translations) || 'Formula')
            : (t('fb.hide' as keyof Translations) || 'Hide')}
        </button>

        <div className="formula-bar-inner">
          <div className="fb-formula-wrap" ref={formulaWrapRef}>
            <button
              className="fb-formula-btn"
              onClick={() => setFormulaOpen((v) => !v)}
              title="Edit score formula"
            >
              Æ’x
            </button>
            {formulaOpen && (
              <div className="fb-formula-editor" onMouseDown={(e) => e.stopPropagation()}>
                <div className="fb-formula-editor-title">Score Formula</div>
                <div className="fb-formula-mode-switch">
                  <button
                    className={`fb-formula-mode-btn ${formulaMode === 'visual-short' ? 'active' : ''}`}
                    onClick={() => setFormulaMode('visual-short')}
                  >
                    Short
                  </button>
                  <button
                    className={`fb-formula-mode-btn ${formulaMode === 'visual' ? 'active' : ''}`}
                    onClick={() => setFormulaMode('visual')}
                  >
                    Visual
                  </button>
                  <button
                    className={`fb-formula-mode-btn ${formulaMode === 'math-short' ? 'active' : ''}`}
                    onClick={() => setFormulaMode('math-short')}
                    title="Math notation (compact)"
                  >
                    Math âˆ‘
                  </button>
                  <button
                    className={`fb-formula-mode-btn ${formulaMode === 'math' ? 'active' : ''}`}
                    onClick={() => setFormulaMode('math')}
                    title="Math notation (full params)"
                  >
                    Math Æ’
                  </button>
                  <button
                    className={`fb-formula-mode-btn ${formulaMode === 'raw' ? 'active' : ''}`}
                    onClick={() => {
                      const raw = normalizedCustom || visualRawFormula;
                      setFormulaDraft(raw);
                      setCustomFormula(raw);
                      setFormulaMode('raw');
                    }}
                  >
                    Raw
                  </button>
                </div>
                {formulaMode === 'raw' ? (
                  <>
                    <textarea
                      className="fb-formula-textarea"
                      value={formulaDraft}
                      onChange={(e) => setFormulaDraft(normalizeUserFormulaInput(e.target.value))}
                    />
                    {!formulaValidation.ok && (
                      <div className="fb-formula-error">âš  {formulaValidation.error || 'Invalid formula'}</div>
                    )}
                    <div className="fb-formula-actions">
                      <button
                        className="fb-formula-action"
                        onClick={() => {
                          if (!formulaValidation.ok) return;
                          setCustomFormula(normalizeUserFormulaInput(formulaDraft));
                        }}
                        disabled={!formulaValidation.ok}
                      >
                        Apply
                      </button>
                      <button className="fb-formula-action" onClick={() => setFormulaDraft(visualRawFormula)}>
                        Revert
                      </button>
                    </div>
                    <div className="fb-formula-help">Fns: SIN INVSIN RANGE INVRANGE(var, M, N [, high, low]) | Math: SQRT ABS POW(b,e) MIN MAX LOG EXP SIGN CLAMP(v,lo,hi) IF(cond,t,f) FLOOR CEIL ROUND | Ops: + - * / &lt; &gt; and ()</div>
                  </>
                ) : (
                  <div className="fb-formula-help">Visual mode uses chips, weights and popovers.</div>
                )}
              </div>
            )}
          </div>

          <span className="fb-label">Score =</span>

          {formulaMode !== 'raw' ? (
            renderSectionedFormula ? (
              renderSectionedFormula
            ) : visualAst ? (
              <span className="fb-ast-formula">{renderVisualNode(visualAst, 'root')}</span>
            ) : (
              <span className="fb-raw-preview"><span>{visualFormulaSource}</span></span>
            )
          ) : null}

          {formulaMode !== 'raw' ? (
            <AddLayerButton
              enabledLayers={enabledLayers}
              allLayers={layers}
              onAdd={handleAddLayer}
              allowDuplicateAdds={allowDuplicateAdds}
              varTfCounts={varTfCounts}
            />
          ) : (
            <span className="fb-raw-preview">
              <span>{formulaDraft || visualRawFormula}</span>
            </span>
          )}

          {/* Spacer pushes right-side controls */}
          <span className="fb-spacer" />

          {/* Solo indicator */}
          {soloLayer && (
            <span className="fb-solo-badge">
              â—Ž {layers.find((l) => l.id === soloLayer)?.icon}
            </span>
          )}

          {/* View settings dropdown */}
          <div className="fb-view-wrap" ref={viewWrapRef}>
            <button className="fb-view-btn"
              onClick={() => setViewOpen(!viewOpen)}
              title="Map settings">
              âš™
            </button>
            {viewOpen && <ViewMenuDropdown anchorRef={viewWrapRef} />}
          </div>

          {/* Lang toggle */}
          <button className="fb-lang-btn" onClick={toggleLang} title="Toggle language">
            {lang === 'ca' ? 'EN' : 'CA'}
          </button>
        </div>
      </div>
    </>
  );
}