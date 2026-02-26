/**
 * @file WebGPU-accelerated heatmap scoring pipeline.
 *
 * Replaces the CPU/Worker grid pipeline with GPU compute shaders.
 * The pipeline:
 *   1. Upload membership raster + per-municipality LUTs as GPU buffers
 *   2. Upload per-layer TF params + weights as a uniform buffer
 *   3. Run a compute shader that, for each pixel:
 *      a. Reads feature index from membership raster
 *      b. For each enabled layer, fetches raw value from LUT,
 *         applies the transfer function (sin/invsin/range/invrange),
 *         accumulates weighted score
 *      c. Checks disqualification (mandatory layers)
 *   4. Run a second compute shader to convert scores to RGBA via
 *      the RYG colormap
 *   5. Read back RGBA pixels for MapLibre image source overlay
 *
 * Falls back to CPU/Worker pipeline if WebGPU is unavailable.
 *
 * ## Performance target
 *   2048x2048 grid (~4M pixels): <5ms GPU vs ~30ms CPU
 */

/* ── Feature detection ──────────────────────────────────────────────── */

let _gpuDevice: GPUDevice | null = null;
let _gpuFailed = false;

/**
 * Check if WebGPU is available in this browser.
 */
export function isWebGPUAvailable(): boolean {
  return typeof navigator !== 'undefined' && 'gpu' in navigator && !_gpuFailed;
}

/**
 * Initialize the WebGPU device. Cached after first successful init.
 * Returns null if WebGPU is unavailable.
 */
export async function initGpuDevice(): Promise<GPUDevice | null> {
  if (_gpuDevice) return _gpuDevice;
  if (_gpuFailed) return null;

  try {
    if (!navigator.gpu) {
      _gpuFailed = true;
      return null;
    }

    const adapter = await navigator.gpu.requestAdapter({
      powerPreference: 'high-performance',
    });
    if (!adapter) {
      console.warn('[gpuRenderer] No WebGPU adapter available');
      _gpuFailed = true;
      return null;
    }

    _gpuDevice = await adapter.requestDevice();

    _gpuDevice.lost.then((info) => {
      console.warn('[gpuRenderer] WebGPU device lost:', info.message);
      _gpuDevice = null;
      // Allow re-init attempt
    });

    return _gpuDevice;
  } catch (e) {
    console.warn('[gpuRenderer] WebGPU init failed:', e);
    _gpuFailed = true;
    return null;
  }
}

/* ── WGSL Shaders ────────────────────────────────────────────────── */

/**
 * Maximum number of layers supported in a single dispatch.
 * Must match the WGSL constant.
 */
const MAX_LAYERS = 48;

/**
 * Compute shader: scoring pipeline.
 *
 * Reads membership raster (per-pixel feature index), per-municipality LUT
 * (raw values), and per-layer TF params. Outputs a per-pixel score.
 *
 * Layout:
 *   @group(0) @binding(0) membership: array<i32>      [cols*rows]
 *   @group(0) @binding(1) lut:        array<f32>      [featureCount * numVars]
 *   @group(0) @binding(2) layerParams: LayerParamsUBO
 *   @group(0) @binding(3) scores:     array<f32>      [cols*rows] (output)
 *   @group(0) @binding(4) terrainData: array<f32>     [cols*rows * 3] (slope, elev, aspect interleaved)
 *   @group(0) @binding(5) hasData:    array<u32>      [ceil(cols*rows/4)] (packed u8)
 */
