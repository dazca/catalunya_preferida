/**
 * @file Fill data gaps in municipality datasets by computing comarca-level
 *       (regional) medians as fallback values.
 *
 * Strategy: for each numeric field, group municipalities by their comarca,
 * compute the median of available values, and assign the median to any
 * municipality in that comarca that is missing the value.  If the entire
 * comarca is missing, fall back to the Catalonia-wide median.
 */

import type { Feature, Geometry } from 'geojson';
import type { MunicipalityProperties } from '../types';

/** Build a mapping from municipality codi to its comarca. */
export function buildCodiToComarca(
  features: Feature<Geometry, MunicipalityProperties>[],
): Record<string, string> {
  const map: Record<string, string> = {};
  for (const f of features) {
    const codi = f.properties?.codi;
    const comarca = f.properties?.comarca;
    if (codi && comarca) map[codi] = comarca;
  }
  return map;
}

/** Compute the median of a numeric array (returns 0 for empty). */
export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

/**
 * For a single Record<string, number> data map, fill missing codis using
 * comarca median fallback.
 *
 * @param data       Current data map (codi -> value)
 * @param allCodis   All municipality codis that should have a value
 * @param codiToComarca  Mapping from codi to comarca name
 * @returns New data map with gaps filled
 */
export function fillGapsWithComarcaMedian(
  data: Record<string, number>,
  allCodis: string[],
  codiToComarca: Record<string, string>,
): Record<string, number> {
  // Group existing values by comarca
  const comarcaValues: Record<string, number[]> = {};
  const allValues: number[] = [];

  for (const [codi, val] of Object.entries(data)) {
    if (val === undefined || val === null || isNaN(val)) continue;
    allValues.push(val);
    const comarca = codiToComarca[codi];
    if (comarca) {
      if (!comarcaValues[comarca]) comarcaValues[comarca] = [];
      comarcaValues[comarca].push(val);
    }
  }

  // Compute medians per comarca
  const comarcaMedians: Record<string, number> = {};
  for (const [com, vals] of Object.entries(comarcaValues)) {
    comarcaMedians[com] = median(vals);
  }
  const globalMedian = median(allValues);

  // Build filled data map
  const filled: Record<string, number> = { ...data };
  for (const codi of allCodis) {
    if (filled[codi] !== undefined && !isNaN(filled[codi])) continue;
    const comarca = codiToComarca[codi];
    filled[codi] = (comarca && comarcaMedians[comarca] !== undefined)
      ? comarcaMedians[comarca]
      : globalMedian;
  }
  return filled;
}

/**
 * Apply comarca-median defaults to a numeric distance map.
 * Useful for transitDistKm, healthcareDistKm, schoolDistKm, amenityDistKm.
 */
export function fillDistanceDefaults(
  data: Record<string, number>,
  allCodis: string[],
  codiToComarca: Record<string, string>,
): Record<string, number> {
  return fillGapsWithComarcaMedian(data, allCodis, codiToComarca);
}
