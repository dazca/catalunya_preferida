/**
 * @file FormulaBar – bottom-docked scoring formula bar.
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
  VoteMetric,
} from '../types/transferFunction';
import { validateCustomFormula, visualToRawFormula, LAYER_VAR, layerTf } from '../utils/formulaEngine';
import { normalizeUserFormulaInput } from '../utils/formulaEngine';
import CurveEditor from './CurveEditor';
import WindRoseEditor from './WindRoseEditor';
import './FormulaBar.css';

type RequiredIndicator = {
  id: LayerId;
  icon: string;
  label: string;
  thresholdText: string;
  varName: string;
  decayEnd: number;
};

/** Mapping from vote sub-layer IDs to their VoteMetric key. */
const VOTE_ID_TO_METRIC: Record<string, VoteMetric> = {
  votesLeft: 'leftPct',
  votesRight: 'rightPct',
  votesIndep: 'independencePct',
  votesUnionist: 'unionistPct',
  votesTurnout: 'turnoutPct',
};

/* ─── helpers: layer → primary TF accessor ─────────────────────────── */

/** Return the "primary" transfer-function for a layer (for scroll shortcuts). */
function primaryTf(id: LayerId, configs: LayerConfigs): TransferFunction | null {
  switch (id) {
    case 'terrainSlope': return configs.terrain.slope.tf;
    case 'terrainElevation': return configs.terrain.elevation.tf;
    case 'terrainAspect': return null; // aspect uses wind-rose
    case 'votesLeft':
    case 'votesRight':
    case 'votesIndep':
    case 'votesUnionist':
    case 'votesTurnout': {
      const metric = VOTE_ID_TO_METRIC[id];
      return configs.votes.terms.find((t) => t.metric === metric)?.value.tf ?? null;
    }
    case 'transit': return configs.transit.tf;
    case 'forest': return configs.forest.tf;
    case 'airQualityPm10': return configs.airQuality.pm10.tf;
    case 'airQualityNo2': return configs.airQuality.no2.tf;
    case 'crime': return configs.crime.tf;
    case 'healthcare': return configs.healthcare.tf;
    case 'schools': return configs.schools.tf;
    case 'internet': return configs.internet.tf;
    case 'climateTemp': return configs.climate.temperature.tf;
    case 'climateRainfall': return configs.climate.rainfall.tf;
    case 'rentalPrices': return configs.rentalPrices.tf;
    case 'employment': return configs.employment.tf;
    case 'amenities': return configs.amenities.tf;
    default: return null;
  }
}

/** Apply a patch to the primary TF of a layer. */
function patchPrimaryTf(
  id: LayerId,
  configs: LayerConfigs,
  patch: Partial<TransferFunction>,
  updateConfig: <K extends keyof LayerConfigs>(layer: K, values: LayerConfigs[K]) => void,
) {
  const apply = (tf: TransferFunction): TransferFunction => ({ ...tf, ...patch });
  switch (id) {
    case 'terrainSlope':
      return updateConfig('terrain', {
        ...configs.terrain,
        slope: { ...configs.terrain.slope, tf: apply(configs.terrain.slope.tf) },
      });
    case 'terrainElevation':
      return updateConfig('terrain', {
        ...configs.terrain,
        elevation: { ...configs.terrain.elevation, tf: apply(configs.terrain.elevation.tf) },
      });
    case 'terrainAspect':
      return; // no single TF
    case 'votesLeft':
    case 'votesRight':
    case 'votesIndep':
    case 'votesUnionist':
    case 'votesTurnout': {
      const metric = VOTE_ID_TO_METRIC[id];
      const terms = configs.votes.terms.map((t) =>
        t.metric === metric ? { ...t, value: { ...t.value, tf: apply(t.value.tf) } } : t,
      );
      return updateConfig('votes', { terms });
    }
    case 'transit':
      return updateConfig('transit', { ...configs.transit, tf: apply(configs.transit.tf) });
    case 'forest':
      return updateConfig('forest', { ...configs.forest, tf: apply(configs.forest.tf) });
    case 'airQualityPm10':
      return updateConfig('airQuality', {
        ...configs.airQuality,
        pm10: { ...configs.airQuality.pm10, tf: apply(configs.airQuality.pm10.tf) },
      });
    case 'airQualityNo2':
      return updateConfig('airQuality', {
        ...configs.airQuality,
        no2: { ...configs.airQuality.no2, tf: apply(configs.airQuality.no2.tf) },
      });
    case 'crime':
      return updateConfig('crime', { ...configs.crime, tf: apply(configs.crime.tf) });
    case 'healthcare':
      return updateConfig('healthcare', { ...configs.healthcare, tf: apply(configs.healthcare.tf) });
    case 'schools':
      return updateConfig('schools', { ...configs.schools, tf: apply(configs.schools.tf) });
    case 'internet':
      return updateConfig('internet', { ...configs.internet, tf: apply(configs.internet.tf) });
    case 'climateTemp':
      return updateConfig('climate', {
        ...configs.climate,
        temperature: { ...configs.climate.temperature, tf: apply(configs.climate.temperature.tf) },
      });
    case 'climateRainfall':
      return updateConfig('climate', {
        ...configs.climate,
        rainfall: { ...configs.climate.rainfall, tf: apply(configs.climate.rainfall.tf) },
      });
    case 'rentalPrices':
      return updateConfig('rentalPrices', { ...configs.rentalPrices, tf: apply(configs.rentalPrices.tf) });
    case 'employment':
      return updateConfig('employment', { ...configs.employment, tf: apply(configs.employment.tf) });
    case 'amenities':
      return updateConfig('amenities', { ...configs.amenities, tf: apply(configs.amenities.tf) });
  }
}