const SCORE_SHADER = /* wgsl */ `

/// Per-layer parameters (64 bytes each, aligned to 16 bytes).
struct LayerParams {
  plateauEnd: f32,
  decayEnd: f32,
  ceiling: f32,
  floor: f32,
  weight: f32,
  shape: u32,     // 0=sin, 1=invsin, 2=range, 3=invrange
  mandatory: u32, // 0 or 1
  varIndex: i32,  // index into LUT columns, or -1/-2/-3 for terrain
  // -1 = terrainSlope, -2 = terrainElevation, -3 = terrainAspect
};

struct Uniforms {
  numPixels: u32,
  numLayers: u32,
  numVars: u32,
  featureCount: u32,
  hasTerrain: u32,
  maskMode: u32,     // 0 = black, 1 = transparent
  _pad0: u32,
  _pad1: u32,
};

@group(0) @binding(0) var<storage, read> membership: array<i32>;
@group(0) @binding(1) var<storage, read> lut: array<f32>;
@group(0) @binding(2) var<uniform> uniforms: Uniforms;
@group(0) @binding(3) var<storage, read_write> scores: array<f32>;
@group(0) @binding(4) var<storage, read> terrainData: array<f32>;
@group(0) @binding(5) var<storage, read> hasDataPacked: array<u32>;
@group(0) @binding(6) var<storage, read> layerParamsArr: array<LayerParams>;
@group(0) @binding(7) var<storage, read> aspectLut: array<f32>;

const PI: f32 = 3.14159265358979323846;
const DISQUALIFIED: f32 = -2.0;
const NAN_SENTINEL: f32 = -99999.0;

/// Apply transfer function to a single value.
fn applyTf(v: f32, lp: LayerParams) -> f32 {
  // NaN sentinel check
  if (v <= NAN_SENTINEL + 1.0) {
    return NAN_SENTINEL;
  }

  let M = lp.plateauEnd;
  let N = lp.decayEnd;
  let high = lp.ceiling;
  let low = lp.floor;

  if (lp.shape == 0u) {
    // sin: <=M -> high, >=N -> low, cosine decay between
    if (v <= M) { return high; }
    if (v >= N) { return low; }
    let t = (v - M) / (N - M);
    return low + (high - low) * 0.5 * (1.0 + cos(PI * t));
  } else if (lp.shape == 1u) {
    // invsin: <=M -> low, >=N -> high, cosine rise between
    if (v <= M) { return low; }
    if (v >= N) { return high; }
    let t = (v - M) / (N - M);
    return low + (high - low) * 0.5 * (1.0 - cos(PI * t));
  } else if (lp.shape == 2u) {
    // range: <=M -> high, >=N -> low, linear decay
    if (v <= M) { return high; }
    if (v >= N) { return low; }
    let t = (v - M) / (N - M);
    return high - (high - low) * t;
  } else {
    // invrange: <=M -> low, >=N -> high, linear rise
    if (v <= M) { return low; }
    if (v >= N) { return high; }
    let t = (v - M) / (N - M);
    return low + (high - low) * t;
  }
}

/// Read hasData byte from packed u32 array.
fn readHasData(idx: u32) -> u32 {
  let wordIdx = idx / 4u;
  let byteIdx = idx % 4u;
  return (hasDataPacked[wordIdx] >> (byteIdx * 8u)) & 0xFFu;
}

@compute @workgroup_size(256)
fn scoreMain(@builtin(global_invocation_id) gid: vec3<u32>) {
  let idx = gid.x;
  if (idx >= uniforms.numPixels) {
    return;
  }

  let featureIdx = membership[idx];

  // Outside all municipalities -> NaN sentinel
  if (featureIdx < 0) {
    scores[idx] = NAN_SENTINEL;
    return;
  }

  var weightedSum: f32 = 0.0;
  var totalWeight: f32 = 0.0;
  var disqualified: bool = false;

  let numLayers = uniforms.numLayers;
  let numVars = uniforms.numVars;
  let fc = uniforms.featureCount;
  let hasTerrain = uniforms.hasTerrain != 0u;

  for (var li: u32 = 0u; li < numLayers; li = li + 1u) {
    let lp = layerParamsArr[li];
    var rawVal: f32 = NAN_SENTINEL;

    if (lp.varIndex == -1) {
      // terrainSlope
      if (hasTerrain) {
        rawVal = terrainData[idx * 3u];
      }
    } else if (lp.varIndex == -2) {
      // terrainElevation
      if (hasTerrain) {
        rawVal = terrainData[idx * 3u + 1u];
      }
    } else if (lp.varIndex == -3) {
      // terrainAspect — use aspect LUT
      if (hasTerrain) {
        let aspectCode = u32(terrainData[idx * 3u + 2u]);
        rawVal = aspectLut[min(aspectCode, 255u)];
        // Aspect scoring goes directly to weighted sum
        let score = rawVal;
        weightedSum += score * lp.weight;
        totalWeight += lp.weight;
        continue;
      }
    } else if (lp.varIndex >= 0) {
      // Municipality variable: LUT[featureIdx + varIndex * featureCount]
      let lutIdx = u32(lp.varIndex) * fc + u32(featureIdx);
      rawVal = lut[lutIdx];
    }

    // Skip NaN / missing data
    if (rawVal <= NAN_SENTINEL + 1.0) {
      continue;
    }

    // Skip terrain pixels without DEM data
    let isTerrainLayer = lp.varIndex == -1 || lp.varIndex == -2;
    if (isTerrainLayer && hasTerrain && readHasData(idx) == 0u) {
      continue;
    }

    let tfScore = applyTf(rawVal, lp);

    if (tfScore <= NAN_SENTINEL + 1.0) {
      continue;
    }

    // Disqualification check for mandatory layers
    if (lp.mandatory != 0u) {
      let threshold = lp.floor + 0.001;
      if (tfScore <= threshold) {
        // But not for terrain layers without data
        if (!(isTerrainLayer && hasTerrain && readHasData(idx) == 0u)) {
          disqualified = true;
        }
      }
    }

    weightedSum += tfScore * lp.weight;
    totalWeight += lp.weight;
  }

  // Normalise
  var finalScore: f32;
  if (totalWeight > 0.0) {
    finalScore = weightedSum / totalWeight;
  } else {
    finalScore = 0.0;
  }

  // Apply disqualification
  if (disqualified) {
    finalScore = DISQUALIFIED;
  }

  // No DEM data for terrain-active scenes -> NaN
  if (hasTerrain && readHasData(idx) == 0u && featureIdx >= 0) {
    // Check if any terrain layer is present
    var hasTerrainLayer = false;
    for (var li2: u32 = 0u; li2 < numLayers; li2 = li2 + 1u) {
      let vi = layerParamsArr[li2].varIndex;
      if (vi == -1 || vi == -2 || vi == -3) {
        hasTerrainLayer = true;
        break;
      }
    }
    if (hasTerrainLayer) {
      finalScore = NAN_SENTINEL;
    }
  }

  scores[idx] = finalScore;
}
`;

