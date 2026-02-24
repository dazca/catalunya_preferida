/**
 * @file Heatmap bridge — main-thread orchestrator for the grid-based
 *       heatmap pipeline.  Manages the Web Worker, builds grid requests,
 *       and provides an async rendering API.
 *
 * ## Usage
 *
 *   import { requestHeatmapRender } from './heatmapBridge';
 *
 *   const result = await requestHeatmapRender({
 *     municipalities, municipalityData, layers, configs,
 *     spec, demSamples, disqualifiedMask,
 *   });
 *   // result.dataUrl is the WebP data URL for the heatmap overlay
 *
 * ## Fallback
 *
 * If the Web Worker fails to initialise (e.g. CSP restrictions), the bridge
 * falls back to running the grid pipeline synchronously on the main thread.
 */
import type { MunicipalityCollection } from '../types';
import type { LayerMeta } from '../types';
import type { LayerConfigs } from '../types/transferFunction';
import type { MunicipalityData } from './scorer';
import type { DemViewportSamples } from './demSlope';
import type { RasterSpec } from './municipalityRaster';
import { rasteriseMunicipalities, invalidateRasterCache } from './municipalityRaster';
import { buildMunicipalityLUT, buildAllVariableGrids } from './variableGrids';
import type { MunicipalityLUT } from './variableGrids';
import { computeVisualScoreGrid, scoreGridToRGBA } from './gridFormulaEngine';
import type { HeatmapWorkerRequest, HeatmapWorkerResponse } from '../workers/heatmapWorker';

/* ── Types ──────────────────────────────────────────────────────────── */

export interface HeatmapRenderRequest {
  municipalities: MunicipalityCollection;
  municipalityData: MunicipalityData;
  layers: LayerMeta[];
  configs: LayerConfigs;
  spec: RasterSpec;
  demSamples: DemViewportSamples | null;
  disqualifiedMask: 'black' | 'transparent';
}

export interface HeatmapRenderResult {
  dataUrl: string;
  bounds: [number, number, number, number];
  minScore: number;
  maxScore: number;
  renderTimeMs: number;
}

/* ── Blob URL lifecycle ─────────────────────────────────────────────── */

let _lastBlobUrl: string | null = null;

/** Revoke previous blob URL to avoid memory leaks. */
function revokeOldBlobUrl(): void {
  if (_lastBlobUrl) {
    URL.revokeObjectURL(_lastBlobUrl);
    _lastBlobUrl = null;
  }
}

/** Convert RGBA pixel array to an async blob URL (faster than toDataURL). */
async function pixelsToBlobUrl(
  pixels: Uint8ClampedArray, cols: number, rows: number,
): Promise<string> {
  const canvas = document.createElement('canvas');
  canvas.width = cols;
  canvas.height = rows;
  const ctx = canvas.getContext('2d')!;
  ctx.putImageData(new ImageData(new Uint8ClampedArray(pixels.buffer as ArrayBuffer, pixels.byteOffset, pixels.length), cols, rows), 0, 0);

  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error('toBlob returned null'))),
      'image/webp',
      0.65,
    );
  });

  revokeOldBlobUrl();
  const url = URL.createObjectURL(blob);
  _lastBlobUrl = url;
  return url;
}

/* ── Variable grid cache ──────────────────────────────────────────── */

let _gridCache: {
  specKey: string;
  lutId: number;
  grids: Record<string, Float32Array>;
} | null = null;
let _lutIdCounter = 0;
let _lastLutId = 0;

function specKey(spec: RasterSpec): string {
  return `${spec.w.toFixed(5)}_${spec.s.toFixed(5)}_${spec.e.toFixed(5)}_${spec.n.toFixed(5)}_${spec.cols}_${spec.rows}`;
}

function getCachedVariableGrids(
  spec: RasterSpec,
  membershipRaster: Int16Array,
  lut: MunicipalityLUT,
  cols: number,
  rows: number,
): Record<string, Float32Array> {
  const sk = specKey(spec);
  if (_gridCache && _gridCache.specKey === sk && _gridCache.lutId === _lastLutId) {
    return _gridCache.grids;
  }
  const grids = buildAllVariableGrids(membershipRaster, lut, cols, rows);
  _gridCache = { specKey: sk, lutId: _lastLutId, grids };
  return grids;
}

/* ── Higher-resolution viewport spec ──────────────────────────────── */

/** Catalonia bounds. */
const CAT_W = 0.16, CAT_S = 40.52, CAT_E = 3.33, CAT_N = 42.86;

/**
 * Grid-pipeline viewport spec with higher max dimension (1024 vs 512).
 * Uses the same metres-per-pixel targeting as the legacy function but
 * allows twice the resolution at high zoom levels.
 */