/* ─── Vote term labels ──────────────────────────────────────────────── */
const METRIC_LABELS: Record<VoteMetric, string> = {
  leftPct: 'Left %',
  rightPct: 'Right %',
  independencePct: 'Indep %',
  unionistPct: 'Unionist %',
  turnoutPct: 'Turnout %',
};

/* ═══════════════════════════════════════════════════════════════════════
   TfControls – single transfer-function editor inside popover.
   ═══════════════════════════════════════════════════════════════════════ */

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
  const t = useT();
  const updateTf = (newTf: TransferFunction) => onChange({ ...ltc, tf: newTf });

  return (
    <div className="fb-tf-controls">
      <div className="fb-tf-header">
        <span className="fb-tf-label">{label}</span>
        <label className="fb-tf-enabled">
          <input
            type="checkbox"
            checked={ltc.enabled}
            onChange={(e) => onChange({ ...ltc, enabled: e.target.checked })}
          />
          {t('tf.on')}
        </label>
      </div>
      <div className="fb-tf-row">
        <label className="fb-tf-inline">
          M
          <input type="number" min="0.1" max="3" step="0.1"
            value={ltc.tf.multiplier}
            onChange={(e) => updateTf({ ...ltc.tf, multiplier: +e.target.value })}
          />
        </label>
        <label className="fb-tf-inline fb-tf-wide">
          sin(
          <input type="number" step="0.1" value={ltc.tf.plateauEnd}
            onChange={(e) => updateTf({ ...ltc.tf, plateauEnd: +e.target.value })}
          />
          →
          <input type="number" step="0.1" value={ltc.tf.decayEnd}
            onChange={(e) => updateTf({ ...ltc.tf, decayEnd: +e.target.value })}
          />
          )
        </label>
        <label className="fb-tf-inline">
          floor
          <input type="number" min="0" max="1" step="0.01" value={ltc.tf.floor}
            onChange={(e) => updateTf({ ...ltc.tf, floor: +e.target.value })}
          />
        </label>
        <label className="fb-tf-flag">
          <input type="checkbox" checked={ltc.tf.mandatory}
            onChange={(e) => updateTf({ ...ltc.tf, mandatory: e.target.checked })} />
          {t('tf.req')}
        </label>
        <label className="fb-tf-flag">
          <select
            value={ltc.tf.shape ?? 'sin'}
            onChange={(e) => updateTf({ ...ltc.tf, shape: e.target.value as TransferFunction['shape'] })}
            className="fb-tf-shape-select"
          >
            <option value="sin">SIN</option>
            <option value="invsin">INVSIN</option>
            <option value="range">RANGE</option>
            <option value="invrange">INVRANGE</option>
          </select>
        </label>
      </div>
      <div className="fb-tf-curve">
        <CurveEditor tf={ltc.tf} rangeMax={rangeMax} unit={unit} onChange={updateTf} />
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════════
   LayerEditorContent – renders the full filter editor for any layer
   inside the popover.
   ═══════════════════════════════════════════════════════════════════════ */

function LayerEditorContent({ layerId }: { layerId: LayerId }) {
  const { configs, updateConfig } = useAppStore();
  const t = useT();

  switch (layerId) {
    case 'terrainSlope':
      return <TfControls label={t('fc.terrain.slope')} ltc={configs.terrain.slope}
        onChange={(ltc) => updateConfig('terrain', { ...configs.terrain, slope: ltc })}
        rangeMax={60} unit="deg" />;
    case 'terrainElevation':
      return <TfControls label={t('fc.terrain.elevation')} ltc={configs.terrain.elevation}
        onChange={(ltc) => updateConfig('terrain', { ...configs.terrain, elevation: ltc })}
        rangeMax={3000} unit="m" />;
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
        rangeMax={100} unit="%" />;
    }
    case 'transit':
      return <TfControls label={t('fc.transit.dist')} ltc={configs.transit}
        onChange={(ltc) => updateConfig('transit', ltc)} rangeMax={50} unit="km" />;
    case 'forest':
      return <TfControls label={t('fc.forest.cover')} ltc={configs.forest}
        onChange={(ltc) => updateConfig('forest', ltc)} rangeMax={100} unit="%" />;
    case 'airQualityPm10':
      return <TfControls label={t('fc.airQuality.pm10')} ltc={configs.airQuality.pm10}
        onChange={(ltc) => updateConfig('airQuality', { ...configs.airQuality, pm10: ltc })}
        rangeMax={100} unit="ug/m3" />;
    case 'airQualityNo2':
      return <TfControls label={t('fc.airQuality.no2')} ltc={configs.airQuality.no2}
        onChange={(ltc) => updateConfig('airQuality', { ...configs.airQuality, no2: ltc })}
        rangeMax={100} unit="ug/m3" />;
    case 'crime':
      return <TfControls label={t('fc.crime.rate')} ltc={configs.crime}
        onChange={(ltc) => updateConfig('crime', ltc)} rangeMax={100} unit="per 1k" />;
    case 'healthcare':
      return <TfControls label={t('fc.healthcare.dist')} ltc={configs.healthcare}
        onChange={(ltc) => updateConfig('healthcare', ltc)} rangeMax={50} unit="km" />;
    case 'schools':
      return <TfControls label={t('fc.schools.dist')} ltc={configs.schools}
        onChange={(ltc) => updateConfig('schools', ltc)} rangeMax={30} unit="km" />;
    case 'internet':
      return <TfControls label={t('fc.internet.fiber')} ltc={configs.internet}
        onChange={(ltc) => updateConfig('internet', ltc)} rangeMax={100} unit="%" />;
    case 'climateTemp':
      return <TfControls label={t('fc.climate.temp')} ltc={configs.climate.temperature}
        onChange={(ltc) => updateConfig('climate', { ...configs.climate, temperature: ltc })}
        rangeMax={35} unit="C" />;
    case 'climateRainfall':
      return <TfControls label={t('fc.climate.rain')} ltc={configs.climate.rainfall}
        onChange={(ltc) => updateConfig('climate', { ...configs.climate, rainfall: ltc })}
        rangeMax={1500} unit="mm" />;
    case 'rentalPrices':
      return <TfControls label={t('fc.rental.monthly')} ltc={configs.rentalPrices}
        onChange={(ltc) => updateConfig('rentalPrices', ltc)} rangeMax={3000} unit="EUR" />;
    case 'employment':
      return <TfControls label={t('fc.employment.unemployed')} ltc={configs.employment}
        onChange={(ltc) => updateConfig('employment', ltc)} rangeMax={40} unit="%" />;
    case 'amenities':
      return <TfControls label={t('fc.amenities.dist')} ltc={configs.amenities}
        onChange={(ltc) => updateConfig('amenities', ltc)} rangeMax={50} unit="km" />;
    default:
      return null;
  }
}

