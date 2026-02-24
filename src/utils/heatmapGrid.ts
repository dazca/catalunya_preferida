/**
 * @file Heatmap grid renderer — generates a continuous raster score overlay.
 *
 * Supports viewport-aware rendering: when zoomed in, the caller supplies a
 * ViewportSpec with the visible bounds and a target resolution so the image
 * covers only on-screen area at higher pixel density.
 *
 * Performance:
 *   - Bbox spatial index reduces PiP tests per cell from ~947 to ~1-3.
 *   - Membership grid capped at 256×192 (16× fewer PiP calls than score grid).
 *   - Membership grid is cached by viewport-key; rebuilds only on pan/zoom.
 *   - Non-terrain scores pre-computed once per municipality.
 *   - sampleDemViewport() batches all DEM lookups: Mercator Y computed per
 *     row (~1 K ops) instead of per pixel (~1 M ops); numeric Map keys
 *     eliminate string allocations; intra-tile Horn kernel uses direct array
 *     arithmetic for 97 %+ of pixels.
 */
import type { MunicipalityCollection } from '../types';
import type { LayerMeta } from '../types';
import type { LayerConfigs } from '../types/transferFunction';
import type { MunicipalityData } from './scorer';
import { computeNonTerrainCached, evaluateTerrainPixel } from './scorer';
import type { NonTerrainCached } from './scorer';
import { scoreToRgba } from './turboColormap';
import { pointInPolygon } from './spatial';
import { sampleDemViewport, isDemLoaded, DEM_ASPECT_LABELS } from './demSlope';
import type { DemViewportSamples } from './demSlope';

/* ------------------------------------------------------------------ */
/*  ViewportSpec                                                      */
/* ------------------------------------------------------------------ */

/**
 * Describes the geographic window and pixel dimensions for one heatmap render.
 * Pass a custom spec to render at higher resolution for a zoomed-in viewport.
 */
export interface ViewportSpec {
  /** West longitude of the rendered area. */
  w: number;
  /** South latitude of the rendered area. */
  s: number;
  /** East longitude of the rendered area. */
  e: number;
  /** North latitude of the rendered area. */
  n: number;
  /** Number of pixel columns in the output image. */
  cols: number;
  /** Number of pixel rows in the output image. */
  rows: number;
}

/** Full Catalonia at overview resolution — used as default. */
export const CATALONIA_VIEWPORT: ViewportSpec = {
  w: 0.16, s: 40.52, e: 3.33, n: 42.86,
  cols: 412, rows: 308,
};

/**
 * Membership grid (PiP polygon assignments) is capped at this size to limit
 * polygon-containment work.  Score pixels use the full spec resolution and
 * map to the nearest membership cell via integer divide.
 */
const MEMBER_MAX_COLS = 256;
const MEMBER_MAX_ROWS = 192;

/**
 * Compute an appropriate ViewportSpec for a given geographic viewport and
 * MapLibre zoom level.  Targets pixel size ≈ max(5, 4000 / 2^(zoom-8)) metres,
 * capped at 1024×1024 pixels.
 *
 * @param vw - Viewport west longitude
 * @param vs - Viewport south latitude
 * @param ve - Viewport east longitude
 * @param vn - Viewport north latitude
 * @param zoom - Current MapLibre zoom level
 */
export function viewportSpecForZoom(
  vw: number, vs: number, ve: number, vn: number,
  zoom: number,
): ViewportSpec {
  // Clamp to Catalonia to avoid rendering ocean / France
  const w = Math.max(vw, CATALONIA_VIEWPORT.w);
  const s = Math.max(vs, CATALONIA_VIEWPORT.s);
  const e = Math.min(ve, CATALONIA_VIEWPORT.e);
  const n = Math.min(vn, CATALONIA_VIEWPORT.n);

  if (w >= e || s >= n) return CATALONIA_VIEWPORT;

  const latMid = (s + n) / 2;
  const mPerDegLon = 111_320 * Math.cos(latMid * (Math.PI / 180));
  const mPerDegLat = 110_540;

  // Target metres per heatmap pixel — halves each zoom step
  const targetM = Math.max(5, Math.min(800, Math.round(4_000 / Math.pow(2, zoom - 8))));

  const MAX = 1024;
  const MIN_COLS = 100;
  const MIN_ROWS = 75;

  const cols = Math.min(MAX, Math.max(MIN_COLS, Math.ceil((e - w) * mPerDegLon / targetM)));
  const rows = Math.min(MAX, Math.max(MIN_ROWS, Math.ceil((n - s) * mPerDegLat / targetM)));

  return { w, s, e, n, cols, rows };
}

