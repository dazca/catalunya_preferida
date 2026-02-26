/**
 * @file TransferFunction evaluator and DataStats computation.
 *
 * Core math for each shape (M = plateauEnd, N = decayEnd):
 *
 *   sin:      ≤M→1, M→N half-cosine decay→floor, ≥N→floor
 *   invsin:   ≤M→floor, M→N half-cosine rise→1, ≥N→1
 *   range:    ≤M→1, M→N linear decay→floor, ≥N→floor
 *   invrange: ≤M→floor, M→N linear rise→1, ≥N→1
 */
import type { TransferFunction, DataStats, AspectPreferences } from '../types/transferFunction';

/**
 * Sentinel value in Uint8 aspect encoding indicating flat terrain
 * (gradient magnitude ≈ 0 → no meaningful aspect direction).
 * Scoring functions return 0.5 (neutral) for this value.
 */
export const ASPECT_FLAT: number = 255;

/**
 * Evaluate a transfer function for a given raw input value.
 *
 * @param input - Raw data value (e.g., distance in km, temperature in °C)
 * @param tf - Transfer function parameters
 * @returns Score in [floor, 1.0]
 */
export function evaluateTransferFunction(input: number, tf: TransferFunction): number {
  const { plateauEnd: M, decayEnd: N, floor, shape } = tf;
  const high = tf.ceiling ?? 1.0;
  const low = floor;
  const span = N - M;

  if (Math.abs(span) < 1e-9) {
    // Degenerate: M ≈ N
    const isInv = shape === 'invsin' || shape === 'invrange';
    return isInv ? (input >= N ? high : low) : (input <= M ? high : low);
  }

  const t = Math.max(0, Math.min(1, (input - M) / span)); // 0 at M, 1 at N

  switch (shape) {
    case 'sin':
    default:
      if (input <= M) return high;
      if (input >= N) return low;
      return low + (high - low) * 0.5 * (1 + Math.cos(Math.PI * t));

    case 'invsin':
      if (input <= M) return low;
      if (input >= N) return high;
      return low + (high - low) * 0.5 * (1 - Math.cos(Math.PI * t));

    case 'range':
      if (input <= M) return high;
      if (input >= N) return low;
      return high - (high - low) * t;

    case 'invrange':
      if (input <= M) return low;
      if (input >= N) return high;
      return low + (high - low) * t;
  }
}

/**
 * Compute percentile from a sorted array.
 *
 * @param sorted - Sorted numeric array (ascending)
 * @param p - Percentile (0-1)
 * @returns Interpolated percentile value
 */
function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0];
  const idx = p * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

/**
 * Compute descriptive statistics from an array of numeric values.
 *
 * @param values - Raw numeric data points
 * @param unit - Display unit label (e.g., "km", "°C", "EUR/mo")
 * @returns DataStats object with min, max, percentiles, median
 */
export function computeDataStats(values: number[], unit: string): DataStats {
  if (values.length === 0) {
    return { min: 0, max: 0, p25: 0, median: 0, p75: 0, unit, count: 0 };
  }

  const sorted = [...values].sort((a, b) => a - b);
  return {
    min: sorted[0],
    max: sorted[sorted.length - 1],
    p25: percentile(sorted, 0.25),
    median: percentile(sorted, 0.5),
    p75: percentile(sorted, 0.75),
    unit,
    count: sorted.length,
  };
}

/**
 * Score a terrain aspect direction (N, S, E, etc.) using wind-rose preferences.
 *
 * @param aspect - Cardinal or intercardinal direction string
 * @param prefs - Wind-rose aspect preferences (0-1 per direction)
 * @returns Score 0-1
 */
export function scoreAspect(aspect: string, prefs: AspectPreferences): number {
  const key = aspect.toUpperCase() as keyof AspectPreferences;
  return prefs[key] ?? 0.5;
}

/* ── Wind-rose direction order for interpolation ──────────────────── */
const WIND_ROSE_KEYS: readonly (keyof AspectPreferences)[] =
  ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'] as const;

/**
 * Score a continuous aspect angle (0-360°) with smooth cosine interpolation
 * between the two nearest wind-rose directions.
 *
 * @param angleDeg - Aspect angle in degrees, 0°=N clockwise (0-360)
 * @param prefs - Wind-rose aspect preferences (0-1 per direction)
 * @returns Score 0-1
 */
export function scoreAspectAngle(angleDeg: number, prefs: AspectPreferences): number {
  // Flat-terrain sentinel → neutral score
  if (angleDeg < 0) return 0.5;

  // Normalise to [0, 360)
  let a = angleDeg % 360;
  if (a < 0) a += 360;

  const sector = Math.floor(a / 45);         // 0-7
  const frac   = (a - sector * 45) / 45;     // [0, 1) position within sector

  const w0 = prefs[WIND_ROSE_KEYS[sector]];
  const w1 = prefs[WIND_ROSE_KEYS[(sector + 1) % 8]];

  // Cosine interpolation: smooth blend between neighbours
  const t = 0.5 * (1 - Math.cos(frac * Math.PI));
  return w0 * (1 - t) + w1 * t;
}

/**
 * Build a 256-entry LUT mapping aspect codes (0-255) to scores
 * using smooth cosine interpolation between wind-rose preferences.
 *
 * @param prefs - Wind-rose aspect preferences
 * @returns Float32Array of 256 interpolated scores
 */
export function buildAspectScoreLut(prefs: AspectPreferences): Float32Array {
  const lut = new Float32Array(256);
  for (let i = 0; i < 255; i++) {
    lut[i] = scoreAspectAngle(i * 360 / 255, prefs);
  }
  // Sentinel 255 = flat terrain → neutral
  lut[ASPECT_FLAT] = 0.5;
  return lut;
}