/**
 * Compute shader: score-to-RGBA conversion.
 *
 * Reads the score buffer and writes RGBA pixels using the RYG colormap.
 * HSL interpolation: t=0 -> red (H=0), t=1 -> green (H=120).
 *
 *   @group(0) @binding(0) scores:  array<f32>      [n]
 *   @group(0) @binding(1) pixels:  array<u32>      [n] (packed RGBA)
 *   @group(0) @binding(2) config:  ColorUniforms
 */
const COLORMAP_SHADER = /* wgsl */ `

struct ColorUniforms {
  numPixels: u32,
  maskMode: u32,   // 0 = black, 1 = transparent
  _pad0: u32,
  _pad1: u32,
};

@group(0) @binding(0) var<storage, read> scores: array<f32>;
@group(0) @binding(1) var<storage, read_write> pixels: array<u32>;
@group(0) @binding(2) var<uniform> colorUniforms: ColorUniforms;

const DISQUALIFIED: f32 = -2.0;
const NAN_SENTINEL: f32 = -99999.0;

/// HSL to RGB (h in 0-360, s and l in 0-1) -> packed RGBA u32
fn hslToRgba(h: f32, s: f32, l: f32, a: f32) -> u32 {
  let c = (1.0 - abs(2.0 * l - 1.0)) * s;
  let x = c * (1.0 - abs(((h / 60.0) % 2.0) - 1.0));
  let m = l - c / 2.0;

  var r1: f32; var g1: f32; var b1: f32;
  if (h < 60.0) {
    r1 = c; g1 = x; b1 = 0.0;
  } else if (h < 120.0) {
    r1 = x; g1 = c; b1 = 0.0;
  } else if (h < 180.0) {
    r1 = 0.0; g1 = c; b1 = x;
  } else if (h < 240.0) {
    r1 = 0.0; g1 = x; b1 = c;
  } else if (h < 300.0) {
    r1 = x; g1 = 0.0; b1 = c;
  } else {
    r1 = c; g1 = 0.0; b1 = x;
  }

  let r = u32((r1 + m) * 255.0 + 0.5);
  let g = u32((g1 + m) * 255.0 + 0.5);
  let b = u32((b1 + m) * 255.0 + 0.5);
  let alpha = u32(a * 255.0 + 0.5);

  // Pack as RGBA (little-endian: R in low byte)
  return r | (g << 8u) | (b << 16u) | (alpha << 24u);
}

@compute @workgroup_size(256)
fn colormapMain(@builtin(global_invocation_id) gid: vec3<u32>) {
  let idx = gid.x;
  if (idx >= colorUniforms.numPixels) {
    return;
  }

  let raw = scores[idx];

  // NaN sentinel -> transparent
  if (raw <= NAN_SENTINEL + 1.0) {
    pixels[idx] = 0u; // fully transparent
    return;
  }

  // Disqualified
  if (raw > DISQUALIFIED - 0.5 && raw < DISQUALIFIED + 0.5) {
    if (colorUniforms.maskMode == 0u) {
      // Black mask: rgba(40, 40, 40, 180)
      pixels[idx] = 40u | (40u << 8u) | (40u << 16u) | (180u << 24u);
    } else {
      pixels[idx] = 0u; // transparent
    }
    return;
  }

  // Clamp score to [0, 1]
  let score = clamp(raw, 0.0, 1.0);

  // RYG colormap: score -> hue (0=red, 120=green), S=0.9, L=0.5
  let h = score * 120.0;
  pixels[idx] = hslToRgba(h, 0.9, 0.5, 210.0 / 255.0);
}
`;