/* ------------------------------------------------------------------ */
/*  Bounding-box spatial index                                        */
/* ------------------------------------------------------------------ */

interface Bbox {
  minLon: number;
  maxLon: number;
  minLat: number;
  maxLat: number;
}

/** Compute the bounding box of a Polygon or MultiPolygon geometry. */
function geometryBbox(geom: GeoJSON.Polygon | GeoJSON.MultiPolygon): Bbox {
  let minLon = Infinity, maxLon = -Infinity;
  let minLat = Infinity, maxLat = -Infinity;

  const rings =
    geom.type === 'Polygon'
      ? geom.coordinates
      : geom.coordinates.flat();

  for (const ring of rings) {
    for (const [lon, lat] of ring) {
      if (lon < minLon) minLon = lon;
      if (lon > maxLon) maxLon = lon;
      if (lat < minLat) minLat = lat;
      if (lat > maxLat) maxLat = lat;
    }
  }
  return { minLon, maxLon, minLat, maxLat };
}

/* ------------------------------------------------------------------ */
/*  Membership grid (viewport-keyed cache)                           */
/* ------------------------------------------------------------------ */

/**
 * Membership grid cache — keyed by `"w,s,e,n,cols,rows,featureCount"`.
 * Rebuilds automatically when the viewport or municipality set changes,
 * but is reused for score/layer changes within the same view.
 */
let _cacheKey = '';
let _cachedGrid: Int16Array | null = null;
let _bboxCache: Bbox[] | null = null;
let _bboxFeatureCount = -1;

/**
 * Build or retrieve the viewport-specific membership grid.
 * Each cell maps to a GeoJSON feature index, or -1 if outside all municipalities.
 */
function getMembershipGrid(
  spec: ViewportSpec,
  municipalities: MunicipalityCollection,
): Int16Array {
  const features = municipalities.features;
  const key = `${spec.w},${spec.s},${spec.e},${spec.n},${spec.cols},${spec.rows},${features.length}`;

  if (_cacheKey === key && _cachedGrid) return _cachedGrid;

  // Pre-compute (or reuse) per-feature bounding boxes
  if (_bboxFeatureCount !== features.length || !_bboxCache) {
    _bboxCache = features.map((f) => geometryBbox(f.geometry));
    _bboxFeatureCount = features.length;
  }
  const bboxes = _bboxCache;

  const { w, s, e, n, cols, rows } = spec;
  const grid = new Int16Array(cols * rows).fill(-1);
  const dx = (e - w) / cols;
  const dy = (n - s) / rows;

  for (let row = 0; row < rows; row++) {
    const lat = n - (row + 0.5) * dy;
    for (let col = 0; col < cols; col++) {
      const lon = w + (col + 0.5) * dx;
      const idx = row * cols + col;

      for (let fi = 0; fi < features.length; fi++) {
        const bb = bboxes[fi];
        if (lon < bb.minLon || lon > bb.maxLon || lat < bb.minLat || lat > bb.maxLat) continue;
        if (pointInPolygon(lon, lat, features[fi].geometry)) {
          grid[idx] = fi;
          break;
        }
      }
    }
  }

  _cacheKey = key;
  _cachedGrid = grid;
  return grid;
}

/** Invalidate the membership cache (e.g. when municipalities are reloaded). */
export function invalidateMembershipCache(): void {
  _cacheKey = '';
  _cachedGrid = null;
}

/* ------------------------------------------------------------------ */
/*  Public API                                                        */
/* ------------------------------------------------------------------ */

/**
 * Render the heatmap image overlay as a PNG data-URL.
 *
 * When DEM slope data is loaded, each pixel gets its own real terrain score
 * (slope + elevation from the DEM); otherwise the pre-computed per-municipality
 * composite score is used as a uniform fill.
 *
 * @param municipalities    GeoJSON FeatureCollection
 * @param scores            Pre-computed composite scores keyed by codi
 * @param municipalityData  Full data tables (used for non-terrain layers)
 * @param layers            Layer metadata with weights
 * @param configs           Transfer function configs
 * @param spec              Viewport bounds + pixel dimensions (defaults to
 *                          full Catalonia overview)
 */
