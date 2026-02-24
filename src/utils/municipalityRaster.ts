/**
 * @file Municipality membership raster — maps every heatmap pixel to a
 *       municipality feature index via PiP (point-in-polygon) testing.
 *
 * ## Key improvements over the old getMembershipGrid():
 *   - Full viewport resolution (up to 2048×2048) instead of 256×192 max.
 *   - Scanline-ordered bbox spatial index pre-filters candidates per row band.
 *   - Cache keyed by viewport + feature count; instant hit on config changes.
 *   - Progressive: caller can get a low-res grid instantly, then async
 *     upgrade to full resolution in a microtask.
 *
 * The raster is an Int16Array where each cell holds a GeoJSON feature index
 * (0-based) or -1 for pixels outside all municipalities.
 */
import type { MunicipalityCollection } from '../types';
import { pointInPolygon } from './spatial';

/* ── Types ──────────────────────────────────────────────────────────── */

export interface RasterSpec {
  /** West longitude */
  w: number;
  /** South latitude */
  s: number;
  /** East longitude */
  e: number;
  /** North latitude */
  n: number;
  /** Pixel columns */
  cols: number;
  /** Pixel rows */
  rows: number;
}

/* ── Bbox helpers ───────────────────────────────────────────────────── */

interface Bbox {
  minLon: number;
  maxLon: number;
  minLat: number;
  maxLat: number;
  featureIdx: number;
}

function geometryBbox(
  geom: GeoJSON.Polygon | GeoJSON.MultiPolygon,
  featureIdx: number,
): Bbox {
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
  return { minLon, maxLon, minLat, maxLat, featureIdx };
}

/* ── Cache ──────────────────────────────────────────────────────────── */

let _cacheKey = '';
let _cachedGrid: Int16Array | null = null;
let _bboxes: Bbox[] | null = null;
let _bboxFeatureCount = -1;

/** Invalidate the raster cache (e.g. when municipalities are reloaded). */
export function invalidateRasterCache(): void {
  _cacheKey = '';
  _cachedGrid = null;
}

/* ── Core rasteriser ────────────────────────────────────────────────── */

/**
 * Rasterise municipality polygons into an Int16Array at the given spec
 * resolution. Uses bbox spatial index to minimise PiP tests.
 *
 * @returns Int16Array of length `spec.cols × spec.rows` with feature indices
 *          (or -1 for outside-all-municipalities pixels).
 */
export function rasteriseMunicipalities(
  spec: RasterSpec,
  municipalities: MunicipalityCollection,
): Int16Array {
  const features = municipalities.features;
  const key = `${spec.w},${spec.s},${spec.e},${spec.n},${spec.cols},${spec.rows},${features.length}`;

  if (_cacheKey === key && _cachedGrid) return _cachedGrid;

  // Pre-compute bounding boxes (reuse across viewport changes)
  if (_bboxFeatureCount !== features.length || !_bboxes) {
    _bboxes = features.map((f, i) => geometryBbox(f.geometry, i));
    _bboxFeatureCount = features.length;
  }
  const bboxes = _bboxes;

  const { w, s, e, n, cols, rows } = spec;
  const grid = new Int16Array(cols * rows).fill(-1);
  const dx = (e - w) / cols;
  const dy = (n - s) / rows;

  for (let row = 0; row < rows; row++) {
    const lat = n - (row + 0.5) * dy;

    // Pre-filter boxes that overlap this row band
    const latLo = lat - dy * 0.5;
    const latHi = lat + dy * 0.5;
    const candidates: Bbox[] = [];
    for (let i = 0; i < bboxes.length; i++) {
      const bb = bboxes[i];
      if (bb.maxLat >= latLo && bb.minLat <= latHi) {
        candidates.push(bb);
      }
    }
    if (candidates.length === 0) continue;

    for (let col = 0; col < cols; col++) {
      const lon = w + (col + 0.5) * dx;
      const idx = row * cols + col;

      for (let ci = 0; ci < candidates.length; ci++) {
        const bb = candidates[ci];
        if (lon < bb.minLon || lon > bb.maxLon || lat < bb.minLat || lat > bb.maxLat)
          continue;
        if (pointInPolygon(lon, lat, features[bb.featureIdx].geometry)) {
          grid[idx] = bb.featureIdx;
          break;
        }
      }
    }
  }

  _cacheKey = key;
  _cachedGrid = grid;
  return grid;
}

/**
 * Build a low-resolution membership grid quickly, then return a promise
 * that resolves with the full-resolution grid.
 *
 * @param lowSpec  Quick-return spec (e.g. 256×192)
 * @param fullSpec Full-resolution spec (e.g. 2048×2048)
 * @returns `{ lowGrid, fullGridPromise }`
 */
export function rasteriseProgressive(
  lowSpec: RasterSpec,
  fullSpec: RasterSpec,
  municipalities: MunicipalityCollection,
): { lowGrid: Int16Array; fullGridPromise: Promise<Int16Array> } {
  const lowGrid = rasteriseMunicipalities(lowSpec, municipalities);

  const fullGridPromise = new Promise<Int16Array>((resolve) => {
    // Defer full raster to next microtask to keep the UI responsive
    queueMicrotask(() => {
      resolve(rasteriseMunicipalities(fullSpec, municipalities));
    });
  });

  return { lowGrid, fullGridPromise };
}