/* ── Pipeline state ──────────────────────────────────────────────── */

interface GpuPipelineState {
  device: GPUDevice;
  scorePipeline: GPUComputePipeline;
  colormapPipeline: GPUComputePipeline;
  scoreBindGroupLayout: GPUBindGroupLayout;
  colormapBindGroupLayout: GPUBindGroupLayout;
}

let _pipeline: GpuPipelineState | null = null;

/**
 * Compile shaders and create compute pipelines. Cached after first call.
 * Uses async pipeline creation to surface shader compilation errors.
 */
async function ensurePipeline(device: GPUDevice): Promise<GpuPipelineState> {
  if (_pipeline && _pipeline.device === device) return _pipeline;

  // Score pipeline
  const scoreModule = device.createShaderModule({ code: SCORE_SHADER });
  const scoreCompInfo = await scoreModule.getCompilationInfo();
  for (const msg of scoreCompInfo.messages) {
    if (msg.type === 'error') {
      const err = `[gpuRenderer] Score shader error at line ${msg.lineNum}: ${msg.message}`;
      console.error(err);
      throw new Error(err);
    }
    if (msg.type === 'warning') {
      console.warn(`[gpuRenderer] Score shader warning: ${msg.message}`);
    }
  }

  const scoreBindGroupLayout = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
      { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
      { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
      { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
      { binding: 4, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
      { binding: 5, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
      { binding: 6, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
      { binding: 7, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
    ],
  });

  const scorePipeline = await device.createComputePipelineAsync({
    layout: device.createPipelineLayout({ bindGroupLayouts: [scoreBindGroupLayout] }),
    compute: { module: scoreModule, entryPoint: 'scoreMain' },
  });

  // Colormap pipeline
  const colormapModule = device.createShaderModule({ code: COLORMAP_SHADER });
  const colormapCompInfo = await colormapModule.getCompilationInfo();
  for (const msg of colormapCompInfo.messages) {
    if (msg.type === 'error') {
      const err = `[gpuRenderer] Colormap shader error at line ${msg.lineNum}: ${msg.message}`;
      console.error(err);
      throw new Error(err);
    }
    if (msg.type === 'warning') {
      console.warn(`[gpuRenderer] Colormap shader warning: ${msg.message}`);
    }
  }

  const colormapBindGroupLayout = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
      { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
      { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
    ],
  });

  const colormapPipeline = await device.createComputePipelineAsync({
    layout: device.createPipelineLayout({ bindGroupLayouts: [colormapBindGroupLayout] }),
    compute: { module: colormapModule, entryPoint: 'colormapMain' },
  });

  _pipeline = { device, scorePipeline, colormapPipeline, scoreBindGroupLayout, colormapBindGroupLayout };
  console.log('[gpuRenderer] Pipelines compiled successfully');
  return _pipeline;
}

/* ── Buffer helpers ──────────────────────────────────────────────── */

function createStorageBuffer(device: GPUDevice, data: ArrayBuffer, label: string): GPUBuffer {
  const buf = device.createBuffer({
    label,
    size: Math.max(4, data.byteLength),
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
    mappedAtCreation: true,
  });
  new Uint8Array(buf.getMappedRange()).set(new Uint8Array(data));
  buf.unmap();
  return buf;
}

function createUniformBuffer(device: GPUDevice, data: ArrayBuffer, label: string): GPUBuffer {
  // Uniform buffers must be 16-byte aligned
  const alignedSize = Math.ceil(data.byteLength / 16) * 16;
  const buf = device.createBuffer({
    label,
    size: Math.max(16, alignedSize),
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    mappedAtCreation: true,
  });
  new Uint8Array(buf.getMappedRange(0, data.byteLength)).set(new Uint8Array(data));
  buf.unmap();
  return buf;
}

function createReadbackBuffer(device: GPUDevice, size: number, label: string): GPUBuffer {
  return device.createBuffer({
    label,
    size: Math.max(4, size),
    usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
  });
}

/* ── Public GPU render API ───────────────────────────────────────── */

import type { LayerConfigs } from '../types/transferFunction';
import type { LayerMeta, LayerId } from '../types';
import type { MunicipalityLUT } from './variableGrids';
import type { DemViewportSamples } from './demSlope';
import { buildAspectScoreLut } from './transferFunction';
import { ALL_MUNICIPALITY_VARS } from './variableGrids';

/** Map layer IDs to their variable index in the LUT texture. */
function buildVarIndexMap(): Map<string, number> {
  const map = new Map<string, number>();
  for (let i = 0; i < ALL_MUNICIPALITY_VARS.length; i++) {
    map.set(ALL_MUNICIPALITY_VARS[i], i);
  }
  return map;
}

const VAR_INDEX_MAP = buildVarIndexMap();

/**
 * Resolve the TF config for a layer ID. Mirrors getLayerTf in gridFormulaEngine.
 */
function getLayerTf(id: LayerId | string, configs: LayerConfigs) {
  switch (id) {
    case 'terrainSlope':     return configs.terrain.slope.tf;
    case 'terrainElevation': return configs.terrain.elevation.tf;
    case 'terrainAspect':    return null;
    case 'votesLeft':        return configs.votes.terms.find(t => t.metric === 'leftPct')?.value.tf ?? null;
    case 'votesRight':       return configs.votes.terms.find(t => t.metric === 'rightPct')?.value.tf ?? null;
    case 'votesIndep':       return configs.votes.terms.find(t => t.metric === 'independencePct')?.value.tf ?? null;
    case 'votesUnionist':    return configs.votes.terms.find(t => t.metric === 'unionistPct')?.value.tf ?? null;
    case 'votesTurnout':     return configs.votes.terms.find(t => t.metric === 'turnoutPct')?.value.tf ?? null;
    case 'votesERC':         return configs.partyVotes.terms.find(t => t.metric === 'ercPct')?.value.tf ?? null;
    case 'votesCUP':         return configs.partyVotes.terms.find(t => t.metric === 'cupPct')?.value.tf ?? null;
    case 'votesPODEM':       return configs.partyVotes.terms.find(t => t.metric === 'podemPct')?.value.tf ?? null;
    case 'votesJUNTS':       return configs.partyVotes.terms.find(t => t.metric === 'juntsPct')?.value.tf ?? null;
    case 'votesCOMUNS':      return configs.partyVotes.terms.find(t => t.metric === 'comunsPct')?.value.tf ?? null;
    case 'votesPP':          return configs.partyVotes.terms.find(t => t.metric === 'ppPct')?.value.tf ?? null;
    case 'votesVOX':         return configs.partyVotes.terms.find(t => t.metric === 'voxPct')?.value.tf ?? null;
    case 'votesPSC':         return configs.partyVotes.terms.find(t => t.metric === 'pscPct')?.value.tf ?? null;
    case 'votesCs':          return configs.partyVotes.terms.find(t => t.metric === 'csPct')?.value.tf ?? null;
    case 'votesPDeCAT':      return configs.partyVotes.terms.find(t => t.metric === 'pdecatPct')?.value.tf ?? null;
    case 'votesCiU':         return configs.partyVotes.terms.find(t => t.metric === 'ciuPct')?.value.tf ?? null;
    case 'votesOtherParties': return configs.partyVotes.terms.find(t => t.metric === 'otherPartiesPct')?.value.tf ?? null;
    case 'transit':          return configs.transit.tf;
    case 'forest':           return configs.forest.tf;
    case 'airQualityPm10':   return configs.airQuality.pm10.tf;
    case 'airQualityNo2':    return configs.airQuality.no2.tf;
    case 'crime':            return configs.crime.tf;
    case 'healthcare':       return configs.healthcare.tf;
    case 'schools':          return configs.schools.tf;
    case 'internet':         return configs.internet.tf;
    case 'climateTemp':      return configs.climate.temperature.tf;
    case 'climateRainfall':  return configs.climate.rainfall.tf;
    case 'rentalPrices':     return configs.rentalPrices.tf;
    case 'employment':       return configs.employment.tf;
    case 'amenities':        return configs.amenities.tf;
    default: {
      if (typeof id === 'string' && id.startsWith('axis_')) {
        const axisId = id.slice(5);
        return configs.axisConfigs?.[axisId]?.tf ?? null;
      }
      return null;
    }
  }
}

/** Shape string to numeric enum for WGSL. */
function shapeToU32(shape: string): number {
  switch (shape) {
    case 'sin':      return 0;
    case 'invsin':   return 1;
    case 'range':    return 2;
    case 'invrange': return 3;
    default:         return 0;
  }
}

/**
 * Build the flat LUT buffer: [numVars × featureCount] Float32Array.
 * Each variable occupies a contiguous block of featureCount floats.
 * NaN values are replaced with NAN_SENTINEL (-99999).
 */
function buildFlatLUT(lut: MunicipalityLUT, featureCount: number): Float32Array {
  const varNames = ALL_MUNICIPALITY_VARS;
  const numVars = varNames.length;
  const flat = new Float32Array(numVars * featureCount);
  flat.fill(-99999); // NAN_SENTINEL default

  for (let vi = 0; vi < numVars; vi++) {
    const arr = lut[varNames[vi]];
    if (!arr) continue;
    const offset = vi * featureCount;
    for (let fi = 0; fi < Math.min(arr.length, featureCount); fi++) {
      const v = arr[fi];
      flat[offset + fi] = (v !== v) ? -99999 : v; // NaN -> sentinel
    }
  }
  return flat;
}

/**
 * Build the layer params buffer for the GPU.
 * Each layer: 8 x f32 = 32 bytes (matching the WGSL struct).
 */
function buildLayerParamsBuffer(
  enabledLayers: LayerMeta[],
  configs: LayerConfigs,
): { data: Float32Array; count: number } {
  const count = Math.min(enabledLayers.length, MAX_LAYERS);
  // Each LayerParams struct: 8 x 4 bytes = 32 bytes
  const data = new Float32Array(count * 8);

  for (let i = 0; i < count; i++) {
    const layer = enabledLayers[i];
    const offset = i * 8;

    if (layer.id === 'terrainAspect') {
      // Aspect layer: varIndex = -3
      data[offset + 0] = 0;   // plateauEnd (unused for aspect)
      data[offset + 1] = 1;   // decayEnd
      data[offset + 2] = 1;   // ceiling
      data[offset + 3] = 0;   // floor
      data[offset + 4] = layer.weight;
      const u32View = new Uint32Array(data.buffer, data.byteOffset + offset * 4, 8);
      u32View[5] = 0;         // shape
      u32View[6] = 0;         // mandatory
      const i32View = new Int32Array(data.buffer, data.byteOffset + offset * 4, 8);
      i32View[7] = -3;        // varIndex = aspect
      continue;
    }

    const tf = getLayerTf(layer.id, configs);
    if (!tf) {
      // Disabled / no TF — set weight to 0 so it's skipped
      data[offset + 4] = 0;
      continue;
    }

    data[offset + 0] = tf.plateauEnd;
    data[offset + 1] = tf.decayEnd;
    data[offset + 2] = tf.ceiling ?? 1;
    data[offset + 3] = tf.floor;
    data[offset + 4] = layer.weight;

    // Write u32/i32 fields using typed array views
    const u32View = new Uint32Array(data.buffer, data.byteOffset + offset * 4, 8);
    u32View[5] = shapeToU32(tf.shape);
    u32View[6] = tf.mandatory ? 1 : 0;

    // Determine varIndex
    let varIndex: number;
    if (layer.id === 'terrainSlope') {
      varIndex = -1;
    } else if (layer.id === 'terrainElevation') {
      varIndex = -2;
    } else {
      varIndex = VAR_INDEX_MAP.get(layer.id) ?? -4; // -4 = not found, will be skipped
    }
    const i32View = new Int32Array(data.buffer, data.byteOffset + offset * 4, 8);
    i32View[7] = varIndex;
  }

  return { data, count };
}

/**
 * Pack terrain data into interleaved [slope, elevation, aspect] per pixel.
 * aspect stored as float code (0-255).
 */
function packTerrainData(
  dem: DemViewportSamples,
  n: number,
): { terrainBuf: Float32Array; hasDataBuf: Uint32Array } {
  const terrainBuf = new Float32Array(n * 3);
  // Pack hasData as u32 array (4 bytes per u32)
  const packedLen = Math.ceil(n / 4);
  const hasDataBuf = new Uint32Array(packedLen);

  for (let i = 0; i < n; i++) {
    terrainBuf[i * 3] = dem.slopes[i];
    terrainBuf[i * 3 + 1] = dem.elevations[i];
    terrainBuf[i * 3 + 2] = dem.aspects[i]; // Uint8 code as float

    // Pack hasData
    if (dem.hasData[i]) {
      const wordIdx = Math.floor(i / 4);
      const byteIdx = i % 4;
      hasDataBuf[wordIdx] |= (1 << (byteIdx * 8));
    }
  }

  return { terrainBuf, hasDataBuf };
}

export interface GpuRenderRequest {
  membershipRaster: Int16Array;
  lut: MunicipalityLUT;
  featureCount: number;
  enabledLayers: LayerMeta[];
  configs: LayerConfigs;
  cols: number;
  rows: number;
  demSamples: DemViewportSamples | null;
  disqualifiedMask: 'black' | 'transparent';
  aspectPrefs: import('../types/transferFunction').AspectPreferences;
  aspectWeight: number;
}

export interface GpuRenderResult {
  pixels: Uint8ClampedArray;
  minScore: number;
  maxScore: number;
}

/**
 * Run the full scoring + colormap pipeline on the GPU.
 *
 * @returns RGBA pixel data, or null if GPU is unavailable.
 */
export async function gpuRenderScoreGrid(
  req: GpuRenderRequest,
): Promise<GpuRenderResult | null> {
  const device = await initGpuDevice();
  if (!device) return null;

  const pipeline = await ensurePipeline(device);
  const n = req.cols * req.rows;

  // Build CPU-side buffers
  const flatLut = buildFlatLUT(req.lut, req.featureCount);
  const { data: layerParamsData, count: layerCount } = buildLayerParamsBuffer(
    req.enabledLayers, req.configs,
  );

  const hasTerrain = req.demSamples !== null;
  const { terrainBuf, hasDataBuf } = hasTerrain
    ? packTerrainData(req.demSamples!, n)
    : { terrainBuf: new Float32Array(4), hasDataBuf: new Uint32Array(1) };

  // Build aspect LUT (256 floats)
  const aspectLutData = buildAspectScoreLut(req.aspectPrefs);

  // Uniforms: { numPixels, numLayers, numVars, featureCount, hasTerrain, maskMode, pad, pad }
  const uniformData = new ArrayBuffer(32);
  const uniformU32 = new Uint32Array(uniformData);
  uniformU32[0] = n;
  uniformU32[1] = layerCount;
  uniformU32[2] = ALL_MUNICIPALITY_VARS.length;
  uniformU32[3] = req.featureCount;
  uniformU32[4] = hasTerrain ? 1 : 0;
  uniformU32[5] = req.disqualifiedMask === 'black' ? 0 : 1;

  // ── Create GPU buffers ──
  // Membership raster: convert Int16 -> Int32 for GPU compatibility
  const memberI32 = new Int32Array(n);
  for (let i = 0; i < n; i++) memberI32[i] = req.membershipRaster[i];

  const membershipBuf = createStorageBuffer(device, memberI32.buffer as ArrayBuffer, 'membership');
  const lutBuf = createStorageBuffer(device, flatLut.buffer as ArrayBuffer, 'lut');
  const uniformBuf = createUniformBuffer(device, uniformData, 'uniforms');
  const terrainDataBuf = createStorageBuffer(device, terrainBuf.buffer as ArrayBuffer, 'terrainData');
  const hasDataPackedBuf = createStorageBuffer(device, hasDataBuf.buffer as ArrayBuffer, 'hasDataPacked');
  const layerParamsBuf = createStorageBuffer(device, layerParamsData.buffer as ArrayBuffer, 'layerParams');
  const aspectLutBuf = createStorageBuffer(device, aspectLutData.buffer as ArrayBuffer, 'aspectLut');

  // Score output buffer (read-write storage)
  const scoreBuf = device.createBuffer({
    label: 'scores',
    size: n * 4,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
  });

  // Pixel output buffer
  const pixelBuf = device.createBuffer({
    label: 'pixels',
    size: n * 4,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
  });

  // Readback buffer
  const readbackBuf = createReadbackBuffer(device, n * 4, 'readback');

  // ── Score pass ──
  const scoreBindGroup = device.createBindGroup({
    layout: pipeline.scoreBindGroupLayout,
    entries: [
      { binding: 0, resource: { buffer: membershipBuf } },
      { binding: 1, resource: { buffer: lutBuf } },
      { binding: 2, resource: { buffer: uniformBuf } },
      { binding: 3, resource: { buffer: scoreBuf } },
      { binding: 4, resource: { buffer: terrainDataBuf } },
      { binding: 5, resource: { buffer: hasDataPackedBuf } },
      { binding: 6, resource: { buffer: layerParamsBuf } },
      { binding: 7, resource: { buffer: aspectLutBuf } },
    ],
  });

  // ── Colormap pass ──
  const colorUniformData = new ArrayBuffer(16);
  const colorU32 = new Uint32Array(colorUniformData);
  colorU32[0] = n;
  colorU32[1] = req.disqualifiedMask === 'black' ? 0 : 1;
  const colorUniformBuf = createUniformBuffer(device, colorUniformData, 'colorUniforms');

  const colormapBindGroup = device.createBindGroup({
    layout: pipeline.colormapBindGroupLayout,
    entries: [
      { binding: 0, resource: { buffer: scoreBuf } },
      { binding: 1, resource: { buffer: pixelBuf } },
      { binding: 2, resource: { buffer: colorUniformBuf } },
    ],
  });

  // ── Dispatch ──
  const workgroupCount = Math.ceil(n / 256);

  // Push error scope to capture validation errors
  device.pushErrorScope('validation');

  const encoder = device.createCommandEncoder({ label: 'heatmap' });

  const scorePass = encoder.beginComputePass({ label: 'score' });
  scorePass.setPipeline(pipeline.scorePipeline);
  scorePass.setBindGroup(0, scoreBindGroup);
  scorePass.dispatchWorkgroups(workgroupCount);
  scorePass.end();

  const colormapPass = encoder.beginComputePass({ label: 'colormap' });
  colormapPass.setPipeline(pipeline.colormapPipeline);
  colormapPass.setBindGroup(0, colormapBindGroup);
  colormapPass.dispatchWorkgroups(workgroupCount);
  colormapPass.end();

  // Copy pixels to readback buffer
  encoder.copyBufferToBuffer(pixelBuf, 0, readbackBuf, 0, n * 4);

  // Also copy scores to a second readback buffer for accurate min/max
  const scoreReadbackBuf = createReadbackBuffer(device, n * 4, 'scoreReadback');
  encoder.copyBufferToBuffer(scoreBuf, 0, scoreReadbackBuf, 0, n * 4);

  device.queue.submit([encoder.finish()]);

  // Check for validation errors
  const validationError = await device.popErrorScope();
  if (validationError) {
    console.error('[gpuRenderer] GPU validation error:', validationError.message);
    scoreReadbackBuf.destroy();
    throw new Error(`GPU validation error: ${validationError.message}`);
  }

  // ── Read back results ──
  await Promise.all([
    readbackBuf.mapAsync(GPUMapMode.READ),
    scoreReadbackBuf.mapAsync(GPUMapMode.READ),
  ]);

  const resultData = new Uint8ClampedArray(readbackBuf.getMappedRange().slice(0));
  readbackBuf.unmap();

  const scoreData = new Float32Array(scoreReadbackBuf.getMappedRange().slice(0));
  scoreReadbackBuf.unmap();

  // Safety: if output is all-transparent, something went wrong — trigger fallback
  let nonZeroPixels = 0;
  for (let i = 0; i < n; i++) {
    if (resultData[i * 4 + 3] > 0) { nonZeroPixels++; break; }
  }
  if (nonZeroPixels === 0) {
    console.error('[gpuRenderer] GPU produced all-transparent output — falling back to CPU');
    // Cleanup before throwing
    membershipBuf.destroy(); lutBuf.destroy(); uniformBuf.destroy();
    scoreBuf.destroy(); terrainDataBuf.destroy(); hasDataPackedBuf.destroy();
    layerParamsBuf.destroy(); aspectLutBuf.destroy(); pixelBuf.destroy();
    readbackBuf.destroy(); colorUniformBuf.destroy(); scoreReadbackBuf.destroy();
    throw new Error('GPU produced all-transparent output');
  }

  // ── Cleanup GPU buffers ──
  membershipBuf.destroy();
  lutBuf.destroy();
  uniformBuf.destroy();
  scoreBuf.destroy();
  terrainDataBuf.destroy();
  hasDataPackedBuf.destroy();
  layerParamsBuf.destroy();
  aspectLutBuf.destroy();
  pixelBuf.destroy();
  readbackBuf.destroy();
  colorUniformBuf.destroy();
  scoreReadbackBuf.destroy();

  // Compute accurate min/max from the score readback
  let minScore = Infinity;
  let maxScore = -Infinity;
  for (let i = 0; i < n; i++) {
    const s = scoreData[i];
    if (s <= -99998) continue;   // NaN sentinel
    if (s > -2.5 && s < -1.5) continue; // DISQUALIFIED sentinel
    if (s < minScore) minScore = s;
    if (s > maxScore) maxScore = s;
  }

  if (minScore === Infinity) { minScore = 0; maxScore = 1; }

  return {
    pixels: resultData,
    minScore,
    maxScore,
  };
}

/**
 * Dispose the GPU device and pipelines. Call when cleaning up.
 */
export function disposeGpu(): void {
  _pipeline = null;
  if (_gpuDevice) {
    _gpuDevice.destroy();
    _gpuDevice = null;
  }
}