/* ═══════════════════════════════════════════════════════════════════════
   EditPopover – floating editor panel above a chip on hover / pin.
   ═══════════════════════════════════════════════════════════════════════ */

function EditPopover({
  layer,
  anchorRect,
  pinned,
  onPin,
  onClose: _onClose,
  onRemove,
  onMouseEnter,
  onMouseLeave,
}: {
  layer: LayerMeta;
  anchorRect: DOMRect | null;
  pinned: boolean;
  onPin: () => void;
  onClose: () => void;
  onRemove: () => void;
  onMouseEnter?: () => void;
  onMouseLeave?: () => void;
}) {
  const { soloLayer, setSoloLayer, setLayerWeight } = useAppStore();
  const t = useT();
  const isSolo = soloLayer === layer.id;

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
          <button className={`fb-popover-solo ${isSolo ? 'active' : ''}`}
            onClick={(e) => { e.stopPropagation(); setSoloLayer(isSolo ? null : layer.id); }}
            title={isSolo ? t('solo.button.on' as keyof Translations) : t('solo.button.off' as keyof Translations)}>
            ◎
          </button>
          <button className="fb-popover-remove" onClick={(e) => { e.stopPropagation(); onRemove(); }}
            title="Remove layer">
            ×
          </button>
        </div>
      </div>

      {/* Weight slider */}
      <div className="fb-popover-weight">
        <span>{t('fp.weight')}</span>
        <input type="range" min="0" max="2" step="0.1" value={layer.weight}
          onChange={(e) => setLayerWeight(layer.id, parseFloat(e.target.value))} />
        <span className="fb-popover-wval">{layer.weight.toFixed(1)}</span>
      </div>

      {/* Layer-specific controls */}
      <div className="fb-popover-body">
        <LayerEditorContent layerId={layer.id} />
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════════
   FormulaChip – single layer chip in the bar (icon + weight badge).
   ═══════════════════════════════════════════════════════════════════════ */

function FormulaChip({
  layer,
  isPopoverTarget,
  onHover,
  onLeave,
  onClick,
  chipRef,
}: {
  layer: LayerMeta;
  isPopoverTarget: boolean;
  onHover: (rect: DOMRect) => void;
  onLeave: () => void;
  onClick: (rect: DOMRect) => void;
  chipRef: (el: HTMLSpanElement | null) => void;
}) {
  const { configs, setLayerWeight, updateConfig, soloLayer } = useAppStore();
  const isSolo = soloLayer === layer.id;
  const ref = useRef<HTMLSpanElement | null>(null);
  const dragStart = useRef<{ y: number; w: number } | null>(null);

  const getRect = (): DOMRect =>
    ref.current?.getBoundingClientRect() ?? new DOMRect();

  /* ── weight scroll ───────────────────────────────────────────── */
  const handleWeightWheel = useCallback(
    (e: React.WheelEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const delta = e.deltaY < 0 ? 0.1 : -0.1;
      const newW = Math.round(Math.max(0, Math.min(3, layer.weight + delta)) * 10) / 10;
      setLayerWeight(layer.id, newW);
    },
    [layer.id, layer.weight, setLayerWeight],
  );

  /* ── weight drag ─────────────────────────────────────────────── */
  const handleWeightDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      dragStart.current = { y: e.clientY, w: layer.weight };
      const move = (ev: MouseEvent) => {
        if (!dragStart.current) return;
        const dy = dragStart.current.y - ev.clientY; // up = positive
        const newW = Math.round(Math.max(0, Math.min(3, dragStart.current.w + dy * 0.01)) * 10) / 10;
        setLayerWeight(layer.id, newW);
      };
      const up = () => {
        dragStart.current = null;
        document.removeEventListener('mousemove', move);
        document.removeEventListener('mouseup', up);
      };
      document.addEventListener('mousemove', move);
      document.addEventListener('mouseup', up);
    },
    [layer.id, layer.weight, setLayerWeight],
  );

  /* ── icon scroll: multiplier / ctrl+scroll → plateauEnd shift ── */
  const handleIconWheel = useCallback(
    (e: React.WheelEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const tf = primaryTf(layer.id, configs);
      if (!tf) return;
      if (e.ctrlKey) {
        // shift plateauEnd + decayEnd together
        const delta = e.deltaY < 0 ? 1 : -1;
        patchPrimaryTf(layer.id, configs, {
          plateauEnd: Math.max(0, tf.plateauEnd + delta),
          decayEnd: Math.max(tf.plateauEnd + delta + 1, tf.decayEnd + delta),
        }, updateConfig);
      } else {
        // multiplier
        const delta = e.deltaY < 0 ? 0.1 : -0.1;
        const newM = Math.round(Math.max(0.1, Math.min(3, tf.multiplier + delta)) * 10) / 10;
        patchPrimaryTf(layer.id, configs, { multiplier: newM }, updateConfig);
      }
    },
    [layer.id, configs, updateConfig],
  );

  return (
    <span
      ref={(el) => { ref.current = el; chipRef(el); }}
      className={`fb-chip ${isPopoverTarget ? 'active' : ''} ${isSolo ? 'solo' : ''}`}
      onMouseEnter={() => onHover(getRect())}
      onMouseLeave={onLeave}
      onClick={() => onClick(getRect())}
    >
      <span className="fb-chip-icon" onWheel={handleIconWheel} title={layer.label}>
        {layer.icon}
      </span>
      <span className="fb-chip-weight"
        onWheel={handleWeightWheel}
        onMouseDown={handleWeightDown}
        title={`Weight: ${layer.weight.toFixed(1)} — scroll or drag to adjust`}>
        {layer.weight.toFixed(1)}
      </span>
    </span>
  );
}

