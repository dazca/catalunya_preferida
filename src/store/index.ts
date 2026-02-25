/**
 * @file Zustand store for application state.
 *
 * Persists layers, configs, view settings and named presets to localStorage
 * so configuration survives page reloads.
 */
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { LayerId, LayerMeta } from '../types';
import type { LayerConfigs, VoteTerm } from '../types/transferFunction';
import { DEFAULT_LAYER_CONFIGS, defaultTf } from '../types/transferFunction';
import { DEFAULT_CUSTOM_FORMULA, normalizeUserFormulaInput } from '../utils/formulaEngine';
import { DEFAULT_INTEGRITY_RULES, runDataIntegrityChecks } from '../utils/dataIntegrity';
import type { DataIntegrityInput, IntegrityReport, IntegrityRules } from '../utils/dataIntegrity';
import type { Lang } from '../i18n';

/** Snapshot of undoable state. */
export interface HistoryEntry {
  layers: LayerMeta[];
  configs: LayerConfigs;
  soloLayer: LayerId | null;
}

const MAX_HISTORY = 80;

/** Snapshot saved as a named preset. */
export interface Preset {
  name: string;
  layers: LayerMeta[];
  configs: LayerConfigs;
}

/** Map overlay / view toggle state. */
export interface ViewSettings {
  /** Show municipality border lines. */
  showBorders: boolean;
  /** Enable 3D terrain mesh from DEM. */
  show3dTerrain: boolean;
  /** Show hillshade lighting layer. */
  showHillshade: boolean;
  /** Show hypsometric elevation tint. */
  showElevationTint: boolean;
  /** Show continuous score heatmap. */
  showHeatmap: boolean;
  /** Show per-municipality choropleth fill. */
  showChoropleth: boolean;
  /** Terrain exaggeration factor (1x–3x). */
  terrainExaggeration: number;
  /** Heatmap layer opacity (0–1). */
  heatmapOpacity: number;
  /** Paint mandatory-disqualified zones in black instead of transparent. */
  maskDisqualifiedAsBlack: boolean;
}

export const DEFAULT_VIEW: ViewSettings = {
  showBorders: false,
  show3dTerrain: true,
  showHillshade: true,
  showElevationTint: true,
  showHeatmap: true,
  showChoropleth: false,
  terrainExaggeration: 1.5,
  heatmapOpacity: 0.75,
  maskDisqualifiedAsBlack: true,
};

export interface DataIntegritySuggestion {
  id: string;
  label: string;
  probability: number;
}

export const INTEGRITY_SUGGESTIONS: DataIntegritySuggestion[] = [
  { id: 'completeness', label: 'Layer completeness checks', probability: 0.99 },
  { id: 'coverage', label: 'Municipality coverage checks', probability: 0.98 },
  { id: 'duplicates', label: 'Duplicate detection', probability: 0.95 },
  { id: 'ranges', label: 'Range plausibility checks', probability: 0.95 },
  { id: 'outliers', label: 'Distribution anomaly checks', probability: 0.9 },
  { id: 'crossfield', label: 'Cross-field consistency checks', probability: 0.88 },
  { id: 'freshness', label: 'Data freshness checks', probability: 0.82 },
  { id: 'left-parties', label: 'Left-party taxonomy editor', probability: 0.8 },
  { id: 'rule-tuning', label: 'Rule tuning controls', probability: 0.96 },
  { id: 'report-export', label: 'Report export/import', probability: 0.92 },
];

