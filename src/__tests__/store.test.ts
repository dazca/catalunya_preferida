/**
 * @file Tests for the Zustand app store.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { useAppStore, DEFAULT_LAYERS, DEFAULT_VIEW } from '../store';
import { DEFAULT_LAYER_CONFIGS, defaultTf } from '../types/transferFunction';

describe('useAppStore', () => {
  beforeEach(() => {
    useAppStore.setState({
      layers: DEFAULT_LAYERS.map((l) => ({ ...l })),
      configs: structuredClone(DEFAULT_LAYER_CONFIGS),
      view: { ...DEFAULT_VIEW },
      selectedMunicipality: null,
      sidebarOpen: true,
      analysisPoint: null,
      pointAnalysisMode: false,
    });
  });

  it('has correct default state', () => {
    const state = useAppStore.getState();
    expect(state.layers).toHaveLength(23);
    expect(state.sidebarOpen).toBe(true);
    expect(state.selectedMunicipality).toBeNull();
    expect(state.configs).toBeDefined();
  });

  it('toggleLayer flips enabled state', () => {
    const initialEnabled = useAppStore.getState().layers.find((l) => l.id === 'terrainSlope')!.enabled;
    useAppStore.getState().toggleLayer('terrainSlope');
    const newEnabled = useAppStore.getState().layers.find((l) => l.id === 'terrainSlope')!.enabled;
    expect(newEnabled).toBe(!initialEnabled);
  });

  it('setLayerWeight updates the weight', () => {
    useAppStore.getState().setLayerWeight('terrainSlope', 1.5);
    const weight = useAppStore.getState().layers.find((l) => l.id === 'terrainSlope')!.weight;
    expect(weight).toBe(1.5);
  });

  it('updateConfig replaces a layer config', () => {
    const newTransit = { enabled: true, tf: defaultTf(2, 15, 'sin', 0.2) };
    useAppStore.getState().updateConfig('transit', newTransit);
    const transit = useAppStore.getState().configs.transit;
    expect(transit.tf.plateauEnd).toBe(2);
    expect(transit.tf.decayEnd).toBe(15);
    expect(transit.tf.floor).toBe(0.2);
  });

  it('selectMunicipality sets the selected code', () => {
    useAppStore.getState().selectMunicipality('08019');
    expect(useAppStore.getState().selectedMunicipality).toBe('08019');
    useAppStore.getState().selectMunicipality(null);
    expect(useAppStore.getState().selectedMunicipality).toBeNull();
  });

  it('toggleSidebar flips open state', () => {
    expect(useAppStore.getState().sidebarOpen).toBe(true);
    useAppStore.getState().toggleSidebar();
    expect(useAppStore.getState().sidebarOpen).toBe(false);
  });

  it('setAnalysisPoint sets and clears the point', () => {
    useAppStore.getState().setAnalysisPoint({ lat: 41.5, lon: 1.7 });
    expect(useAppStore.getState().analysisPoint).toEqual({ lat: 41.5, lon: 1.7 });
    useAppStore.getState().setAnalysisPoint(null);
    expect(useAppStore.getState().analysisPoint).toBeNull();
  });

  it('togglePointAnalysisMode toggles and clears point on exit', () => {
    useAppStore.getState().togglePointAnalysisMode();
    expect(useAppStore.getState().pointAnalysisMode).toBe(true);
    useAppStore.getState().setAnalysisPoint({ lat: 41.5, lon: 1.7 });
    useAppStore.getState().togglePointAnalysisMode();
    expect(useAppStore.getState().pointAnalysisMode).toBe(false);
    expect(useAppStore.getState().analysisPoint).toBeNull();
  });

  it('has default view settings', () => {
    const v = useAppStore.getState().view;
    expect(v.show3dTerrain).toBe(true);
    expect(v.showHillshade).toBe(true);
    expect(v.showElevationTint).toBe(true);
    expect(v.showHeatmap).toBe(true);
    expect(v.showBorders).toBe(false);
    expect(v.showChoropleth).toBe(false);
    expect(v.terrainExaggeration).toBe(1.5);
    expect(v.heatmapOpacity).toBe(0.75);
  });

  it('setView patches view settings', () => {
    useAppStore.getState().setView({ showBorders: true, terrainExaggeration: 2.0 });
    const v = useAppStore.getState().view;
    expect(v.showBorders).toBe(true);
    expect(v.terrainExaggeration).toBe(2.0);
    // Other fields unchanged
    expect(v.show3dTerrain).toBe(true);
  });
});