/* ═══════════════════════════════════════════════════════════════════════
   AddLayerButton – [+] dropdown with hierarchical submenu groups.
   ═══════════════════════════════════════════════════════════════════════ */

/** Groups that get a hover-submenu in the [+] dropdown. */
const ADD_LAYER_GROUPS: { groupLabel: string; groupIcon: string; ids: LayerId[] }[] = [
  { groupLabel: 'Terrain', groupIcon: '⛰', ids: ['terrainSlope', 'terrainElevation', 'terrainAspect'] },
  { groupLabel: 'Vote Sentiment', groupIcon: '🗳', ids: ['votesLeft', 'votesRight', 'votesIndep', 'votesUnionist', 'votesTurnout'] },
  { groupLabel: 'Air Quality', groupIcon: '🌬', ids: ['airQualityPm10', 'airQualityNo2'] },
  { groupLabel: 'Climate', groupIcon: '☀', ids: ['climateTemp', 'climateRainfall'] },
];
const FLAT_IDS: LayerId[] = ['transit', 'forest', 'soil', 'crime', 'healthcare', 'schools', 'internet', 'noise', 'rentalPrices', 'employment', 'amenities'];

function AddLayerButton({
  enabledLayers,
  allLayers,
  onAdd,
}: {
  enabledLayers: LayerMeta[];
  allLayers: LayerMeta[];
  onAdd: (id: LayerId) => void;
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
                  <span className="fb-add-group-arrow">▸</span>
                </div>
                {hoveredGroup === gi && (
                  <div className="fb-add-submenu">
                    {group.ids.map((id) => {
                      const l = layerMap.get(id);
                      if (!l) return null;
                      const isAdded = enabledSet.has(id);
                      return (
                        <button key={id} className={`fb-add-dropdown-item ${isAdded ? 'is-added' : ''}`}
                          onClick={() => {
                            if (isAdded) return;
                            onAdd(id);
                            setOpen(false);
                          }}
                          disabled={isAdded}
                          title={isAdded ? 'Already added' : ''}>
                          <span className="fb-dd-icon">{l.icon}</span>
                          {t(`layer.${id}.label` as keyof Translations) || l.label}
                          {isAdded && <span className="fb-add-check">✓</span>}
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
            return (
              <button key={id} className={`fb-add-dropdown-item ${isAdded ? 'is-added' : ''}`}
                onClick={() => {
                  if (isAdded) return;
                  onAdd(id);
                  setOpen(false);
                }}
                disabled={isAdded}
                title={isAdded ? 'Already added' : ''}>
                <span className="fb-dd-icon">{l.icon}</span>
                {t(`layer.${id}.label` as keyof Translations) || l.label}
                {isAdded && <span className="fb-add-check">✓</span>}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════════
   ViewMenuDropdown – map view settings, inlined in the formula bar.
   ═══════════════════════════════════════════════════════════════════════ */

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

/* ═══════════════════════════════════════════════════════════════════════
   FormulaBar – root component
   ═══════════════════════════════════════════════════════════════════════ */

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
  } = useAppStore();
  const t = useT();

  const [collapsed, setCollapsed] = useState(false);
  const [viewOpen, setViewOpen] = useState(false);
  const [formulaOpen, setFormulaOpen] = useState(false);
  const [formulaDraft, setFormulaDraft] = useState(customFormula);
  const viewWrapRef = useRef<HTMLDivElement>(null);
  const formulaWrapRef = useRef<HTMLDivElement>(null);

  // Popover state
  const [hoveredId, setHoveredId] = useState<LayerId | null>(null);
  const [pinnedId, setPinnedId] = useState<LayerId | null>(null);
  const [popoverRect, setPopoverRect] = useState<DOMRect | null>(null);
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const chipRefs = useRef<Map<LayerId, HTMLSpanElement>>(new Map());

  const activeId = pinnedId ?? hoveredId;
  const activeLayer = activeId ? layers.find((l) => l.id === activeId) : null;

  const enabledLayers = layers.filter((l) => l.enabled);

  const requiredIndicators = useMemo<RequiredIndicator[]>(() => {
    return enabledLayers
      .map((layer) => {
        const tf = layerTf(layer.id, configs);
        if (!tf?.mandatory) return null;
        const varName = LAYER_VAR[layer.id] ?? layer.id;
        return {
          id: layer.id,
          icon: layer.icon,
          label: t(`layer.${layer.id}.label` as keyof Translations) || layer.label,
          thresholdText: `${t(`layer.${layer.id}.label` as keyof Translations) || layer.label} < ${tf.decayEnd}`,
          varName,
          decayEnd: tf.decayEnd,
        };
      })
      .filter((v): v is RequiredIndicator => v !== null);
  }, [configs, enabledLayers, t]);

  /** Deterministic raw formula generated from the current visual state. */
  const visualRawFormula = useMemo(
    () => visualToRawFormula(enabledLayers, configs),
    [enabledLayers, configs],
  );

  /**
   * The formula shown in the raw textarea.  When in Visual mode the store's
   * customFormula is empty — but we seed the textarea from visualRawFormula
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
        setPinnedId(null);
        setHoveredId(null);
        setViewOpen(false);
        setFormulaOpen(false);
      }
      return next;
    });
  }, []);

  /* ── Popover hover keep-alive ────────────────────────────────── */
  const handlePopoverEnter = useCallback(() => {
    if (hoverTimer.current) clearTimeout(hoverTimer.current);
  }, []);

  const handlePopoverLeave = useCallback(() => {
    if (!pinnedId) {
      hoverTimer.current = setTimeout(() => setHoveredId(null), 300);
    }
  }, [pinnedId]);

  /* ── Chip hover / click handlers ─────────────────────────────── */
  const handleChipHover = useCallback((id: LayerId, rect: DOMRect) => {
    if (pinnedId) return; // don't switch when pinned
    if (hoverTimer.current) clearTimeout(hoverTimer.current);
    // Instant show — no delay
    setHoveredId(id);
    setPopoverRect(rect);
  }, [pinnedId]);

  const handleChipLeave = useCallback(() => {
    if (hoverTimer.current) clearTimeout(hoverTimer.current);
    if (!pinnedId) {
      hoverTimer.current = setTimeout(() => setHoveredId(null), 300);
    }
  }, [pinnedId]);

  const handleChipClick = useCallback((id: LayerId, rect: DOMRect) => {
    if (pinnedId === id) {
      setPinnedId(null); // unpin
    } else {
      setPinnedId(id);
      setPopoverRect(rect);
      setHoveredId(null);
    }
  }, [pinnedId]);

  const handlePopoverPin = useCallback(() => {
    if (activeId && !pinnedId) {
      setPinnedId(activeId);
      setHoveredId(null);
    }
  }, [activeId, pinnedId]);

  const handlePopoverClose = useCallback(() => {
    setPinnedId(null);
    setHoveredId(null);
  }, []);

  const handlePopoverRemove = useCallback(() => {
    if (activeId) {
      toggleLayer(activeId);
      setPinnedId(null);
      setHoveredId(null);
    }
  }, [activeId, toggleLayer]);

  /* ── [+] adds layer and pins its popover ─────────────────────── */
  const handleAddLayer = useCallback((id: LayerId) => {
    const layer = layers.find((l) => l.id === id);
    if (layer && !layer.enabled) toggleLayer(id);
    // Open editing popover for the newly added layer after render
    requestAnimationFrame(() => {
      const el = chipRefs.current.get(id);
      if (el) {
        setPinnedId(id);
        setPopoverRect(el.getBoundingClientRect());
      } else {
        setPinnedId(id);
      }
    });
  }, [layers, toggleLayer]);

  /* ── Close popover on outside click ──────────────────────────── */
  useEffect(() => {
    if (!pinnedId) return;
    const handler = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (target.closest('.fb-popover') || target.closest('.fb-chip') || target.closest('.fb-add-wrap')) return;
      setPinnedId(null);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [pinnedId]);

  /* ── Close view dropdown on outside click ────────────────────── */
  useEffect(() => {
    if (!viewOpen) return;
    const handler = (e: MouseEvent) => {
      if (viewWrapRef.current && !viewWrapRef.current.contains(e.target as Node)) setViewOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [viewOpen]);

  // ── Auto-sync formula draft with visual state in Raw mode ───
  // When the user hasn't manually edited the formula (it still matches the
  // previous auto-generated formula), keep the textarea draft in sync with
  // visual changes. Do NOT write into store here, otherwise Apply can be
  // overwritten by this effect.
  const prevVisualRef = useRef(visualRawFormula);
  useEffect(() => {
    if (formulaMode === 'raw') {
      const prev = prevVisualRef.current;
      // If the stored formula matches the previous auto-generated one,
      // it wasn't manually edited — auto-sync textarea only.
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
      {/* ── Editing popover ──────────────────────────────────────── */}
      {activeLayer && activeLayer.enabled && (
        <EditPopover
          layer={activeLayer}
          anchorRect={popoverRect}
          pinned={!!pinnedId}
          onPin={handlePopoverPin}
          onClose={handlePopoverClose}
          onRemove={handlePopoverRemove}
          onMouseEnter={handlePopoverEnter}
          onMouseLeave={handlePopoverLeave}
        />
      )}

      {/* ── Formula bar ──────────────────────────────────────────── */}
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
              ƒx
            </button>
            {formulaOpen && (
              <div className="fb-formula-editor" onMouseDown={(e) => e.stopPropagation()}>
                <div className="fb-formula-editor-title">Score Formula</div>
                <div className="fb-formula-mode-switch">
                  <button
                    className={`fb-formula-mode-btn ${formulaMode === 'visual' ? 'active' : ''}`}
                    onClick={() => {
                      // Always switch back to Visual — it reads layers+configs directly
                      setCustomFormula('');
                      setFormulaMode('visual');
                    }}
                  >
                    Visual
                  </button>
                  <button
                    className={`fb-formula-mode-btn ${formulaMode === 'raw' ? 'active' : ''}`}
                    onClick={() => {
                      // Seed the raw textarea from the current visual formula
                      const raw = visualRawFormula;
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
                      <div className="fb-formula-error">⚠ {formulaValidation.error || 'Invalid formula'}</div>
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
                    <div className="fb-formula-help">Fns: SIN INVSIN RANGE INVRANGE(var, M, N [, high, low]) | Ops: + - * / and ()</div>
                  </>
                ) : (
                  <div className="fb-formula-help">Visual mode uses chips, weights and popovers.</div>
                )}
              </div>
            )}
          </div>

          <span className="fb-label">Score =</span>

          {formulaMode === 'visual' && requiredIndicators.length > 0 && (
            <>
              {requiredIndicators.map((req) => (
                <span key={req.id} className="fb-required-badge" title={req.thresholdText}>
                  {req.icon}!
                </span>
              ))}
              <span className="fb-op">×</span>
            </>
          )}

          {formulaMode === 'visual' && enabledLayers.map((layer, idx) => (
            <span key={layer.id} style={{ display: 'contents' }}>
              {idx > 0 && <span className="fb-op">+</span>}
              <FormulaChip
                layer={layer}
                isPopoverTarget={activeId === layer.id}
                onHover={(rect) => handleChipHover(layer.id, rect)}
                onLeave={handleChipLeave}
                onClick={(rect) => handleChipClick(layer.id, rect)}
                chipRef={(el) => {
                  if (el) chipRefs.current.set(layer.id, el);
                  else chipRefs.current.delete(layer.id);
                }}
              />
            </span>
          ))}

          {formulaMode === 'visual' ? (
            <AddLayerButton enabledLayers={enabledLayers} allLayers={layers} onAdd={handleAddLayer} />
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
              ◎ {layers.find((l) => l.id === soloLayer)?.icon}
            </span>
          )}

          {/* View settings dropdown */}
          <div className="fb-view-wrap" ref={viewWrapRef}>
            <button className="fb-view-btn"
              onClick={() => setViewOpen(!viewOpen)}
              title="Map settings">
              ⚙
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
