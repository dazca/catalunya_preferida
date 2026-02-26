/**
 * @file Top-view MapLibre map for the admin integrity tab.
 * Colours municipalities by data-presence per layer: green = data, red = missing,
 * orange = has warnings. Shows point-based layers as circles.
 */
import { useEffect, useRef, useState, useMemo } from 'react';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import type { IntegrityReport, IntegrityLayer } from '../../utils/dataIntegrity';
import type { MunicipalityCollection, FacilityCollection, TransitStopCollection } from '../../types';

/** Catalonia approximate bounding box. */
const CAT_BOUNDS: [number, number, number, number] = [0.15, 40.52, 3.33, 42.86];

const BASEMAP_STYLE: maplibregl.StyleSpecification = {
  version: 8,
  sources: {
    osm: {
      type: 'raster',
      tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
      tileSize: 256,
      attribution: '© OpenStreetMap contributors',
    },
  },
  layers: [{ id: 'osm', type: 'raster', source: 'osm' }],
};

/** Colours for municipality fill. */
const COL_OK = '#00b894';
const COL_WARN = '#fdcb6e';
const COL_ERR = '#d63031';
const COL_MISSING = '#d63031';
const COL_NODATA = '#2d3440';

/** Point-based integrity layers. */
const POINT_LAYERS: IntegrityLayer[] = ['transit', 'healthcare', 'schools', 'amenities'];

/** Municipality-based layers (layer ID → data key). */
const MUNICIPALITY_LAYERS: IntegrityLayer[] = [
  'votes', 'terrain', 'forest', 'crime', 'rentalPrices', 'employment', 'internet', 'airQuality', 'climate',
];

interface Props {
  municipalities: MunicipalityCollection | null;
  /** Municipality codes that have data for the selected layer. */
  dataCodesByLayer: Record<string, Set<string> | string[]>;
  /** Point feature collections keyed by layer. */
  pointCollections: Record<string, TransitStopCollection | FacilityCollection | null>;
  report: IntegrityReport | null;
  selectedLayer: IntegrityLayer;
  onSelectLayer: (layer: IntegrityLayer) => void;
  /** Optional: callback when a municipality is clicked. */
  onClickMunicipality?: (codi: string, nom: string) => void;
}

/**
 * Derives per-municipality status for a given layer from the integrity report.
 * Returns a map: codi → 'ok' | 'warning' | 'error' | 'missing'.
 */
function deriveStatus(
  allCodes: Set<string>,
  dataCodes: Set<string>,
  report: IntegrityReport | null,
  layer: IntegrityLayer,
): Map<string, 'ok' | 'warning' | 'error' | 'missing'> {
  const status = new Map<string, 'ok' | 'warning' | 'error' | 'missing'>();

  // Start with presence / absence
  for (const code of allCodes) {
    status.set(code, dataCodes.has(code) ? 'ok' : 'missing');
  }

  // Overlay issues from the report
  if (report) {
    const layerReport = report.layers.find((l) => l.layer === layer);
    if (layerReport) {
      for (const issue of layerReport.issues) {
        for (const sample of issue.sampleCodes) {
          const code = sample.substring(0, 5); // normalise
          if (!allCodes.has(code)) continue;
          const current = status.get(code);
          if (issue.severity === 'error' && current !== 'missing') {
            status.set(code, 'error');
          } else if (issue.severity === 'warning' && current === 'ok') {
            status.set(code, 'warning');
          }
        }
      }
    }
  }

  return status;
}

function statusColor(s: string): string {
  switch (s) {
    case 'ok': return COL_OK;
    case 'warning': return COL_WARN;
    case 'error': return COL_ERR;
    case 'missing': return COL_MISSING;
    default: return COL_NODATA;
  }
}