/** All available layers with their default metadata (each sub-metric is its own layer). */
export const DEFAULT_LAYERS: LayerMeta[] = [
  // Terrain sub-layers
  { id: 'terrainSlope', label: 'Terrain Slope', description: 'Slope angle', icon: '📐', enabled: true, weight: 1 },
  { id: 'terrainElevation', label: 'Elevation', description: 'Average altitude', icon: '🏔', enabled: true, weight: 1 },
  { id: 'terrainAspect', label: 'Slope Orientation', description: 'Slope direction', icon: '🧭', enabled: false, weight: 0.5 },
  // Vote sub-layers
  { id: 'votesLeft', label: 'Left-wing %', description: 'Left-wing vote share', icon: '✊', enabled: true, weight: 1 },
  { id: 'votesRight', label: 'Right-wing %', description: 'Right-wing vote share', icon: '🏛', enabled: false, weight: 0.5 },
  { id: 'votesIndep', label: 'Independence %', description: 'Pro-independence vote share', icon: '🎗', enabled: false, weight: 0.5 },
  { id: 'votesUnionist', label: 'Unionist %', description: 'Unionist vote share', icon: '🤝', enabled: false, weight: 0.5 },
  { id: 'votesTurnout', label: 'Turnout %', description: 'Voter turnout', icon: '🗳', enabled: false, weight: 0.5 },
  // Simple layers
  { id: 'transit', label: 'Public Transit', description: 'Rail, metro, bus proximity', icon: '🚆', enabled: true, weight: 1 },
  { id: 'forest', label: 'Forest Cover', description: 'Vegetation and green areas', icon: '🌲', enabled: true, weight: 1 },
  { id: 'soil', label: 'Soil & Aquifers', description: 'Geological and water data', icon: '💧', enabled: false, weight: 0.5 },
  // Air quality sub-layers
  { id: 'airQualityPm10', label: 'PM10 Particles', description: 'PM10 air quality', icon: '🫁', enabled: false, weight: 0.8 },
  { id: 'airQualityNo2', label: 'NO₂', description: 'Nitrogen dioxide levels', icon: '🏭', enabled: false, weight: 0.8 },
  { id: 'crime', label: 'Crime Rates', description: 'Offenses per 1000 inhabitants', icon: '🔒', enabled: false, weight: 0.7 },
  { id: 'healthcare', label: 'Healthcare', description: 'Hospitals and health centers', icon: '🏥', enabled: false, weight: 0.6 },
  { id: 'schools', label: 'Schools', description: 'Educational centers proximity', icon: '🎓', enabled: false, weight: 0.5 },
  { id: 'internet', label: 'Internet', description: 'Fiber and broadband coverage', icon: '📡', enabled: false, weight: 0.4 },
  { id: 'noise', label: 'Noise', description: 'Noise pollution levels', icon: '🔊', enabled: false, weight: 0.3 },
  // Climate sub-layers
  { id: 'climateTemp', label: 'Temperature', description: 'Average temperature', icon: '🌡', enabled: false, weight: 0.5 },
  { id: 'climateRainfall', label: 'Rainfall', description: 'Precipitation levels', icon: '🌧', enabled: false, weight: 0.5 },
  { id: 'rentalPrices', label: 'Rental Prices', description: 'Average rent per municipality', icon: '💶', enabled: false, weight: 0.8 },
  { id: 'employment', label: 'Employment', description: 'Unemployment and income', icon: '💼', enabled: false, weight: 0.5 },
  { id: 'amenities', label: 'Amenities', description: 'Culture, sports, leisure', icon: '🎭', enabled: false, weight: 0.3 },
];

interface AppState {
  layers: LayerMeta[];
  configs: LayerConfigs;
  view: ViewSettings;
  selectedMunicipality: string | null;
  sidebarOpen: boolean;
  /** When non-null the heatmap shows only this layer's isolated contribution. */
  soloLayer: LayerId | null;
  /** Coordinates for point-based analysis (click anywhere on map). */
  analysisPoint: { lat: number; lon: number } | null;
  /** When true, map clicks set analysisPoint instead of selecting a municipality. */
  pointAnalysisMode: boolean;
  /** Named presets saved by the user. */
  presets: Preset[];
  /** Active UI language. */
  lang: Lang;
  /** User-editable composite score formula. */
  customFormula: string;
  /** Formula editor mode: visual chips or raw expression. */
  formulaMode: 'visual' | 'raw';
  /** Data integrity admin panel visibility. */
  dataIntegrityPanelOpen: boolean;
  /** Persisted integrity rules. */
  integrityRules: IntegrityRules;
  /** Last generated integrity report. */
  integrityReport: IntegrityReport | null;
  /** Informational signature of last checked payload. */
  integrityLastSignature: string | null;

