/**
 * @file TransferFunction evaluator and DataStats computation.
 *
 * Core math for the sinusoidal decay curve:
 *   input <= plateauEnd → 1.0
 *   plateauEnd < input < decayEnd → floor + (1-floor) * 0.5 * (1 + cos(π·t))
 *   input >= decayEnd → floor
 *
 * When `invert` is true, the input axis is flipped so lower values yield
 * higher scores (used for distance, cost, pollution metrics).
 */
import type { TransferFunction, DataStats, AspectPreferences } from '../types/transferFunction';

/**
 * Evaluate a transfer function for a given raw input value.
 *
 * @param input - Raw data value (e.g., distance in km, temperature in °C)
 * @param tf - Transfer function parameters
 * @returns Score in [floor, 1.0]
 */
export function evaluateTransferFunction(input: number, tf: TransferFunction): number {
  const { plateauEnd, decayEnd, floor, invert } = tf;

  // Invert: flip so that lower raw values get higher scores
  let x = input;
  if (invert) {
    x = decayEnd - (input - plateauEnd);
    // After inversion, the effective curve is:
    //   input <= plateauEnd → high score (mapped to decayEnd side)
    //   input >= decayEnd → low score (mapped to plateauEnd side)
    // Simplify: just swap effective boundaries
  }

  // Normalize for the sinusoidal curve (non-inverted logic)
  if (!invert) {
    if (x <= plateauEnd) return 1.0;
    if (x >= decayEnd) return floor;
    const t = (x - plateauEnd) / (decayEnd - plateauEnd);
    return floor + (1 - floor) * 0.5 * (1 + Math.cos(Math.PI * t));
  }

  // Inverted: lower input = better. plateauEnd is the "good" threshold,
  // decayEnd is the "bad" threshold. We compute t based on original input.
  if (input <= plateauEnd) return 1.0;
  if (input >= decayEnd) return floor;
  const t = (input - plateauEnd) / (decayEnd - plateauEnd);
  return floor + (1 - floor) * 0.5 * (1 + Math.cos(Math.PI * t));
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
