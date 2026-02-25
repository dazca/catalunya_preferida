/**
 * @file MapContainer — full-resolution terrain map with 3D DEM, hillshade,
 *       hypsometric elevation tint, continuous heatmap overlay, and
 *       toggleable municipality borders.
 *
 * Layer stack (bottom → top):
 *   basemap → elevation-tint → hillshade → heatmap → choropleth → borders → highlight
 *
 * The ICGC basemap style already provides a 5 m DEM raster-dem source
 * (`terrainICGC`) used for both the 3D mesh and hillshade computations.
 */
import { useEffect, useRef, useCallback } from 'react';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { useAppStore } from '../store';
import type { ViewSettings } from '../store';
import './MapContainer.css';
import { scoreToCssColor } from '../utils/turboColormap';
import {
  registerHypsometricProtocol,
  configureDemTiles,
} from '../utils/hypsometric';
import { configureDemSlope, loadDemSlope } from '../utils/demSlope';
import type { MunicipalityCollection } from '../types';

/* ------------------------------------------------------------------ */
/*  Constants                                                         */
/* ------------------------------------------------------------------ */

/** Catalonia bounding box [west, south, east, north]. */
const CATALONIA_BOUNDS: [number, number, number, number] = [0.16, 40.52, 3.33, 42.86];
const CATALONIA_CENTER: [number, number] = [1.70, 41.69];

/** ICGC basemap style URL (includes DEM sources). */
const ICGC_BASEMAP =
  'https://geoserveis.icgc.cat/contextmaps/icgc_mapa_base_gris_simplificat.json';

/** Transparent 1×1 PNG used as placeholder for the image source. */
const EMPTY_PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

/** Register the custom tile protocol once at module level. */
registerHypsometricProtocol();

/* ------------------------------------------------------------------ */
/*  Helpers                                                           */
/* ------------------------------------------------------------------ */

/** Find the first symbol (label) layer so we can insert below it. */
function findFirstSymbolLayer(map: maplibregl.Map): string | undefined {
  for (const layer of map.getStyle().layers || []) {
    if (layer.type === 'symbol') return layer.id;
  }
  return undefined;
}

/** Discover the first raster-dem source in the loaded style. */
function findDemSource(
  style: maplibregl.StyleSpecification,
): { id: string; tileUrl: string; encoding: 'mapbox' | 'terrarium' } | null {
  for (const [id, src] of Object.entries(style.sources || {})) {
    const s = src as Record<string, unknown>;
    if (s.type === 'raster-dem') {
      const tiles = s.tiles as string[] | undefined;
      if (tiles?.length) {
        return {
          id,
          tileUrl: tiles[0],
          encoding: (s.encoding as 'mapbox' | 'terrarium') || 'mapbox',
        };
      }
    }
  }
  return null;
}

/** Build a match expression that maps municipality codi → Turbo colour. */
function buildChoroplethExpression(
  scores: Record<string, number>,
): maplibregl.ExpressionSpecification {
  const entries = Object.entries(scores);
  if (entries.length === 0) {
    return ['literal', 'rgba(200,200,200,0.3)'] as unknown as maplibregl.ExpressionSpecification;
  }
  const expr: unknown[] = ['match', ['get', 'codi']];
  for (const [codi, score] of entries) {
    expr.push(codi, scoreToCssColor(score, 0.70));
  }
  expr.push('rgba(200,200,200,0.3)');
  return expr as unknown as maplibregl.ExpressionSpecification;
}

/* ------------------------------------------------------------------ */
/*  Component                                                         */
/* ------------------------------------------------------------------ */

interface MapContainerProps {
  municipalities: MunicipalityCollection | null;
  scores: Record<string, number>;
  /** Data-URL of the canvas-rendered heatmap overlay. */
  heatmapDataUrl?: string | null;
  /**
   * Geographic bounds of the rendered heatmap image [west, south, east, north].
   * Must match the ViewportSpec used to generate heatmapDataUrl so the image
   * is placed at the correct position in the map.
   */
  heatmapBounds?: [number, number, number, number];
  /**
   * Called after moveend / zoomend with the new viewport bounds and zoom.
   * Used by App.tsx to schedule a re-render at the correct resolution.
   */
  onViewportChange?: (w: number, s: number, e: number, n: number, zoom: number) => void;
}

