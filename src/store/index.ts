/**
 * @file Zustand store for application state.
 *
 * Persists layers, configs, view settings and named presets to localStorage
 * so configuration survives page reloads.
 */
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { LayerId, LayerMeta } from '../types';
import type { LayerConfigs } from '../types/transferFunction';
import { DEFAULT_LAYER_CONFIGS } from '../types/transferFunction';
import type { Lang } from '../i18n';

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
};

/** All available layers with their default metadata */
export const DEFAULT_LAYERS: LayerMeta[] = [
  { id: 'terrain', label: 'Terrain', description: 'Slope, aspect, elevation', icon: '⛰', enabled: true, weight: 1 },
  { id: 'votes', label: 'Vote Sentiment', description: 'Left/right, independence axis', icon: '🗳', enabled: true, weight: 1 },
  { id: 'transit', label: 'Public Transit', description: 'Rail, metro, bus proximity', icon: '🚆', enabled: true, weight: 1 },
  { id: 'forest', label: 'Forest Cover', description: 'Vegetation and green areas', icon: '🌲', enabled: true, weight: 1 },
  { id: 'soil', label: 'Soil & Aquifers', description: 'Geological and water data', icon: '💧', enabled: false, weight: 0.5 },
  { id: 'airQuality', label: 'Air Quality', description: 'NO2, PM10, PM2.5, O3', icon: '🌬', enabled: false, weight: 0.8 },
  { id: 'crime', label: 'Crime Rates', description: 'Offenses per 1000 inhabitants', icon: '🔒', enabled: false, weight: 0.7 },
  { id: 'healthcare', label: 'Healthcare', description: 'Hospitals and health centers', icon: '🏥', enabled: false, weight: 0.6 },
  { id: 'schools', label: 'Schools', description: 'Educational centers proximity', icon: '🎓', enabled: false, weight: 0.5 },
  { id: 'internet', label: 'Internet', description: 'Fiber and broadband coverage', icon: '📡', enabled: false, weight: 0.4 },
  { id: 'noise', label: 'Noise', description: 'Noise pollution levels', icon: '🔊', enabled: false, weight: 0.3 },
  { id: 'climate', label: 'Climate', description: 'Temperature, rainfall, wind', icon: '☀', enabled: false, weight: 0.5 },
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

  toggleLayer: (id: LayerId) => void;
  setLayerWeight: (id: LayerId, weight: number) => void;
  setConfigs: (configs: LayerConfigs) => void;
  updateConfig: <K extends keyof LayerConfigs>(layer: K, values: LayerConfigs[K]) => void;
  setView: (patch: Partial<ViewSettings>) => void;
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

      toggleLayer: (id) =>
        set((state) => ({
          layers: state.layers.map((l) => (l.id === id ? { ...l, enabled: !l.enabled } : l)),
        })),

      setLayerWeight: (id, weight) =>
        set((state) => ({
          layers: state.layers.map((l) => (l.id === id ? { ...l, weight } : l)),
        })),

      setConfigs: (configs) => set({ configs }),

      updateConfig: (layer, values) =>
        set((state) => ({
          configs: { ...state.configs, [layer]: values },
        })),

      setView: (patch) =>
        set((state) => ({ view: { ...state.view, ...patch } })),

      selectMunicipality: (codi) => set({ selectedMunicipality: codi }),
      toggleSidebar: () => set((state) => ({ sidebarOpen: !state.sidebarOpen })),
      setAnalysisPoint: (point) => set({ analysisPoint: point }),
      togglePointAnalysisMode: () =>
        set((state) => ({
          pointAnalysisMode: !state.pointAnalysisMode,
          analysisPoint: state.pointAnalysisMode ? null : state.analysisPoint,
        })),

      setSoloLayer: (id) => set({ soloLayer: id }),

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
        set({ layers: DEFAULT_LAYERS, configs: DEFAULT_LAYER_CONFIGS, soloLayer: null }),

      setLang: (lang) => set({ lang }),
      toggleLang: () => set((state) => ({ lang: state.lang === 'ca' ? 'en' : 'ca' })),
    }),
    {
      name: 'better-idealista-config',
      // Persist everything except transient UI state
      partialize: (state) => ({
        layers: state.layers,
        configs: state.configs,
        view: state.view,
        presets: state.presets,
        sidebarOpen: state.sidebarOpen,
        lang: state.lang,
      }),
    },
  ),
);
