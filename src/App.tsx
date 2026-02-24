/**
 * @file App component: root of the application.
 *       Wires together MapContainer, Sidebar, ViewMenu, and scoring engine.
 */
import { useMemo, useState, useEffect, useRef, useCallback } from 'react';
import MapContainer from './components/MapContainer';
import Sidebar from './components/Sidebar';
import MunicipalityInfo from './components/MunicipalityInfo';
import PointAnalysisPanel from './components/PointAnalysisPanel';
import FormulaBar from './components/FormulaBar';
import { useAppStore } from './store';
import { useT } from './i18n';
import { useResourceData } from './hooks/useResourceData';
import { computeAllScores } from './utils/scorer';
import { computePointScore } from './utils/pointAnalysis';
import {
  renderHeatmapImage,
  viewportSpecForZoom,
  CATALONIA_VIEWPORT,
} from './utils/heatmapGrid';
import type { ViewportSpec } from './utils/heatmapGrid';
import { onDemLoaded, loadViewportTiles } from './utils/demSlope';

export default function App() {
  const { layers, configs, analysisPoint, soloLayer } = useAppStore();
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

  /** Compute per-municipality scores */
  const allScores = useMemo(() => {
    if (municipalityCodes.length === 0) return {};
    return computeAllScores(municipalityCodes, layers, configs, municipalityData);
  }, [municipalityCodes, layers, configs, municipalityData]);

  /** Layers used for heatmap rendering — solo mode isolates a single layer. */
  const heatmapLayers = useMemo(() => {
    if (!soloLayer) return layers;
    return layers.map((l) => ({ ...l, enabled: l.id === soloLayer }));
  }, [layers, soloLayer]);

  /** Scores for heatmap — recomputed when solo layer changes. */
  const heatmapScores = useMemo(() => {
    if (municipalityCodes.length === 0) return {};
    if (!soloLayer) return {}; // will use allScores below
    const solo = computeAllScores(municipalityCodes, heatmapLayers, configs, municipalityData);
    const flat: Record<string, number> = {};
    for (const [codi, data] of Object.entries(solo)) flat[codi] = data.score;
    return flat;
  }, [municipalityCodes, heatmapLayers, configs, municipalityData, soloLayer]);

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
  const heatmapTimer = useRef<ReturnType<typeof setTimeout> | number>(0);
  const viewportDebounce = useRef<ReturnType<typeof setTimeout> | null>(null);

  /** Called by MapContainer whenever the map is panned or zoomed. */
  const handleViewportChange = useCallback(
    (w: number, s: number, e: number, n: number, zoom: number) => {
      if (viewportDebounce.current) clearTimeout(viewportDebounce.current);
      viewportDebounce.current = setTimeout(() => {
        const spec = viewportSpecForZoom(w, s, e, n, zoom);
        setViewportSpec(spec);
        // Demand-load fine DEM tiles for this viewport; re-render heatmap if
        // new tiles arrive.
        const targetM = Math.max(80, Math.min(3000, Math.round(15_000 / Math.pow(2, zoom - 8))));
        loadViewportTiles(w, s, e, n, targetM).then((anyNew) => {
          if (anyNew) setDemFineTileVersion((v) => v + 1);
        });
      }, 400);
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

    // Schedule heatmap render during idle time
    const run = () => {
      const renderScores  = soloLayer ? heatmapScores : scores;
      const renderLayers  = heatmapLayers;
      const url = renderHeatmapImage(municipalities, renderScores, municipalityData, renderLayers, configs, viewportSpec);
      if (url) {
        setHeatmapDataUrl(url);
        setHeatmapBounds([viewportSpec.w, viewportSpec.s, viewportSpec.e, viewportSpec.n]);
      }
    };

    if ('requestIdleCallback' in window) {
      heatmapTimer.current = requestIdleCallback(run, { timeout: 3000 });
    } else {
      heatmapTimer.current = setTimeout(run, 200);
    }

    return () => {
      if (typeof heatmapTimer.current === 'number' && heatmapTimer.current) {
        if ('cancelIdleCallback' in window) {
          cancelIdleCallback(heatmapTimer.current);
        } else {
          clearTimeout(heatmapTimer.current);
        }
      }
    };
  }, [municipalities, scores, heatmapScores, heatmapLayers, municipalityData, layers, configs, municipalityCodes, demSlopeVersion, demFineTileVersion, viewportSpec, soloLayer]);

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
      <Sidebar />
      <MunicipalityInfo scores={scores} municipalityNames={municipalityNames} />
      <PointAnalysisPanel result={pointScore} />
      <FormulaBar />
    </div>
  );
}
