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
import { isWebGPUAvailable, gpuRenderScoreGrid } from './gpuRenderer';

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

/**
 * Revoke previous blob URL to avoid memory leaks.
 * Deferred slightly so MapLibre has time to finish loading the old image
 * before the URL is invalidated.
 */
function revokeOldBlobUrl(): void {
  if (_lastBlobUrl) {
    const toRevoke = _lastBlobUrl;
    _lastBlobUrl = null;
    setTimeout(() => URL.revokeObjectURL(toRevoke), 2000);
  }
}

/** Convert RGBA pixel array to an async blob URL (faster than toDataURL). */
async function pixelsToBlobUrl(
  pixels: Uint8ClampedArray, cols: number, rows: number,
): Promise<string> {
  // Determine the safe output dimensions for the display pipeline.
  // MapLibre paints this image as a WebGL texture; exceeding
  // MAX_TEXTURE_SIZE causes silent partial uploads on some drivers.
  const maxDim = getMaxDisplayDim();
  let outW = cols;
  let outH = rows;
  if (outW > maxDim || outH > maxDim) {
    const scale = maxDim / Math.max(outW, outH);
    outW = Math.round(outW * scale);
    outH = Math.round(outH * scale);
    console.warn(
      `[heatmapBridge] Downscaling heatmap image: ${cols}\u00d7${rows} \u2192 ${outW}\u00d7${outH} (display limit ${maxDim})`,
    );
  }

  // Build the full-resolution ImageData
  const imageData = new ImageData(
    new Uint8ClampedArray(pixels.buffer as ArrayBuffer, pixels.byteOffset, pixels.length),
    cols, rows,
  );

  // If downscaling is needed, use createImageBitmap for efficient resize
  let canvas: HTMLCanvasElement | OffscreenCanvas;
  if (outW !== cols || outH !== rows) {
    const bitmap = await createImageBitmap(imageData, {
      resizeWidth: outW,
      resizeHeight: outH,
      resizeQuality: 'medium',
    });
    canvas = document.createElement('canvas');
    canvas.width = outW;
    canvas.height = outH;
    canvas.getContext('2d')!.drawImage(bitmap, 0, 0);
    bitmap.close();
  } else {
    canvas = document.createElement('canvas');
    canvas.width = cols;
    canvas.height = rows;
    canvas.getContext('2d')!.putImageData(imageData, 0, 0);
  }

  const blob = await new Promise<Blob>((resolve, reject) => {
    (canvas as HTMLCanvasElement).toBlob(
      (b) => (b ? resolve(b) : reject(new Error('toBlob returned null'))),
      'image/png',
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

export type HeatmapResolutionMode = 'auto' | 'full' | 'custom';

/* ── Display-safe dimension detection ────────────────────────────── */

/**
 * Detect the maximum texture dimension supported by the WebGL context
 * that MapLibre uses. Cached after first call.
 */
let _maxDisplayDim: number | null = null;

function getMaxDisplayDim(): number {
  if (_maxDisplayDim !== null) return _maxDisplayDim;
  if (typeof document === 'undefined') {
    _maxDisplayDim = 2048;
    return _maxDisplayDim;
  }
  try {
    const c = document.createElement('canvas');
    c.width = 1;
    c.height = 1;
    const gl = c.getContext('webgl2') || c.getContext('webgl');
    if (gl) {
      const maxTex = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;
      // Stay well below the hardware limit — hitting exactly MAX_TEXTURE_SIZE
      // causes partial texture uploads on some drivers (Chrome/ANGLE issue).
      _maxDisplayDim = Math.max(512, Math.floor(maxTex * 0.75));
      const ext = gl.getExtension('WEBGL_lose_context');
      if (ext) ext.loseContext();
    } else {
      _maxDisplayDim = 2048;
    }
  } catch {
    _maxDisplayDim = 2048;
  }
  console.debug(`[heatmapBridge] Max display dim: ${_maxDisplayDim}`);
  return _maxDisplayDim;
}

export interface GridResolutionOptions {
  mode?: HeatmapResolutionMode;
  scale?: number;
}

/**
 * Grid-pipeline viewport spec with higher max dimension (1024 vs 512).
 * Uses the same metres-per-pixel targeting as the legacy function but
 * allows twice the resolution at high zoom levels.
 */
export function gridViewportSpecForZoom(
  vw: number, vs: number, ve: number, vn: number, zoom: number,
  options: GridResolutionOptions = {},
): RasterSpec {
  const w = Math.max(vw, CAT_W);
  const s = Math.max(vs, CAT_S);
  const e = Math.min(ve, CAT_E);
  const n = Math.min(vn, CAT_N);

  if (w >= e || s >= n) return { w: CAT_W, s: CAT_S, e: CAT_E, n: CAT_N, cols: 412, rows: 308 };

  const latMid = (s + n) / 2;
  const mPerDegLon = 111_320 * Math.cos(latMid * (Math.PI / 180));
  const mPerDegLat = 110_540;
  const mode = options.mode ?? 'auto';
  const scale = Math.max(1, Math.min(8, options.scale ?? 1));

  const autoTargetM = Math.max(5, Math.min(800, Math.round(4_000 / Math.pow(2, zoom - 8))));

  // The display pipeline cap: stay under MAX_TEXTURE_SIZE for MapLibre's
  // WebGL context to avoid partial texture uploads.
  const displayMax = getMaxDisplayDim();

  let targetM = autoTargetM;
  let maxDim = Math.min(2048, displayMax);
  if (mode === 'full') {
    targetM = 20;
    maxDim = displayMax;
  } else if (mode === 'custom') {
    targetM = Math.max(5, Math.round(autoTargetM / scale));
    maxDim = Math.min(displayMax, Math.round(2048 * scale));
  }

  let cols = Math.min(maxDim, Math.max(100, Math.ceil((e - w) * mPerDegLon / targetM)));
  let rows = Math.min(maxDim, Math.max(75, Math.ceil((n - s) * mPerDegLat / targetM)));

  // Cap total pixel count to keep GPU terrain buffer under 128 MiB
  // (the WebGPU default maxStorageBufferBindingSize).
  // 8 M pixels \u2192 terrain buf = 96 MB, well within limit.
  const MAX_SAFE_PIXELS = 8_388_608;
  if (cols * rows > MAX_SAFE_PIXELS) {
    const aspect = cols / rows;
    rows = Math.floor(Math.sqrt(MAX_SAFE_PIXELS / aspect));
    cols = Math.floor(rows * aspect);
  }

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

/* ── GPU render path ────────────────────────────────────────────────── */

/** Whether to attempt the WebGPU path. Can be overridden by the store. */
let _useGpu = true;

/** Set whether the GPU path should be attempted. */
export function setUseGpu(enabled: boolean): void {
  _useGpu = enabled;
}

/** Check if GPU rendering is currently active. */
export function isGpuActive(): boolean {
  return _useGpu && isWebGPUAvailable();
}

async function renderViaGpu(
  req: HeatmapRenderRequest,
): Promise<HeatmapRenderResult> {
  const t0 = performance.now();
  const { municipalities, municipalityData, layers, configs, spec, demSamples, disqualifiedMask } = req;
  const { cols, rows } = spec;

  const enabledLayers = layers.filter((l) => l.enabled);

  // 1. Membership raster (CPU, cached)
  const membershipRaster = rasteriseMunicipalities(spec, municipalities);

  // 2. LUT (CPU, cached)
  const lut = getCachedLUT(municipalities, municipalityData);
  const featureCount = municipalities.features.length;

  // 3. GPU render
  const result = await gpuRenderScoreGrid({
    membershipRaster,
    lut,
    featureCount,
    enabledLayers,
    configs,
    cols,
    rows,
    demSamples,
    disqualifiedMask,
    aspectPrefs: configs.terrain.aspect,
    aspectWeight: configs.terrain.aspectWeight ?? 1,
  });

  if (!result) {
    throw new Error('GPU render returned null');
  }

  // 4. Pixels -> blob URL
  const dataUrl = await pixelsToBlobUrl(result.pixels, cols, rows);

  return {
    dataUrl,
    bounds: [spec.w, spec.s, spec.e, spec.n],
    minScore: result.minScore,
    maxScore: result.maxScore,
    renderTimeMs: performance.now() - t0,
  };
}

/* ── Public API ─────────────────────────────────────────────────────── */

/** Current pending render ID — used to cancel stale renders. */
let _currentRenderId = 0;

/**
 * Request a heatmap render. Tries GPU first (if enabled), then Worker,
 * then main-thread fallback.
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

    if (_useGpu && isWebGPUAvailable()) {
      result = await renderViaGpu(req);
    } else if (getWorker()) {
      result = await renderViaWorker(req);
    } else {
      result = await renderOnMainThread(req);
    }

    // Check if superseded
    if (_currentRenderId !== myId) return null;

    return result;
  } catch (e) {
    console.warn('[heatmapBridge] Render failed, trying fallback:', e);
    if (_currentRenderId !== myId) return null;

    // GPU failed -> try Worker
    if (_useGpu && isWebGPUAvailable()) {
      try {
        console.warn('[heatmapBridge] Falling back from GPU to Worker/CPU');
        let result: HeatmapRenderResult;
        if (getWorker()) {
          result = await renderViaWorker(req);
        } else {
          result = await renderOnMainThread(req);
        }
        if (_currentRenderId !== myId) return null;
        return result;
      } catch (e2) {
        console.error('[heatmapBridge] Worker/CPU fallback also failed:', e2);
        return null;
      }
    }

    // Worker failed -> try main thread
    try {
      return await renderOnMainThread(req);
    } catch (e2) {
      console.error('[heatmapBridge] Main thread fallback also failed:', e2);
      return null;
    }
  }
}