export default function IntegrityMap({
  municipalities,
  dataCodesByLayer,
  pointCollections,
  report,
  selectedLayer,
  onSelectLayer,
  onClickMunicipality,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const [hoveredMuni, setHoveredMuni] = useState<{ codi: string; nom: string; status: string } | null>(null);

  const allCodes = useMemo(() => {
    if (!municipalities) return new Set<string>();
    const codes = new Set<string>();
    for (const f of municipalities.features) {
      const c = f.properties?.codi;
      if (typeof c === 'string' && c.length >= 5) codes.add(c.substring(0, 5));
    }
    return codes;
  }, [municipalities]);

  const dataCodes = useMemo(() => {
    const raw = dataCodesByLayer[selectedLayer];
    if (!raw) return new Set<string>();
    if (raw instanceof Set) return raw as Set<string>;
    if (Array.isArray(raw)) return new Set<string>(raw);
    return new Set<string>(Object.keys(raw));
  }, [dataCodesByLayer, selectedLayer]);
  const statusMap = useMemo(() => deriveStatus(allCodes, dataCodes, report, selectedLayer), [allCodes, dataCodes, report, selectedLayer]);

  // Build municipality GeoJSON with status colour
  const coloredGeo = useMemo(() => {
    if (!municipalities) return null;
    return {
      ...municipalities,
      features: municipalities.features.map((f) => {
        const codi = f.properties?.codi?.substring(0, 5) ?? '';
        const s = statusMap.get(codi) ?? 'missing';
        return {
          ...f,
          properties: {
            ...f.properties,
            _intStatus: s,
            _intColor: statusColor(s),
          },
        };
      }),
    };
  }, [municipalities, statusMap]);

  // Build point GeoJSON for point layers
  const pointGeo = useMemo(() => {
    if (!POINT_LAYERS.includes(selectedLayer)) return null;
    const fc = pointCollections[selectedLayer];
    if (!fc) return null;
    return fc;
  }, [selectedLayer, pointCollections]);

  // Compute stats
  const stats = useMemo(() => {
    let ok = 0, warn = 0, err = 0, missing = 0;
    for (const s of statusMap.values()) {
      if (s === 'ok') ok++;
      else if (s === 'warning') warn++;
      else if (s === 'error') err++;
      else missing++;
    }
    return { ok, warn, err, missing, total: allCodes.size };
  }, [statusMap, allCodes]);

  // Initialise map
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    const map = new maplibregl.Map({
      container: containerRef.current,
      style: BASEMAP_STYLE,
      bounds: CAT_BOUNDS as [number, number, number, number],
      fitBoundsOptions: { padding: 20 },
      attributionControl: false,
      interactive: true,
      pitch: 0,
      bearing: 0,
    });
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
    mapRef.current = map;

    return () => {
      map.remove();
      mapRef.current = null;
    };
  }, []);

  // Update sources when data changes
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !coloredGeo) return;

    const applyLayers = () => {
      // Municipality fill
      if (map.getSource('int-munis')) {
        (map.getSource('int-munis') as maplibregl.GeoJSONSource).setData(coloredGeo as GeoJSON.GeoJSON);
      } else {
        map.addSource('int-munis', { type: 'geojson', data: coloredGeo as GeoJSON.GeoJSON });
        map.addLayer({
          id: 'int-fill',
          type: 'fill',
          source: 'int-munis',
          paint: {
            'fill-color': ['get', '_intColor'],
            'fill-opacity': 0.55,
            'fill-antialias': false,
          },
        });
        map.addLayer({
          id: 'int-border',
          type: 'line',
          source: 'int-munis',
          paint: {
            'line-color': '#2d3440',
            'line-width': 0.5,
          },
        });
        map.addLayer({
          id: 'int-highlight',
          type: 'line',
          source: 'int-munis',
          paint: {
            'line-color': '#fff',
            'line-width': 2,
          },
          filter: ['==', 'codi', ''],
        });
      }

      // Point layer
      if (map.getSource('int-points')) {
        if (pointGeo) {
          (map.getSource('int-points') as maplibregl.GeoJSONSource).setData(pointGeo as GeoJSON.GeoJSON);
        } else {
          (map.getSource('int-points') as maplibregl.GeoJSONSource).setData({ type: 'FeatureCollection', features: [] });
        }
      } else {
        map.addSource('int-points', {
          type: 'geojson',
          data: pointGeo ? (pointGeo as GeoJSON.GeoJSON) : { type: 'FeatureCollection', features: [] },
        });
        map.addLayer({
          id: 'int-pts',
          type: 'circle',
          source: 'int-points',
          paint: {
            'circle-radius': 3,
            'circle-color': '#6c5ce7',
            'circle-stroke-color': '#fff',
            'circle-stroke-width': 0.5,
            'circle-opacity': 0.8,
          },
        });
      }
    };

    if (map.loaded()) {
      applyLayers();
    } else {
      map.once('load', applyLayers);
    }
  }, [coloredGeo, pointGeo]);

  // Hover and click interaction
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    const onMouseMove = (e: maplibregl.MapMouseEvent) => {
      if (!map.getLayer('int-fill')) return;
      const features = map.queryRenderedFeatures(e.point, { layers: ['int-fill'] });
      if (features.length > 0) {
        const f = features[0];
        const codi = (f.properties?.codi as string)?.substring(0, 5) ?? '';
        const nom = (f.properties?.nom as string) ?? '';
        const status = (f.properties?._intStatus as string) ?? 'missing';
        setHoveredMuni({ codi, nom, status });
        map.setFilter('int-highlight', ['==', 'codi', f.properties?.codi ?? '']);
        map.getCanvas().style.cursor = 'pointer';
      } else {
        setHoveredMuni(null);
        if (map.getLayer('int-highlight')) map.setFilter('int-highlight', ['==', 'codi', '']);
        map.getCanvas().style.cursor = '';
      }
    };

    const onClick = (e: maplibregl.MapMouseEvent) => {
      if (!map.getLayer('int-fill')) return;
      const features = map.queryRenderedFeatures(e.point, { layers: ['int-fill'] });
      if (features.length > 0 && onClickMunicipality) {
        const f = features[0];
        const codi = (f.properties?.codi as string)?.substring(0, 5) ?? '';
        const nom = (f.properties?.nom as string) ?? '';
        onClickMunicipality(codi, nom);
      }
    };

    map.on('mousemove', onMouseMove);
    map.on('click', onClick);
    return () => {
      map.off('mousemove', onMouseMove);
      map.off('click', onClick);
    };
  }, [onClickMunicipality]);

  const isPointLayer = POINT_LAYERS.includes(selectedLayer);

  return (
    <div className="adm-di-card adm-di-card-wide" style={{ position: 'relative' }}>
      <h4>Spatial Gap Map</h4>

      {/* Layer selector */}
      <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginBottom: 8 }}>
        {[...MUNICIPALITY_LAYERS, ...POINT_LAYERS].map((layer) => (
          <button
            key={layer}
            className={`adm-di-pill ${selectedLayer === layer ? 'active' : ''}`}
            onClick={() => onSelectLayer(layer)}
          >
            {layer}
          </button>
        ))}
      </div>

      {/* Stats bar */}
      <div style={{ display: 'flex', gap: 12, fontSize: '0.78em', marginBottom: 6, color: '#aab1c7' }}>
        <span style={{ color: COL_OK }}>OK: {stats.ok}</span>
        <span style={{ color: COL_WARN }}>Warn: {stats.warn}</span>
        <span style={{ color: COL_ERR }}>Err/Missing: {stats.err + stats.missing}</span>
        <span>Total: {stats.total}</span>
        {isPointLayer && pointGeo && (
          <span style={{ color: '#6c5ce7' }}>Points: {pointGeo.features.length}</span>
        )}
      </div>

      {/* Map */}
      <div
        ref={containerRef}
        style={{ width: '100%', height: 420, borderRadius: 6, border: '1px solid #2d3440', position: 'relative' }}
      />

      {/* Hover tooltip */}
      {hoveredMuni && (
        <div
          style={{
            position: 'absolute',
            bottom: 16,
            left: 16,
            background: 'rgba(15,17,21,0.92)',
            border: '1px solid #2d3440',
            borderRadius: 6,
            padding: '6px 10px',
            fontSize: '0.78em',
            pointerEvents: 'none',
            zIndex: 10,
          }}
        >
          <strong>{hoveredMuni.nom}</strong> ({hoveredMuni.codi})<br />
          Status:{' '}
          <span style={{ color: statusColor(hoveredMuni.status), fontWeight: 600 }}>
            {hoveredMuni.status.toUpperCase()}
          </span>
        </div>
      )}

      {/* Legend */}
      <div style={{ display: 'flex', gap: 12, marginTop: 6, fontSize: '0.72em', color: '#8d95ad' }}>
        <span><span style={{ color: COL_OK }}>■</span> Has data</span>
        <span><span style={{ color: COL_WARN }}>■</span> Warnings</span>
        <span><span style={{ color: COL_ERR }}>■</span> Errors/Missing</span>
        {isPointLayer && <span><span style={{ color: '#6c5ce7' }}>●</span> Data points</span>}
      </div>
    </div>
  );
}
