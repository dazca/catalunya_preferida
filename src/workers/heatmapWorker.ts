/**
 * @file Heatmap Web Worker — runs the grid scoring pipeline off the main thread.
 *
 * Message protocol:
 *   Main → Worker:  HeatmapWorkerRequest  (with transferable buffers)
 *   Worker → Main:  HeatmapWorkerResponse  (with transferable RGBA pixel buffer)
 *
 * The worker receives pre-built grids (membership raster, variable grids,
 * DEM terrain grids) and executes the vectorised scoring pipeline.  It returns
 * a ready-to-render RGBA pixel buffer.
 *
 * Transferable buffers are used for zero-copy transfer in both directions.
 */

import type { LayerMeta } from '../types';
import type { LayerConfigs } from '../types/transferFunction';
import {
  computeVisualScoreGrid,
  scoreGridToRGBA,
} from '../utils/gridFormulaEngine';

/* ── Message types ─────────────────────────────────────────────────── */

export interface HeatmapWorkerRequest {
  id: number;
  cols: number;
  rows: number;
  /** Int16Array membership raster buffer */
  membershipRaster: ArrayBuffer;
  /** Variable grids: name → Float32Array buffer */
  variableGridBuffers: Record<string, ArrayBuffer>;
  /** DEM terrain grids (null if not available) */
  terrainGridBuffers: {
    slopes: ArrayBuffer;
    elevations: ArrayBuffer;
    aspects: ArrayBuffer;
    hasData: ArrayBuffer;
  } | null;
  /** Enabled layer metadata (serialisable) */
  enabledLayers: LayerMeta[];
  /** Layer configs (serialisable) */
  configs: LayerConfigs;
  /** Disqualified pixel treatment */
  disqualifiedMask: 'black' | 'transparent';
}

export interface HeatmapWorkerResponse {
  id: number;
  /** RGBA pixel data buffer */
  pixelsBuffer: ArrayBuffer;
  cols: number;
  rows: number;
  minScore: number;
  maxScore: number;
}

/* ── Worker entry point ────────────────────────────────────────────── */

self.onmessage = (ev: MessageEvent<HeatmapWorkerRequest>) => {
  const req = ev.data;
  const { id, cols, rows, enabledLayers, configs, disqualifiedMask } = req;
  const n = cols * rows;

  // Reconstruct typed arrays from transferred buffers
  const membershipRaster = new Int16Array(req.membershipRaster);

  const variableGrids: Record<string, Float32Array> = {};
  for (const [name, buf] of Object.entries(req.variableGridBuffers)) {
    variableGrids[name] = new Float32Array(buf);
  }

  let terrainGrids: {
    slopes: Float32Array;
    elevations: Float32Array;
    aspects: Uint8Array;
    hasData: Uint8Array;
  } | null = null;

  if (req.terrainGridBuffers) {
    terrainGrids = {
      slopes: new Float32Array(req.terrainGridBuffers.slopes),
      elevations: new Float32Array(req.terrainGridBuffers.elevations),
      aspects: new Uint8Array(req.terrainGridBuffers.aspects),
      hasData: new Uint8Array(req.terrainGridBuffers.hasData),
    };
  }

  // Execute the vectorised scoring pipeline
  const result = computeVisualScoreGrid(
    variableGrids,
    terrainGrids,
    membershipRaster,
    enabledLayers,
    configs,
    n,
  );

  // Convert to RGBA pixels
  const pixels = scoreGridToRGBA(result, disqualifiedMask);

  // Send back with transferable buffer
  const response: HeatmapWorkerResponse = {
    id,
    pixelsBuffer: pixels.buffer as ArrayBuffer,
    cols,
    rows,
    minScore: result.minScore,
    maxScore: result.maxScore,
  };

  (self as unknown as Worker).postMessage(response, [pixels.buffer]);
};