  /** Undo history stacks (not persisted). */
  _past: HistoryEntry[];
  _future: HistoryEntry[];

  toggleLayer: (id: LayerId) => void;
  setLayerWeight: (id: LayerId, weight: number) => void;
  setConfigs: (configs: LayerConfigs) => void;
  updateConfig: <K extends keyof LayerConfigs>(layer: K, values: LayerConfigs[K]) => void;
  setView: (patch: Partial<ViewSettings>) => void;
  setCustomFormula: (formula: string) => void;
  resetCustomFormula: () => void;
  setFormulaMode: (mode: 'visual' | 'raw') => void;
  setDataIntegrityPanelOpen: (open: boolean) => void;
  updateIntegrityRules: (patch: Partial<IntegrityRules>) => void;
  replaceIntegrityRules: (rules: IntegrityRules) => void;
  resetIntegrityRules: () => void;
  runIntegrityChecks: (input: DataIntegrityInput) => IntegrityReport;
  clearIntegrityReport: () => void;
  importIntegrityProfile: (json: string) => { ok: boolean; error?: string };
  exportIntegrityProfile: () => string;
  selectMunicipality: (codi: string | null) => void;
  toggleSidebar: () => void;
  setAnalysisPoint: (point: { lat: number; lon: number } | null) => void;
  togglePointAnalysisMode: () => void;
  setSoloLayer: (id: LayerId | null) => void;
  savePreset: (name: string) => void;
  loadPreset: (name: string) => void;
  deletePreset: (name: string) => void;
  resetToDefaults: () => void;
  setLang: (lang: Lang) => void;
  toggleLang: () => void;
  /** Push current undoable state to history (called internally). */
  _pushHistory: () => void;
  undo: () => void;
  redo: () => void;
}