export function renderHeatmapImage(
  municipalities: MunicipalityCollection,
  scores: Record<string, number>,
  municipalityData: MunicipalityData,
  layers: LayerMeta[],
  configs: LayerConfigs,
  spec: ViewportSpec = CATALONIA_VIEWPORT,
): string | null {
  if (!municipalities || municipalities.features.length === 0) return null;
  if (Object.keys(scores).length === 0) return null;

  const { w, s, e, n, cols, rows } = spec;
  const features = municipalities.features;
  const enabledLayers = layers.filter((l) => l.enabled);
  const terrainLayer = enabledLayers.find((l) => l.id === 'terrain');
  const useDem = isDemLoaded() && !!terrainLayer;

  // ── Per-municipality fallback scores ───────────────────────────────
  const featureScores = new Float32Array(features.length).fill(-1);
  for (let i = 0; i < features.length; i++) {
    const codi = features[i].properties?.codi;
    if (codi && scores[codi] !== undefined) featureScores[i] = scores[codi];
  }

  // ── Pre-compute non-terrain composite once per feature ─────────────
  let nonTerrainByFeature: NonTerrainCached[] | null = null;
  if (useDem) {
    nonTerrainByFeature = features.map((f) =>
      computeNonTerrainCached(
        f.properties?.codi ?? '',
        enabledLayers,
        configs,
        municipalityData,
      ),
    );
  }

  // ── Membership grid capped at MEMBER_MAX_COLS × MEMBER_MAX_ROWS ─────
  // PiP work is proportional to member grid size, not score grid size.
  const mCols = Math.min(cols, MEMBER_MAX_COLS);
  const mRows = Math.min(rows, MEMBER_MAX_ROWS);
  const memberSpec: ViewportSpec = { ...spec, cols: mCols, rows: mRows };
  const grid = getMembershipGrid(memberSpec, municipalities);

  // ── Batch DEM sampling: one Mercator trig call per row, not per pixel
  const demSamples: DemViewportSamples | null = useDem
    ? sampleDemViewport(w, s, e, n, cols, rows)
    : null;

  // ── Collect per-cell scores ────────────────────────────────────────
  const cellScores = new Float32Array(cols * rows).fill(-1);

  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const idx = row * cols + col;

      // Map score pixel → membership pixel (integer divide)
      const mIdx = Math.floor(row * mRows / rows) * mCols + Math.floor(col * mCols / cols);
      const fi = grid[mIdx];
      if (fi < 0 || featureScores[fi] < 0) continue;

      if (demSamples && nonTerrainByFeature && demSamples.hasData[idx]) {
        const t  = evaluateTerrainPixel(
          demSamples.slopes[idx],
          demSamples.elevations[idx],
          DEM_ASPECT_LABELS[demSamples.aspects[idx]],
          terrainLayer!.weight,
          configs,
        );
        const nt = nonTerrainByFeature[fi];
        const totalWeighted = nt.weightedSum + t.contrib;
        const totalWeight   = nt.totalWeight  + t.weight;
        const disqualified  = nt.disqualified  || t.disqualified;
        cellScores[idx] = disqualified
          ? 0
          : totalWeight > 0 ? totalWeighted / totalWeight : 0;
      } else {
        cellScores[idx] = featureScores[fi];
      }
    }
  }

  // ── Normalise to local min/max for maximum colour contrast ─────────
  let minScore = Infinity;
  let maxScore = -Infinity;
  for (let i = 0; i < cellScores.length; i++) {
    const v = cellScores[i];
    if (v < 0) continue;
    if (v < minScore) minScore = v;
    if (v > maxScore) maxScore = v;
  }
  const span = Math.max(0.0001, maxScore - minScore);

  // ── Paint pixels ───────────────────────────────────────────────────
  const canvas = document.createElement('canvas');
  canvas.width  = cols;
  canvas.height = rows;
  const ctx       = canvas.getContext('2d')!;
  const imageData = ctx.createImageData(cols, rows);
  const pixels    = imageData.data;

  for (let i = 0; i < grid.length; i++) {
    const off = i * 4;
    const raw = cellScores[i];

    if (raw < 0) {
      pixels[off + 3] = 0;
      continue;
    }

    const normalized = span < 0.02 ? 0.5 : (raw - minScore) / span;
    const [r, g, b, a] = scoreToRgba(normalized, 210);
    pixels[off]     = r;
    pixels[off + 1] = g;
    pixels[off + 2] = b;
    pixels[off + 3] = a;
  }

  ctx.putImageData(imageData, 0, 0);
  // WebP encodes 5–10× faster than PNG and produces smaller payloads.
  // Falls back gracefully: if the browser returns 'image/png' the data is still valid.
  return canvas.toDataURL('image/webp', 0.85);
}

