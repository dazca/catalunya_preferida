/**
 * @file Variable grids — build Float32Array grids for each scoring variable
 *       from the municipality membership raster + per-municipality data LUTs.
 *
 * ## Architecture
 *
 * 1. **MunicipalityLUT**: `Float32Array[featureCount]` per variable.
 *    Indexed by GeoJSON feature index (same as membership raster).
 *    Built once from `MunicipalityData`, ~75 KB for 947 municipalities × 20 vars.
 *
 * 2. **buildVariableGrid()**: O(1) lookup per pixel — reads membership raster
 *    index, then indexes into the LUT.  Produces a `Float32Array[cols×rows]`.
 *
 * 3. **Terrain grids**: slope/elevation/aspect come directly from DEM
 *    sampling, not from LUTs (per-pixel, not per-municipality).
 */
import type { MunicipalityCollection } from '../types';
import type { MunicipalityData } from './scorer';
import { normalizeIne } from './scorer';

/* ── Variable identifiers ──────────────────────────────────────────── */

/**
 * All per-municipality variable names the grid system can produce.
 * Terrain variables (slope, elevation, aspect) are excluded — they come
 * from DEM grids, not LUTs.
 */
export const MUNICIPALITY_VARS = [
  'votesLeft',
  'votesRight',
  'votesIndep',
  'votesUnionist',
  'votesTurnout',
  'transit',
  'forest',
  'airQualityPm10',
  'airQualityNo2',
  'crime',
  'healthcare',
  'schools',
  'internet',
  'climateTemp',
  'climateRainfall',
  'rentalPrices',
  'employment',
  'amenities',
] as const;

export type MunicipalityVarName = (typeof MUNICIPALITY_VARS)[number];

/* ── LUT builder ───────────────────────────────────────────────────── */

/** Per-variable lookup table: Float32Array indexed by feature-index. */
export type MunicipalityLUT = Record<MunicipalityVarName, Float32Array>;

/**
 * Build a LUT mapping feature-index → raw variable value for every
 * per-municipality variable.  NaN for missing data.
 *
 * @param municipalities  GeoJSON FeatureCollection (defines feature ordering)
 * @param data            Municipality data tables
 * @returns One Float32Array per variable, indexed by feature-index
 */
export function buildMunicipalityLUT(
  municipalities: MunicipalityCollection,
  data: MunicipalityData,
): MunicipalityLUT {
  const n = municipalities.features.length;

  // Allocate all arrays once (filled with NaN = missing)
  const lut = {} as MunicipalityLUT;
  for (const varName of MUNICIPALITY_VARS) {
    lut[varName] = new Float32Array(n).fill(NaN);
  }

  for (let i = 0; i < n; i++) {
    const codi = municipalities.features[i].properties?.codi;
    if (!codi) continue;
    const key = normalizeIne(codi);

    // Votes
    const v = data.votes[key];
    if (v) {
      lut.votesLeft[i]     = v.leftPct ?? NaN;
      lut.votesRight[i]    = v.rightPct ?? NaN;
      lut.votesIndep[i]    = v.independencePct ?? NaN;
      lut.votesUnionist[i] = v.unionistPct ?? NaN;
      lut.votesTurnout[i]  = v.turnoutPct ?? NaN;
    }

    // Distance-based
    lut.transit[i]     = data.transitDistKm[key] ?? NaN;
    lut.healthcare[i]  = data.healthcareDistKm[key] ?? NaN;
    lut.schools[i]     = data.schoolDistKm[key] ?? NaN;
    lut.amenities[i]   = data.amenityDistKm[key] ?? NaN;

    // Forest
    const f = data.forest[key];
    if (f) lut.forest[i] = f.forestPct ?? NaN;

    // Air quality
    const a = data.airQuality[key];
    if (a) {
      lut.airQualityPm10[i] = a.pm10 ?? NaN;
      lut.airQualityNo2[i]  = a.no2 ?? NaN;
    }

    // Crime
    const cr = data.crime[key];
    if (cr) lut.crime[i] = cr.ratePerThousand ?? NaN;

    // Internet
    const net = data.internet[key];
    if (net) lut.internet[i] = net.fiberPct ?? NaN;

    // Climate
    const cl = data.climate[key];
    if (cl) {
      lut.climateTemp[i]     = cl.avgTempC ?? NaN;
      lut.climateRainfall[i] = cl.avgRainfallMm ?? NaN;
    }

    // Rental
    const re = data.rentalPrices[key];
    if (re) lut.rentalPrices[i] = re.avgEurMonth ?? NaN;

    // Employment
    const em = data.employment[key];
    if (em) lut.employment[i] = em.unemploymentPct ?? NaN;
  }

  return lut;
}

/* ── Grid factory ──────────────────────────────────────────────────── */

/**
 * Build a Float32Array grid for one municipality-level variable.
 *
 * For each pixel, reads the membership raster to get the feature index,
 * then indexes into the LUT. O(1) per pixel, no PiP at all.
 *
 * @param membershipRaster  Int16Array from `rasteriseMunicipalities()`
 * @param lut               Float32Array[featureCount] for the target variable
 * @param cols              Grid width
 * @param rows              Grid height
 * @returns Float32Array[cols×rows] with raw variable values (NaN = no data)
 */
export function buildVariableGrid(
  membershipRaster: Int16Array,
  lut: Float32Array,
  cols: number,
  rows: number,
): Float32Array {
  const n = cols * rows;
  const grid = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const fi = membershipRaster[i];
    grid[i] = fi >= 0 ? lut[fi] : NaN;
  }
  return grid;
}

/**
 * Build variable grids for all municipality-level variables at once.
 *
 * @param membershipRaster  Int16Array from `rasteriseMunicipalities()`
 * @param municipalityLUT   Per-variable LUTs from `buildMunicipalityLUT()`
 * @param cols              Grid width
 * @param rows              Grid height
 * @returns Record of variable name → Float32Array grid
 */
export function buildAllVariableGrids(
  membershipRaster: Int16Array,
  municipalityLUT: MunicipalityLUT,
  cols: number,
  rows: number,
): Record<MunicipalityVarName, Float32Array> {
  const grids = {} as Record<MunicipalityVarName, Float32Array>;
  for (const varName of MUNICIPALITY_VARS) {
    grids[varName] = buildVariableGrid(membershipRaster, municipalityLUT[varName], cols, rows);
  }
  return grids;
}

/* ── Buffer pool ───────────────────────────────────────────────────── */

/**
 * Simple typed-array buffer pool to avoid GC pressure in the hot path.
 * Reuses Float32Array buffers of matching length.
 */
const _pool: Float32Array[] = [];
const MAX_POOL_SIZE = 16;

export function acquireFloat32(length: number): Float32Array {
  for (let i = _pool.length - 1; i >= 0; i--) {
    if (_pool[i].length === length) {
      return _pool.splice(i, 1)[0];
    }
  }
  return new Float32Array(length);
}

export function releaseFloat32(buf: Float32Array): void {
  if (_pool.length < MAX_POOL_SIZE) {
    buf.fill(0);
    _pool.push(buf);
  }
}