export function gridViewportSpecForZoom(
  vw: number, vs: number, ve: number, vn: number, zoom: number,
): RasterSpec {
  const w = Math.max(vw, CAT_W);
  const s = Math.max(vs, CAT_S);
  const e = Math.min(ve, CAT_E);
  const n = Math.min(vn, CAT_N);

  if (w >= e || s >= n) return { w: CAT_W, s: CAT_S, e: CAT_E, n: CAT_N, cols: 412, rows: 308 };

  const latMid = (s + n) / 2;
  const mPerDegLon = 111_320 * Math.cos(latMid * (Math.PI / 180));
  const mPerDegLat = 110_540;
  const targetM = Math.max(5, Math.min(800, Math.round(4_000 / Math.pow(2, zoom - 8))));

  const MAX = 1024;  // double legacy 512
  const cols = Math.min(MAX, Math.max(100, Math.ceil((e - w) * mPerDegLon / targetM)));
  const rows = Math.min(MAX, Math.max(75, Math.ceil((n - s) * mPerDegLat / targetM)));

  return { w, s, e, n, cols, rows };
}

/* ── Worker management ─────────────────────────────────────────────── */

let _worker: Worker | null = null;
let _workerFailed = false;
let _requestId = 0;
const _pending = new Map<number, {
  resolve: (r: HeatmapWorkerResponse) => void;
  reject: (e: Error) => void;
}>();

function getWorker(): Worker | null {
  if (_workerFailed) return null;
  if (_worker) return _worker;

  try {
    _worker = new Worker(
      new URL('../workers/heatmapWorker.ts', import.meta.url),
      { type: 'module' },
    );

    _worker.onmessage = (ev: MessageEvent<HeatmapWorkerResponse>) => {
      const { id } = ev.data;
      const entry = _pending.get(id);
      if (entry) {
        _pending.delete(id);
        entry.resolve(ev.data);
      }
    };

    _worker.onerror = (err) => {
      console.warn('[heatmapBridge] Worker error, falling back to main thread:', err.message);
      _workerFailed = true;
      _worker = null;
      // Reject all pending
      for (const [id, entry] of _pending) {
        entry.reject(new Error('Worker failed'));
        _pending.delete(id);
      }
    };

    return _worker;
  } catch (e) {
    console.warn('[heatmapBridge] Worker init failed, using main thread fallback:', e);
    _workerFailed = true;
    return null;
  }
}

/* ── LUT cache ─────────────────────────────────────────────────────── */

let _lutCache: { featureCount: number; lut: MunicipalityLUT } | null = null;

function getCachedLUT(
  municipalities: MunicipalityCollection,
  data: MunicipalityData,
): MunicipalityLUT {
  const n = municipalities.features.length;
  if (_lutCache && _lutCache.featureCount === n) return _lutCache.lut;
  const lut = buildMunicipalityLUT(municipalities, data);
  _lutCache = { featureCount: n, lut };
  _lastLutId = ++_lutIdCounter;  // Invalidate grid cache on new LUT
  return lut;
}

/** Invalidate all caches (e.g. when municipality data is reloaded). */
export function invalidateHeatmapCaches(): void {
  _lutCache = null;
  _gridCache = null;
  revokeOldBlobUrl();
  invalidateRasterCache();
}

/* ── Main-thread fallback ──────────────────────────────────────────── */

async function renderOnMainThread(
  req: HeatmapRenderRequest,
): Promise<HeatmapRenderResult> {
  const t0 = performance.now();
  const { municipalities, municipalityData, layers, configs, spec, demSamples, disqualifiedMask } = req;
  const { cols, rows } = spec;
  const n = cols * rows;

  const enabledLayers = layers.filter((l) => l.enabled);

  // 1. Membership raster
  const membershipRaster = rasteriseMunicipalities(spec, municipalities);

  // 2. LUT + cached variable grids
  const lut = getCachedLUT(municipalities, municipalityData);
  const variableGrids = getCachedVariableGrids(spec, membershipRaster, lut, cols, rows);

  // 3. Terrain grids
  const terrainGrids = demSamples ? {
    slopes: demSamples.slopes,
    elevations: demSamples.elevations,
    aspects: demSamples.aspects,
    hasData: demSamples.hasData,
  } : null;

  // 4. Score
  const result = computeVisualScoreGrid(
    variableGrids,
    terrainGrids,
    membershipRaster,
    enabledLayers,
    configs,
    n,
  );

  // 5. RGBA → async blob URL
  const rgbaPixels = scoreGridToRGBA(result, disqualifiedMask);
  const pixelsClamped = new Uint8ClampedArray(rgbaPixels.buffer as ArrayBuffer);
  const dataUrl = await pixelsToBlobUrl(pixelsClamped, cols, rows);

  const renderTimeMs = performance.now() - t0;
  return {
    dataUrl,
    bounds: [spec.w, spec.s, spec.e, spec.n],
    minScore: result.minScore,
    maxScore: result.maxScore,
    renderTimeMs,
  };
}

