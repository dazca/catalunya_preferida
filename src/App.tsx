/**
 * @file App component: root of the application.
 *       Wires together MapContainer, Sidebar, ViewMenu, and scoring engine.
 */
import { useMemo, useState, useEffect, useRef, useCallback } from 'react';
import MapContainer from './components/MapContainer';
import MunicipalityInfo from './components/MunicipalityInfo';
import PointAnalysisPanel from './components/PointAnalysisPanel';
import FormulaBar from './components/FormulaBar';
import { useAppStore } from './store';
import { useT } from './i18n';
import { useResourceData } from './hooks/useResourceData';
import { computeAllScores } from './utils/scorer';
import { computePointScore } from './utils/pointAnalysis';
import { visualToRawFormula } from './utils/formulaEngine';
import {
  renderHeatmapImage,
  viewportSpecForZoom,
  CATALONIA_VIEWPORT,
} from './utils/heatmapGrid';
import type { ViewportSpec } from './utils/heatmapGrid';
import { onDemLoaded, loadViewportTiles, isDemLoaded, sampleDemViewport } from './utils/demSlope';
import { requestHeatmapRender, gridViewportSpecForZoom } from './utils/heatmapBridge';

export default function App() {
  const { layers, configs, view, customFormula, formulaMode, analysisPoint, soloLayer, undo, redo } = useAppStore();
  const t = useT();
  const {
    municipalities,
    municipalityData,
    facilityPoints,
    climateStations,
    loading,
    error,
  } = useResourceData();

  /** Extract municipality codes from GeoJSON */
  const municipalityCodes = useMemo(() => {
    if (!municipalities) return [];
    return municipalities.features.map((f) => f.properties.codi).filter(Boolean);
  }, [municipalities]);

  /** Municipality name lookup */
  const municipalityNames = useMemo(() => {
    if (!municipalities) return {};
    const map: Record<string, string> = {};
    for (const f of municipalities.features) {
      if (f.properties.codi && f.properties.nom) {
        map[f.properties.codi] = f.properties.nom;
      }
    }
    return map;
  }, [municipalities]);

  /** Canonical formula from the current visual state — used to detect manual edits. */
  const enabledLayers = useMemo(() => layers.filter((l) => l.enabled), [layers]);
  const visualRawFormula = useMemo(
    () => visualToRawFormula(enabledLayers, configs),
    [enabledLayers, configs],
  );

  /**
   * Active formula for scoring.  Returns `undefined` (= use visual pipeline)
   * when the stored customFormula matches the auto-generated visualRawFormula,
   * because both paths are mathematically equivalent and the visual pipeline
   * handles missing data and edge-cases more robustly.
   * Only returns the formula string when the user has manually edited it.
   */
  const activeFormula = useMemo(() => {
    if (formulaMode !== 'raw') return undefined;
    const trimmed = customFormula.trim();
    if (!trimmed) return undefined;
    if (trimmed === visualRawFormula.trim()) return undefined; // auto-generated — use visual pipeline
    return customFormula;
  }, [formulaMode, customFormula, visualRawFormula]);

  /** Compute per-municipality scores */
  const allScores = useMemo(() => {
    if (municipalityCodes.length === 0) return {};
    return computeAllScores(
      municipalityCodes,
      layers,
      configs,
      municipalityData,
      activeFormula,
    );
  }, [municipalityCodes, layers, configs, municipalityData, activeFormula]);

  /** Layers used for heatmap rendering — solo mode isolates a single layer. */
  const heatmapLayers = useMemo(() => {
    if (!soloLayer) return layers;
    return layers.map((l) => ({ ...l, enabled: l.id === soloLayer }));
  }, [layers, soloLayer]);

  /** Scores for heatmap — recomputed when solo layer changes. */
  const heatmapScores = useMemo(() => {
    if (municipalityCodes.length === 0) return {};
    if (!soloLayer) return {}; // will use allScores below
    const solo = computeAllScores(
      municipalityCodes,
      heatmapLayers,
      configs,
      municipalityData,
      activeFormula,
    );
    const flat: Record<string, number> = {};
    for (const [codi, data] of Object.entries(solo)) flat[codi] = data.score;
    return flat;
  }, [municipalityCodes, heatmapLayers, configs, municipalityData, soloLayer, activeFormula]);

  /** Flatten to just the composite score for choropleth */
  const scores = useMemo(() => {
    const flat: Record<string, number> = {};
    for (const [codi, data] of Object.entries(allScores)) {
      flat[codi] = data.score;
    }
    return flat;
  }, [allScores]);

  /* ---------------------------------------------------------------- */
  /*  Deferred heatmap — never blocks the first render.               */
  /*  Uses requestIdleCallback / setTimeout so the map + terrain load */
  /*  first, then the heatmap paints in the background.               */
  /* ---------------------------------------------------------------- */
  const [heatmapDataUrl, setHeatmapDataUrl] = useState<string | null>(null);
  /** Bounds [w,s,e,n] of the most recently rendered heatmap image. */
  const [heatmapBounds, setHeatmapBounds] = useState<[number,number,number,number]>(
    [CATALONIA_VIEWPORT.w, CATALONIA_VIEWPORT.s, CATALONIA_VIEWPORT.e, CATALONIA_VIEWPORT.n],
  );
  /** Current viewport spec — drives heatmap re-render on pan/zoom. */
  const [viewportSpec, setViewportSpec] = useState<ViewportSpec>(CATALONIA_VIEWPORT);
  /** Higher-resolution spec for the grid-based pipeline (up to 1024px). */
  const [gridSpec, setGridSpec] = useState<ViewportSpec>(CATALONIA_VIEWPORT);
  const heatmapTimer = useRef<ReturnType<typeof setTimeout> | number>(0);
  const viewportDebounce = useRef<ReturnType<typeof setTimeout> | null>(null);

  /** Called by MapContainer whenever the map is panned or zoomed. */
  const handleViewportChange = useCallback(
    (w: number, s: number, e: number, n: number, zoom: number) => {
      if (viewportDebounce.current) clearTimeout(viewportDebounce.current);
      viewportDebounce.current = setTimeout(() => {
        setViewportSpec(viewportSpecForZoom(w, s, e, n, zoom));
        setGridSpec(gridViewportSpecForZoom(w, s, e, n, zoom) as ViewportSpec);
        // Demand-load fine DEM tiles for this viewport
        const targetM = Math.max(80, Math.min(3000, Math.round(15_000 / Math.pow(2, zoom - 8))));
        loadViewportTiles(w, s, e, n, targetM).then((anyNew) => {
          if (anyNew) setDemFineTileVersion((v) => v + 1);
        });
      }, 600);
    },
    [],
  );

  /**
   * Bump this counter once when DEM slope data finishes loading so the
   * heatmap effect re-runs with real per-pixel terrain scores.
   */
  const [demSlopeVersion, setDemSlopeVersion] = useState(0);
  useEffect(() => {
    return onDemLoaded(() => setDemSlopeVersion((v) => v + 1));
  }, []);

  /**
   * Bumped each time at least one fine DEM tile finishes loading so the
   * heatmap re-renders at higher slope resolution.
   */
  const [demFineTileVersion, setDemFineTileVersion] = useState(0);

  /** Global keyboard shortcut: Ctrl+Z undo, Ctrl+Y / Ctrl+Shift+Z redo. */
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.altKey) {
        if (e.key === 'z' && !e.shiftKey) { e.preventDefault(); undo(); }
        if (e.key === 'z' && e.shiftKey)  { e.preventDefault(); redo(); }
        if (e.key === 'y')                { e.preventDefault(); redo(); }
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [undo, redo]);

  useEffect(() => {
    // Cancel any pending render
    if (typeof heatmapTimer.current === 'number' && heatmapTimer.current) {
      if ('cancelIdleCallback' in window) {
        cancelIdleCallback(heatmapTimer.current);
      } else {
        clearTimeout(heatmapTimer.current);
      }
    }

    if (!municipalities || municipalityCodes.length === 0 || Object.keys(scores).length === 0) {
      setHeatmapDataUrl(null);
      return;
    }

    if (!view.showHeatmap) {
      setHeatmapDataUrl(null);
      return;
    }

    let cancelled = false;

    // Use the new grid-based async pipeline when no custom formula is active.
    // Custom formula still uses the old per-pixel path for full compatibility.
    const useGridPipeline = !activeFormula;

    const run = async () => {
      if (cancelled) return;

      if (useGridPipeline) {
        // ── New grid-based pipeline (higher-res spec) ────────────
        const { w, s, e, n, cols, rows } = gridSpec;
        const demSamples = isDemLoaded()
          ? sampleDemViewport(w, s, e, n, cols, rows)
          : null;

        const result = await requestHeatmapRender({
          municipalities,
          municipalityData,
          layers: heatmapLayers,
          configs,
          spec: gridSpec,
          demSamples,
          disqualifiedMask: view.maskDisqualifiedAsBlack ? 'black' : 'transparent',
        });

        if (cancelled || !result) return;
        setHeatmapDataUrl(result.dataUrl);
        setHeatmapBounds(result.bounds);
      } else {
        // ── Legacy per-pixel pipeline (custom formula) ──────────
        const renderScores = soloLayer ? heatmapScores : scores;
        const url = renderHeatmapImage(
          municipalities,
          renderScores,
          municipalityData,
          heatmapLayers,
          configs,
          viewportSpec,
          {
            customFormula: activeFormula,
            disqualifiedMask: view.maskDisqualifiedAsBlack ? 'black' : 'transparent',
          },
        );
        if (!cancelled && url) {
          setHeatmapDataUrl(url);
          setHeatmapBounds([viewportSpec.w, viewportSpec.s, viewportSpec.e, viewportSpec.n]);
        }
      }
    };

    if ('requestIdleCallback' in window) {
      heatmapTimer.current = requestIdleCallback(() => { run(); }, { timeout: 3000 });
    } else {
      heatmapTimer.current = setTimeout(() => { run(); }, 200);
    }

    return () => {
      cancelled = true;
      if (typeof heatmapTimer.current === 'number' && heatmapTimer.current) {
        if ('cancelIdleCallback' in window) {
          cancelIdleCallback(heatmapTimer.current);
        } else {
          clearTimeout(heatmapTimer.current);
        }
      }
    };
  }, [municipalities, scores, heatmapScores, heatmapLayers, municipalityData, layers, configs, municipalityCodes, demSlopeVersion, demFineTileVersion, viewportSpec, gridSpec, soloLayer, activeFormula, view.showHeatmap, view.maskDisqualifiedAsBlack]);

  /** Compute point-based analysis score when an analysis point is set */
  const pointScore = useMemo(() => {
    if (!analysisPoint || !municipalities) return null;
    const enabled = layers.filter((l) => l.enabled);
    return computePointScore(
      analysisPoint.lat,
      analysisPoint.lon,
      enabled,
      configs,
      municipalities,
      municipalityData,
      facilityPoints,
      climateStations,
    );
  }, [analysisPoint, municipalities, layers, configs, municipalityData, facilityPoints, climateStations]);

  return (
    <div style={{ width: '100vw', height: '100vh', position: 'relative' }}>
      {loading && (
        <div style={{
          position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          background: 'rgba(255,255,255,0.9)', zIndex: 2000,
          fontSize: 18, color: '#555',
        }}>
          {t('app.loading')}
        </div>
      )}

      {error && (
        <div style={{
          position: 'fixed', top: 12, left: '50%', transform: 'translateX(-50%)',
          zIndex: 2000, background: '#ffebee', color: '#c62828',
          padding: '8px 16px', borderRadius: 4, fontSize: 13,
        }}>
          Error: {error}
        </div>
      )}

      <MapContainer
        municipalities={municipalities}
        scores={scores}
        heatmapDataUrl={heatmapDataUrl}
        heatmapBounds={heatmapBounds}
        onViewportChange={handleViewportChange}
      />
      <MunicipalityInfo scores={scores} municipalityNames={municipalityNames} />
      <PointAnalysisPanel result={pointScore} />
      <FormulaBar />
    </div>
  );
}