export const useAppStore = create<AppState>()(
  persist(
    (set, get) => ({
      layers: DEFAULT_LAYERS,
      configs: DEFAULT_LAYER_CONFIGS,
      view: DEFAULT_VIEW,
      selectedMunicipality: null,
      sidebarOpen: true,
      soloLayer: null,
      analysisPoint: null,
      pointAnalysisMode: false,
      presets: [],
      lang: 'ca' as Lang,
      customFormula: DEFAULT_CUSTOM_FORMULA,
      formulaMode: 'visual',
      dataIntegrityPanelOpen: false,
      integrityRules: DEFAULT_INTEGRITY_RULES,
      integrityReport: null,
      integrityLastSignature: null,
      _past: [],
      _future: [],

      _pushHistory: () => {
        const { layers, configs, soloLayer, _past } = get();
        const entry: HistoryEntry = {
          layers: layers.map((l) => ({ ...l })),
          configs: structuredClone(configs),
          soloLayer,
        };
        set({ _past: [..._past.slice(-MAX_HISTORY), entry], _future: [] });
      },

      undo: () => {
        const { _past, layers, configs, soloLayer } = get();
        if (_past.length === 0) return;
        const prev = _past[_past.length - 1];
        const current: HistoryEntry = {
          layers: layers.map((l) => ({ ...l })),
          configs: structuredClone(configs),
          soloLayer,
        };
        set({
          layers: prev.layers,
          configs: prev.configs,
          soloLayer: prev.soloLayer,
          _past: _past.slice(0, -1),
          _future: [...get()._future, current],
        });
      },

      redo: () => {
        const { _future, layers, configs, soloLayer } = get();
        if (_future.length === 0) return;
        const next = _future[_future.length - 1];
        const current: HistoryEntry = {
          layers: layers.map((l) => ({ ...l })),
          configs: structuredClone(configs),
          soloLayer,
        };
        set({
          layers: next.layers,
          configs: next.configs,
          soloLayer: next.soloLayer,
          _future: _future.slice(0, -1),
          _past: [...get()._past, current],
        });
      },

      toggleLayer: (id) => {
        get()._pushHistory();
        set((state) => ({
          layers: state.layers.map((l) => (l.id === id ? { ...l, enabled: !l.enabled } : l)),
        }));
      },

      setLayerWeight: (id, weight) => {
        get()._pushHistory();
        set((state) => ({
          layers: state.layers.map((l) => (l.id === id ? { ...l, weight } : l)),
        }));
      },

      setConfigs: (configs) => { get()._pushHistory(); set({ configs }); },

      updateConfig: (layer, values) => {
        get()._pushHistory();
        set((state) => ({
          configs: { ...state.configs, [layer]: values },
        }));
      },

      setView: (patch) =>
        set((state) => ({ view: { ...state.view, ...patch } })),

      setCustomFormula: (customFormula) => set({ customFormula: normalizeUserFormulaInput(customFormula) }),
      resetCustomFormula: () => set({ customFormula: DEFAULT_CUSTOM_FORMULA }),
      setFormulaMode: (formulaMode) => set({ formulaMode }),
      setDataIntegrityPanelOpen: (open) => set({ dataIntegrityPanelOpen: open }),

      updateIntegrityRules: (patch) =>
        set((state) => ({ integrityRules: { ...state.integrityRules, ...patch } })),

      replaceIntegrityRules: (rules) => set({ integrityRules: rules }),

      resetIntegrityRules: () => set({ integrityRules: DEFAULT_INTEGRITY_RULES }),

      runIntegrityChecks: (input) => {
        const report = runDataIntegrityChecks(input, get().integrityRules);
        const municipalitiesCount = input.municipalities?.features.length ?? 0;
        const signature = `${municipalitiesCount}:${Object.keys(input.municipalityData.votes).length}:${Object.keys(input.municipalityData.terrain).length}`;
        set({ integrityReport: report, integrityLastSignature: signature });
        return report;
      },

      clearIntegrityReport: () => set({ integrityReport: null, integrityLastSignature: null }),

      importIntegrityProfile: (json) => {
        try {
          const parsed = JSON.parse(json) as Partial<IntegrityRules>;
          const merged: IntegrityRules = {
            ...DEFAULT_INTEGRITY_RULES,
            ...parsed,
            leftParties: Array.isArray(parsed.leftParties)
              ? parsed.leftParties.map(String)
              : DEFAULT_INTEGRITY_RULES.leftParties,
            independenceParties: Array.isArray(parsed.independenceParties)
              ? parsed.independenceParties.map(String)
              : DEFAULT_INTEGRITY_RULES.independenceParties,
          };
          set({ integrityRules: merged });
          return { ok: true };
        } catch (error) {
          return {
            ok: false,
            error: error instanceof Error ? error.message : 'Invalid profile JSON',
          };
        }
      },

      exportIntegrityProfile: () => JSON.stringify(get().integrityRules, null, 2),

      selectMunicipality: (codi) => set({ selectedMunicipality: codi }),
      toggleSidebar: () => set((state) => ({ sidebarOpen: !state.sidebarOpen })),
      setAnalysisPoint: (point) => set({ analysisPoint: point }),
      togglePointAnalysisMode: () =>
        set((state) => ({
          pointAnalysisMode: !state.pointAnalysisMode,
          analysisPoint: state.pointAnalysisMode ? null : state.analysisPoint,
        })),

      setSoloLayer: (id) => { get()._pushHistory(); set({ soloLayer: id }); },

      savePreset: (name) => {
        const { layers, configs, presets } = get();
        const existing = presets.filter((p) => p.name !== name);
        set({ presets: [...existing, { name, layers: [...layers], configs: { ...configs } }] });
      },

      loadPreset: (name) => {
        const preset = get().presets.find((p) => p.name === name);
        if (preset) set({ layers: preset.layers, configs: preset.configs, soloLayer: null });
      },

      deletePreset: (name) =>
        set((state) => ({ presets: state.presets.filter((p) => p.name !== name) })),

      resetToDefaults: () =>
        set({
          layers: DEFAULT_LAYERS,
          configs: DEFAULT_LAYER_CONFIGS,
          soloLayer: null,
          customFormula: DEFAULT_CUSTOM_FORMULA,
          formulaMode: 'visual',
          view: DEFAULT_VIEW,
        }),

      setLang: (lang) => set({ lang }),
      toggleLang: () => set((state) => ({ lang: state.lang === 'ca' ? 'en' : 'ca' })),
    }),
    {
      name: 'better-idealista-config',
      version: 7,
      // Persist everything except transient UI state
      partialize: (state) => ({
        layers: state.layers,
        configs: state.configs,
        view: state.view,
        customFormula: state.customFormula,
        formulaMode: state.formulaMode,
        integrityRules: state.integrityRules,
        dataIntegrityPanelOpen: state.dataIntegrityPanelOpen,
        presets: state.presets,
        sidebarOpen: state.sidebarOpen,
        lang: state.lang,
      }),
      /**
       * Migrate persisted state from older versions.
       *
       * v0→v1: votes axis+value → multi-term format.
      * v1→v2: compound layer IDs split into sub-layer IDs.
      * v2→v3: add custom formula + disqualified-mask toggle defaults.
      * v3→v4: normalize cached formulas (strip leading Score=).
       */
      migrate: (persisted: unknown, version: number) => {
        const state = persisted as Record<string, unknown>;

        // ── v0 → v1: votes axis → terms ──────────────────────────
        if (version < 1 && state.configs) {
          const cfgs = state.configs as Record<string, unknown>;
          const votes = cfgs.votes as Record<string, unknown> | undefined;
          if (votes && !votes.terms) {
            const axis = (votes.axis as string) || 'left-right';
            const metric = axis === 'left-right' ? 'leftPct' : 'independencePct';
            const value = votes.value || { enabled: true, tf: defaultTf(0, 100, 'sin', 0) };
            cfgs.votes = {
              terms: [{ id: 'v1', metric, value }] as VoteTerm[],
            };
          }
        }

        // ── v1 → v2: split compound layers into sub-layers ───────
        if (version < 2 && state.layers) {
          const layers = state.layers as Array<Record<string, unknown>>;
          const SPLIT_MAP: Record<string, Array<{ id: string; label: string; icon: string }>> = {
            terrain: [
              { id: 'terrainSlope', label: 'Terrain Slope', icon: '📐' },
              { id: 'terrainElevation', label: 'Elevation', icon: '🏔' },
              { id: 'terrainAspect', label: 'Slope Orientation', icon: '🧭' },
            ],
            votes: [
              { id: 'votesLeft', label: 'Left-wing %', icon: '✊' },
              { id: 'votesRight', label: 'Right-wing %', icon: '🏛' },
              { id: 'votesIndep', label: 'Independence %', icon: '🎗' },
              { id: 'votesUnionist', label: 'Unionist %', icon: '🤝' },
              { id: 'votesTurnout', label: 'Turnout %', icon: '🗳' },
            ],
            airQuality: [
              { id: 'airQualityPm10', label: 'PM10 Particles', icon: '🫁' },
              { id: 'airQualityNo2', label: 'NO₂', icon: '🏭' },
            ],
            climate: [
              { id: 'climateTemp', label: 'Temperature', icon: '🌡' },
              { id: 'climateRainfall', label: 'Rainfall', icon: '🌧' },
            ],
          };

          const newLayers: Array<Record<string, unknown>> = [];
          const seen = new Set<string>();

          for (const layer of layers) {
            const oldId = layer.id as string;
            const subs = SPLIT_MAP[oldId];
            if (subs) {
              for (const sub of subs) {
                if (seen.has(sub.id)) continue;
                seen.add(sub.id);
                newLayers.push({
                  ...layer,
                  id: sub.id,
                  label: sub.label,
                  icon: sub.icon,
                  description: '',
                });
              }
            } else if (!seen.has(oldId)) {
              seen.add(oldId);
              newLayers.push(layer);
            }
          }

          state.layers = newLayers;

          // Ensure all 5 vote terms exist in configs
          const cfgs = state.configs as Record<string, unknown> | undefined;
          if (cfgs?.votes) {
            const votes = cfgs.votes as { terms?: VoteTerm[] };
            const existing = votes.terms ?? [];
            const ALL_METRICS = ['leftPct', 'rightPct', 'independencePct', 'unionistPct', 'turnoutPct'];
            const usedMetrics = new Set(existing.map((t: VoteTerm) => t.metric));
            for (const m of ALL_METRICS) {
              if (!usedMetrics.has(m as VoteTerm['metric'])) {
                existing.push({ id: `v${Date.now()}_${m}`, metric: m as VoteTerm['metric'], value: { enabled: true, tf: defaultTf(0, 100, 'sin', 0) } });
              }
            }
            votes.terms = existing;
          }
        }

        // ── v2 → v3: formula + mask toggle defaults ─────────────
        if (version < 3) {
          if (!state.customFormula || typeof state.customFormula !== 'string') {
            state.customFormula = DEFAULT_CUSTOM_FORMULA;
          }
          const view = (state.view as Record<string, unknown> | undefined) ?? {};
          if (typeof view.maskDisqualifiedAsBlack !== 'boolean') {
            state.view = { ...DEFAULT_VIEW, ...view, maskDisqualifiedAsBlack: true };
          }
          if (state.formulaMode !== 'raw' && state.formulaMode !== 'visual') {
            state.formulaMode = 'visual';
          }
        }

        // ── v3 → v4: normalize formula text ─────────────────────
        if (version < 4) {
          if (typeof state.customFormula === 'string') {
            state.customFormula = normalizeUserFormulaInput(state.customFormula);
          }
        }

        // ── v4 → v5: reset stuck-in-raw with old default formula ─
        if (version < 5) {
          // If the user was stuck in raw mode with the old unit-suffix
          // default formula, clear it and return to visual mode.
          if (typeof state.customFormula === 'string' && /[ºÂ°%]/.test(state.customFormula)) {
            state.customFormula = '';
            state.formulaMode = 'visual';
          }
        }

        // ── v5 → v6: invert:boolean → shape:TfShape ─────────────
        if (version < 6) {
          const cfgs = state.configs as Record<string, unknown> | undefined;
          if (cfgs) {
            const migrateTf = (tf: Record<string, unknown>) => {
              if (tf && typeof tf === 'object' && !('shape' in tf)) {
                tf.shape = 'sin';
                delete tf.invert;
              }
            };
            const migrateLtc = (ltc: Record<string, unknown> | undefined) => {
              if (ltc?.tf) migrateTf(ltc.tf as Record<string, unknown>);
            };
            const terrain = cfgs.terrain as Record<string, unknown> | undefined;
            if (terrain) {
              migrateLtc(terrain.slope as Record<string, unknown>);
              migrateLtc(terrain.elevation as Record<string, unknown>);
            }
            const votes = cfgs.votes as { terms?: Array<{ value?: Record<string, unknown> }> } | undefined;
            if (votes?.terms) {
              for (const term of votes.terms) migrateLtc(term.value);
            }
            for (const key of ['transit', 'forest', 'crime', 'healthcare', 'schools', 'internet', 'rentalPrices', 'employment', 'amenities']) {
              migrateLtc(cfgs[key] as Record<string, unknown>);
            }
            const aq = cfgs.airQuality as Record<string, unknown> | undefined;
            if (aq) { migrateLtc(aq.pm10 as Record<string, unknown>); migrateLtc(aq.no2 as Record<string, unknown>); }
            const cl = cfgs.climate as Record<string, unknown> | undefined;
            if (cl) { migrateLtc(cl.temperature as Record<string, unknown>); migrateLtc(cl.rainfall as Record<string, unknown>); }
          }
          // Clear old-format raw formulas that used RANGE
          if (typeof state.customFormula === 'string' && state.customFormula.includes('RANGE(') && !state.customFormula.includes('SIN(')) {
            state.customFormula = '';
            state.formulaMode = 'visual';
          }
        }

        // ── v6 → v7: add integrity defaults ─────────────────────
        if (version < 7) {
          if (!state.integrityRules || typeof state.integrityRules !== 'object') {
            state.integrityRules = DEFAULT_INTEGRITY_RULES;
          }
          if (typeof state.dataIntegrityPanelOpen !== 'boolean') {
            state.dataIntegrityPanelOpen = false;
          }
        }

        return state as unknown as AppState;
      },
    },
  ),
);