/* ── Worker-based render ───────────────────────────────────────────── */

function renderViaWorker(
  req: HeatmapRenderRequest,
): Promise<HeatmapRenderResult> {
  const t0 = performance.now();
  const worker = getWorker()!;
  const { municipalities, municipalityData, layers, configs, spec, demSamples, disqualifiedMask } = req;
  const { cols, rows } = spec;

  const enabledLayers = layers.filter((l) => l.enabled);

  // 1. Build grids on main thread (fast, ~5ms at 512²; ~20ms at 2048²)
  const membershipRaster = rasteriseMunicipalities(spec, municipalities);
  const lut = getCachedLUT(municipalities, municipalityData);
  const variableGrids = getCachedVariableGrids(spec, membershipRaster, lut, cols, rows);

  // 2. Build the transferable request
  const variableGridBuffers: Record<string, ArrayBuffer> = {};
  const transferables: ArrayBuffer[] = [];

  // Clone membership raster for transfer
  const memberBuf = membershipRaster.buffer.slice(0) as ArrayBuffer;
  transferables.push(memberBuf);

  // Clone variable grids for transfer
  for (const [name, grid] of Object.entries(variableGrids)) {
    const buf = grid.buffer.slice(0) as ArrayBuffer;
    variableGridBuffers[name] = buf;
    transferables.push(buf);
  }

  // DEM terrain grids
  let terrainGridBuffers: HeatmapWorkerRequest['terrainGridBuffers'] = null;
  if (demSamples) {
    const slopesBuf = demSamples.slopes.buffer.slice(0) as ArrayBuffer;
    const elevBuf = demSamples.elevations.buffer.slice(0) as ArrayBuffer;
    const aspectsBuf = demSamples.aspects.buffer.slice(0) as ArrayBuffer;
    const hasDataBuf = demSamples.hasData.buffer.slice(0) as ArrayBuffer;
    terrainGridBuffers = {
      slopes: slopesBuf,
      elevations: elevBuf,
      aspects: aspectsBuf,
      hasData: hasDataBuf,
    };
    transferables.push(slopesBuf, elevBuf, aspectsBuf, hasDataBuf);
  }

  const id = ++_requestId;
  const workerReq: HeatmapWorkerRequest = {
    id,
    cols,
    rows,
    membershipRaster: memberBuf as ArrayBuffer,
    variableGridBuffers,
    terrainGridBuffers,
    enabledLayers,
    configs,
    disqualifiedMask,
  };

  return new Promise<HeatmapRenderResult>((resolve, reject) => {
    _pending.set(id, {
      resolve: async (resp) => {
        // Convert RGBA buffer to async blob URL (faster than toDataURL)
        const pixels = new Uint8ClampedArray(resp.pixelsBuffer);
        const dataUrl = await pixelsToBlobUrl(pixels, resp.cols, resp.rows);

        resolve({
          dataUrl,
          bounds: [spec.w, spec.s, spec.e, spec.n],
          minScore: resp.minScore,
          maxScore: resp.maxScore,
          renderTimeMs: performance.now() - t0,
        });
      },
      reject,
    });

    worker.postMessage(workerReq, transferables);
  });
}

/* ── Public API ─────────────────────────────────────────────────────── */

/** Current pending render ID — used to cancel stale renders. */
let _currentRenderId = 0;

/**
 * Request a heatmap render.  Uses the Web Worker if available, otherwise
 * falls back to the main thread.
 *
 * Automatically cancels stale renders — only the most recent request
 * will resolve.  Earlier requests resolve with `null`.
 *
 * @returns HeatmapRenderResult, or null if superseded by a newer request
 */
export async function requestHeatmapRender(
  req: HeatmapRenderRequest,
): Promise<HeatmapRenderResult | null> {
  const myId = ++_currentRenderId;

  // Validate input
  if (!req.municipalities || req.municipalities.features.length === 0) return null;

  try {
    let result: HeatmapRenderResult;

    if (getWorker()) {
      result = await renderViaWorker(req);
    } else {
      result = await renderOnMainThread(req);
    }

    // Check if superseded
    if (_currentRenderId !== myId) return null;

    return result;
  } catch (e) {
    console.warn('[heatmapBridge] Render failed, trying main thread fallback:', e);
    // If worker failed, try main thread
    if (_currentRenderId !== myId) return null;
    try {
      return await renderOnMainThread(req);
    } catch (e2) {
      console.error('[heatmapBridge] Main thread fallback also failed:', e2);
      return null;
    }
  }
}