export default function MapContainer({
  municipalities,
  scores,
  heatmapDataUrl,
  heatmapBounds,
  onViewportChange,
}: MapContainerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const markerRef = useRef<maplibregl.Marker | null>(null);
  const hoverPopupRef = useRef<maplibregl.Popup | null>(null);
  const loadedRef = useRef(false);

  /* -- Store selectors -- */
  const selectMunicipality = useAppStore((s) => s.selectMunicipality);
  const analysisPoint = useAppStore((s) => s.analysisPoint);
  const setAnalysisPoint = useAppStore((s) => s.setAnalysisPoint);
  const pointAnalysisMode = useAppStore((s) => s.pointAnalysisMode);
  const view = useAppStore((s) => s.view);

  /* -- Mutable refs so event handlers see current values -- */
  const setPointRef = useRef(setAnalysisPoint);
  useEffect(() => { setPointRef.current = setAnalysisPoint; }, [setAnalysisPoint]);
  const scoresRef = useRef(scores);
  useEffect(() => { scoresRef.current = scores; }, [scores]);
  const viewRef = useRef<ViewSettings>(view);
  useEffect(() => { viewRef.current = view; }, [view]);
  const onViewportChangeRef = useRef(onViewportChange);
  useEffect(() => { onViewportChangeRef.current = onViewportChange; }, [onViewportChange]);
  const analysisPointRef = useRef(analysisPoint);
  useEffect(() => { analysisPointRef.current = analysisPoint; }, [analysisPoint]);
  const pointAnalysisModeRef = useRef(pointAnalysisMode);
  useEffect(() => { pointAnalysisModeRef.current = pointAnalysisMode; }, [pointAnalysisMode]);

  /* ---------------------------------------------------------------- */
  /*  Map initialisation (runs once)                                  */
  /* ---------------------------------------------------------------- */
  const initMap = useCallback(() => {
    if (!containerRef.current || mapRef.current) return;

    const map = new maplibregl.Map({
      container: containerRef.current,
      style: ICGC_BASEMAP,
      center: CATALONIA_CENTER,
      zoom: 8,
      pitch: 50,
      bearing: -5,
      maxBounds: [
        [CATALONIA_BOUNDS[0] - 1, CATALONIA_BOUNDS[1] - 1],
        [CATALONIA_BOUNDS[2] + 1, CATALONIA_BOUNDS[3] + 1],
      ],
      attributionControl: { compact: true },
    });

    map.addControl(
      new maplibregl.NavigationControl({ visualizePitch: true }),
      'top-right',
    );
    map.addControl(
      new maplibregl.ScaleControl({ maxWidth: 200 }),
      'bottom-right',
    );

    map.on('load', () => {
      loadedRef.current = true;
      const v = viewRef.current;
      const style = map.getStyle();
      const insertBefore = findFirstSymbolLayer(map);

      /* -- Discover DEM source from basemap style -- */
      const dem = findDemSource(style);
      const demId = dem?.id ?? 'terrainICGC';
      const hillshadeDemId = 'terrain-hillshade-dem';

      /* -- Remove any basemap hillshade layers that use the same DEM source
       *    as 3D terrain.  The ICGC style may ship with its own hillshade;
       *    we replace it with our own on a separate source.  Without this,
       *    MapLibre warns "same source for hillshade and 3D terrain". -- */
      for (const layer of (style.layers ?? [])) {
        if (layer.type === 'hillshade' && 'source' in layer && layer.source === demId) {
          try { map.removeLayer(layer.id); } catch { /* already removed */ }
        }
      }

      if (dem) {
        configureDemTiles(dem.tileUrl, dem.encoding);
        configureDemSlope(dem.tileUrl, dem.encoding);
        void loadDemSlope();
      }

      /* -- 1. Hypsometric elevation tint (custom protocol tiles) -- */
      if (dem) {
        map.addSource('elevation-tint', {
          type: 'raster',
          tiles: ['hypsometric://{z}/{x}/{y}'],
          tileSize: 256,
          minzoom: 7,
          maxzoom: 14,
        });
        map.addLayer(
          {
            id: 'elevation-tint',
            type: 'raster',
            source: 'elevation-tint',
            paint: {
              'raster-opacity': v.showElevationTint ? 0.50 : 0,
              'raster-fade-duration': 0,
            },
            layout: { visibility: v.showElevationTint ? 'visible' : 'none' },
          },
          insertBefore,
        );
      }

      /* -- 2. Hillshade (per-pixel normals from DEM) -- */
      if (dem && !map.getSource(hillshadeDemId)) {
        map.addSource(hillshadeDemId, {
          type: 'raster-dem',
          tiles: [dem.tileUrl],
          tileSize: 256,
          encoding: dem.encoding,
        });
      }
      if (map.getSource(hillshadeDemId)) {
        map.addLayer(
          {
            id: 'terrain-hillshade',
            type: 'hillshade',
            source: hillshadeDemId,
            paint: {
              'hillshade-illumination-direction': 335,
              'hillshade-exaggeration': 0.45,
              'hillshade-shadow-color': '#1a1a2e',
              'hillshade-highlight-color': '#fafafa',
              'hillshade-accent-color': '#2d2d44',
            },
            layout: { visibility: v.showHillshade ? 'visible' : 'none' },
          },
          insertBefore,
        );
      }

      /* -- 3. Continuous heatmap image overlay -- */
      map.addSource('heatmap', {
        type: 'image',
        url: EMPTY_PNG,
        coordinates: [
          [CATALONIA_BOUNDS[0], CATALONIA_BOUNDS[3]], // NW
          [CATALONIA_BOUNDS[2], CATALONIA_BOUNDS[3]], // NE
          [CATALONIA_BOUNDS[2], CATALONIA_BOUNDS[1]], // SE
          [CATALONIA_BOUNDS[0], CATALONIA_BOUNDS[1]], // SW
        ],
      });
      map.addLayer(
        {
          id: 'heatmap-overlay',
          type: 'raster',
          source: 'heatmap',
          paint: {
            'raster-opacity': v.showHeatmap ? v.heatmapOpacity : 0,
            'raster-fade-duration': 0,
          },
          layout: { visibility: v.showHeatmap ? 'visible' : 'none' },
        },
        insertBefore,
      );

      /* -- 4. Municipality vector layers -- */
      map.addSource('municipalities', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
      });

      // Choropleth fill (optional)
      map.addLayer(
        {
          id: 'municipalities-fill',
          type: 'fill',
          source: 'municipalities',
          paint: {
            'fill-color': 'rgba(200,200,200,0.3)',
            'fill-opacity': v.showChoropleth ? 0.6 : 0,
          },
          layout: { visibility: v.showChoropleth ? 'visible' : 'none' },
        },
        insertBefore,
      );

      // Border lines (toggleable)
      map.addLayer(
        {
          id: 'municipalities-line',
          type: 'line',
          source: 'municipalities',
          paint: {
            'line-color': 'rgba(80,80,80,0.45)',
            'line-width': 0.4,
          },
          layout: { visibility: v.showBorders ? 'visible' : 'none' },
        },
        insertBefore,
      );

      // Selection highlight
      map.addLayer(
        {
          id: 'municipalities-highlight',
          type: 'line',
          source: 'municipalities',
          paint: { 'line-color': '#ffffff', 'line-width': 2.5 },
          filter: ['==', 'codi', ''],
        },
        insertBefore,
      );

      /* -- 5. Enable 3D terrain mesh -- */
      if (v.show3dTerrain && map.getSource(demId)) {
        try {
          map.setTerrain({
            source: demId,
            exaggeration: v.terrainExaggeration,
          });
        } catch {
          /* terrain not supported on this device */
        }
      }

      /* -- Click / hover handlers -- */

      // Throttle hover updates to at most once per animation frame.
      let hoverRaf = 0;
      let hoverLat = 0;
      let hoverLon = 0;
      const flushHoverPoint = () => {
        hoverRaf = 0;
        setPointRef.current({ lat: hoverLat, lon: hoverLon });
      };

      map.on('click', (e) => {
        const features = map.queryRenderedFeatures(e.point, { layers: ['municipalities-fill'] });
        const feat = features[0];

        if (feat?.properties?.codi) {
          const codi = feat.properties.codi as string;
          selectMunicipality(codi);
          map.setFilter('municipalities-highlight', ['==', 'codi', codi]);
        } else {
          selectMunicipality(null);
          map.setFilter('municipalities-highlight', ['==', 'codi', '']);
        }

        // Always pin exact clicked coordinate for point analysis.
        setPointRef.current({ lat: e.lngLat.lat, lon: e.lngLat.lng });
        hoverPopupRef.current?.remove();
      });

      /* -- Hover score tooltip -- */
      const hoverPopup = new maplibregl.Popup({
        closeButton: false,
        closeOnClick: false,
        className: 'map-hover-popup',
        offset: [0, -10],
        maxWidth: '240px',
      });
      hoverPopupRef.current = hoverPopup;

      map.on('mousemove', (e) => {
        const modeOn = pointAnalysisModeRef.current;
        if (modeOn) {
          hoverPopup.remove();
          map.getCanvas().style.cursor = 'crosshair';
          hoverLat = e.lngLat.lat;
          hoverLon = e.lngLat.lng;
          if (!hoverRaf) {
            hoverRaf = requestAnimationFrame(flushHoverPoint);
          }
          return;
        }

        // Hide hover tooltip when a point is pinned
        if (analysisPointRef.current) return;

        const features = map.queryRenderedFeatures(e.point, { layers: ['municipalities-fill'] });
        const feat = features[0];
        if (!feat?.properties?.codi) {
          hoverPopup.remove();
          map.getCanvas().style.cursor = '';
          return;
        }

        const codi = feat.properties.codi as string;
        const nom = (feat.properties.nom as string) ?? '';
        const score = scoresRef.current[codi];
        const pct = score != null ? `${(score * 100).toFixed(0)}%` : '—';
        hoverPopup
          .setLngLat(e.lngLat)
          .setHTML(`<div class="map-hover-score"><strong>${nom}</strong> <span class="score-pct">${pct}</span></div>`)
          .addTo(map);
        map.getCanvas().style.cursor = 'pointer';
      });
      map.on('mouseleave', () => {
        if (hoverRaf) {
          cancelAnimationFrame(hoverRaf);
          hoverRaf = 0;
        }
        hoverPopup.remove();
        map.getCanvas().style.cursor = '';
      });
    });

    // Fire viewport change events so App.tsx can schedule zoomed-in re-renders
    const fireViewport = () => {
      const cb = onViewportChangeRef.current;
      if (!cb) return;
      const b = map.getBounds();
      cb(b.getWest(), b.getSouth(), b.getEast(), b.getNorth(), map.getZoom());
    };
    map.on('load',    fireViewport);
    map.on('moveend', fireViewport);
    map.on('zoomend', fireViewport);

    mapRef.current = map;

    /* -- Handle WebGL context loss/recovery -- */
    const canvas = map.getCanvas();
    canvas.addEventListener('webglcontextlost', (ev) => {
      ev.preventDefault();
      console.warn('[MapContainer] WebGL context lost — will wait for restore');
    });
    canvas.addEventListener('webglcontextrestored', () => {
      console.log('[MapContainer] WebGL context restored — triggering repaint');
      map.triggerRepaint();
    });
  }, [selectMunicipality]);

  /* -- Init / cleanup -- */
  useEffect(() => {
    initMap();
    return () => {
      mapRef.current?.remove();
      mapRef.current = null;
      loadedRef.current = false;
    };
  }, [initMap]);

  /* ---------------------------------------------------------------- */
  /*  Reactive effects                                                */
  /* ---------------------------------------------------------------- */

  /** Push municipality GeoJSON into the map source. */
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !municipalities) return;
    const run = () => {
      const src = map.getSource('municipalities') as maplibregl.GeoJSONSource | undefined;
      src?.setData(municipalities);
    };
    if (loadedRef.current) run();
    else map.on('load', run);
  }, [municipalities]);

  /** Update choropleth fill colours from new scores. */
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const run = () => {
      if (map.getLayer('municipalities-fill')) {
        map.setPaintProperty(
          'municipalities-fill',
          'fill-color',
          buildChoroplethExpression(scores),
        );
      }
    };
    if (loadedRef.current) run();
    else map.on('load', run);
  }, [scores]);

  /** Swap heatmap overlay image when a new data URL is supplied. */
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !heatmapDataUrl) return;

    // Use the bounds that match the rendered image, or fall back to Catalonia.
    const b = heatmapBounds ?? CATALONIA_BOUNDS;
    const coords: [[number,number],[number,number],[number,number],[number,number]] = [
      [b[0], b[3]], // NW
      [b[2], b[3]], // NE
      [b[2], b[1]], // SE
      [b[0], b[1]], // SW
    ];

    const run = () => {
      const src = map.getSource('heatmap') as maplibregl.ImageSource | undefined;
      if (!src) return;
      try {
        src.updateImage({ url: heatmapDataUrl, coordinates: coords });
      } catch {
        map.removeSource('heatmap');
        map.addSource('heatmap', { type: 'image', url: heatmapDataUrl, coordinates: coords });
      }
      if (map.getLayer('heatmap-overlay')) {
        map.setLayoutProperty('heatmap-overlay', 'visibility', 'visible');
      }
      map.triggerRepaint();
    };
    if (loadedRef.current) run();
    else map.on('load', run);
  }, [heatmapDataUrl, heatmapBounds]);

  /** Sync all view toggles / sliders with the map. */
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !loadedRef.current) return;

    const vis = (on: boolean) => (on ? 'visible' : 'none') as 'visible' | 'none';

    // Borders
    if (map.getLayer('municipalities-line'))
      map.setLayoutProperty('municipalities-line', 'visibility', vis(view.showBorders));

    // Choropleth — keep fill layer always visible for hover interaction
    if (map.getLayer('municipalities-fill')) {
      map.setPaintProperty('municipalities-fill', 'fill-opacity', view.showChoropleth ? 0.6 : 0);
    }

    // Hillshade
    if (map.getLayer('terrain-hillshade'))
      map.setLayoutProperty('terrain-hillshade', 'visibility', vis(view.showHillshade));

    // Elevation tint
    if (map.getLayer('elevation-tint'))
      map.setLayoutProperty('elevation-tint', 'visibility', vis(view.showElevationTint));

    // Heatmap
    if (map.getLayer('heatmap-overlay')) {
      map.setLayoutProperty('heatmap-overlay', 'visibility', vis(view.showHeatmap));
      map.setPaintProperty(
        'heatmap-overlay',
        'raster-opacity',
        view.showHeatmap ? view.heatmapOpacity : 0,
      );
    }

    // 3D terrain
    const demId = findDemSource(map.getStyle())?.id ?? 'terrainICGC';
    if (view.show3dTerrain && map.getSource(demId)) {
      try {
        map.setTerrain({ source: demId, exaggeration: view.terrainExaggeration });
      } catch { /* */ }
    } else {
      try { map.setTerrain(undefined as unknown as null); } catch { /* */ }
    }
  }, [view]);

  /** Hide hover tooltip when analysis point is pinned. */
  useEffect(() => {
    if (analysisPoint) {
      hoverPopupRef.current?.remove();
    }
  }, [analysisPoint]);

  /** In point-analysis mode, keep crosshair cursor by default. */
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !loadedRef.current) return;
    if (pointAnalysisMode) {
      map.getCanvas().style.cursor = 'crosshair';
    }
  }, [pointAnalysisMode]);

  /** Pink marker at the analysis point. */
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (analysisPoint) {
      if (!markerRef.current) {
        markerRef.current = new maplibregl.Marker({ color: '#e91e63' })
          .setLngLat([analysisPoint.lon, analysisPoint.lat])
          .addTo(map);
      } else {
        markerRef.current.setLngLat([analysisPoint.lon, analysisPoint.lat]);
      }
    } else {
      markerRef.current?.remove();
      markerRef.current = null;
    }
  }, [analysisPoint]);

  /* ---------------------------------------------------------------- */
  return (
    <div
      ref={containerRef}
      data-testid="map-container"
      style={{ width: '100%', height: '100%', position: 'absolute', top: 0, left: 0 }}
    />
  );
}
