/**
 * @file Scoring engine: computes a 0-1 score per municipality using
 *       TransferFunction-based configs for sinusoidal decay curves.
 *       Each layer extracts raw values and passes them through the TF evaluator.
 */
import type { LayerId, LayerMeta } from '../types';
import type {
  LayerConfigs,
  LayerTransferConfig,
} from '../types/transferFunction';
import {
  evaluateTransferFunction,
  scoreAspect,
} from './transferFunction';
import type {
  VoteSentiment,
  TerrainStats,
  ForestCover,
  CrimeRate,
  RentalPrice,
  EmploymentData,
  ClimateStats,
  AirQualityReading,
  InternetCoverage,
} from '../types';

/** Data lookup tables keyed by municipality codi (5-digit INE) */
export interface MunicipalityData {
  terrain: Record<string, TerrainStats>;
  votes: Record<string, VoteSentiment>;
  forest: Record<string, ForestCover>;
  crime: Record<string, CrimeRate>;
  rentalPrices: Record<string, RentalPrice>;
  employment: Record<string, EmploymentData>;
  climate: Record<string, ClimateStats>;
  airQuality: Record<string, AirQualityReading>;
  internet: Record<string, InternetCoverage>;
  transitDistKm: Record<string, number>;
  healthcareDistKm: Record<string, number>;
  schoolDistKm: Record<string, number>;
  amenityDistKm: Record<string, number>;
}

/**
 * Normalize any municipality code variant to 5-digit INE code.
 */
export function normalizeIne(code: string): string {
  return code.substring(0, 5);
}

/** Clamp value to [0, 1]. */
export function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

// ── Sub-score helpers ──────────────────────────────────────────────────

export interface SubResult {
  score: number;
  weight: number;
  disqualified: boolean;
}

/**
 * Evaluate a single sub-layer value through its transfer function.
 * Returns null if the sub-layer is disabled or the value is missing.
 */
export function scoreSingleTf(
  value: number | undefined,
  ltc: LayerTransferConfig,
): SubResult | null {
  if (!ltc.enabled || value === undefined) return null;
  const score = evaluateTransferFunction(value, ltc.tf);
  return {
    score,
    weight: ltc.tf.multiplier,
    disqualified: ltc.tf.mandatory && score <= ltc.tf.floor + 0.001,
  };
}

/**
 * Combine multiple sub-layer results into a single layer score.
 * Score is weighted average of sub-results by their multipliers.
 */
export function combineSubScores(
  results: (SubResult | null)[],
): { score: number; disqualified: boolean } | undefined {
  const valid = results.filter((r): r is SubResult => r !== null);
  if (valid.length === 0) return undefined;

  let totalWeighted = 0;
  let totalWeight = 0;
  let disqualified = false;

  for (const r of valid) {
    totalWeighted += r.score * r.weight;
    totalWeight += r.weight;
    if (r.disqualified) disqualified = true;
  }

  return {
    score: totalWeight > 0 ? totalWeighted / totalWeight : 0,
    disqualified,
  };
}

// ── Per-layer scorers ──────────────────────────────────────────────────

type LayerScorer = (
  codi: string,
  configs: LayerConfigs,
  data: MunicipalityData,
) => { score: number; disqualified: boolean } | undefined;

const SCORERS: Record<LayerId, LayerScorer> = {
  terrain: (codi, configs, data) => {
    const t = data.terrain[normalizeIne(codi)];
    if (!t) return undefined;
    const slope = scoreSingleTf(t.avgSlopeDeg, configs.terrain.slope);
    const elev = scoreSingleTf(t.avgElevationM, configs.terrain.elevation);
    const aspect: SubResult = {
      score: scoreAspect(t.dominantAspect, configs.terrain.aspect),
      weight: configs.terrain.aspectWeight ?? 1,
      disqualified: false,
    };
    return combineSubScores([slope, elev, aspect]);
  },

  votes: (codi, configs, data) => {
    const v = data.votes[normalizeIne(codi)];
    if (!v) return undefined;
    const terms = configs.votes.terms;
    if (!terms || terms.length === 0) return undefined;
    const subs = terms.map((term) => {
      const raw = v[term.metric] as number | undefined;
      return scoreSingleTf(raw, term.value);
    });
    return combineSubScores(subs);
  },

  transit: (codi, configs, data) => {
    const d = data.transitDistKm[normalizeIne(codi)];
    return combineSubScores([scoreSingleTf(d, configs.transit)]);
  },

  forest: (codi, configs, data) => {
    const f = data.forest[normalizeIne(codi)];
    return combineSubScores([scoreSingleTf(f?.forestPct, configs.forest)]);
  },

  soil: () => {
    // No real data — neutral score
    return { score: 0.5, disqualified: false };
  },

  airQuality: (codi, configs, data) => {
    const a = data.airQuality[normalizeIne(codi)];
    if (!a) return undefined;
    const pm10 = scoreSingleTf(a.pm10, configs.airQuality.pm10);
    const no2 = scoreSingleTf(a.no2, configs.airQuality.no2);
    return combineSubScores([pm10, no2]);
  },

  crime: (codi, configs, data) => {
    const c = data.crime[normalizeIne(codi)];
    return combineSubScores([
      scoreSingleTf(c?.ratePerThousand, configs.crime),
    ]);
  },

  healthcare: (codi, configs, data) => {
    const d = data.healthcareDistKm[normalizeIne(codi)];
    return combineSubScores([scoreSingleTf(d, configs.healthcare)]);
  },

  schools: (codi, configs, data) => {
    const d = data.schoolDistKm[normalizeIne(codi)];
    return combineSubScores([scoreSingleTf(d, configs.schools)]);
  },

  internet: (codi, configs, data) => {
    const i = data.internet[normalizeIne(codi)];
    return combineSubScores([scoreSingleTf(i?.fiberPct, configs.internet)]);
  },

  noise: () => {
    return { score: 0.5, disqualified: false };
  },

  climate: (codi, configs, data) => {
    const c = data.climate[normalizeIne(codi)];
    if (!c) return undefined;
    const temp = scoreSingleTf(c.avgTempC, configs.climate.temperature);
    const rain = scoreSingleTf(c.avgRainfallMm, configs.climate.rainfall);
    return combineSubScores([temp, rain]);
  },

  rentalPrices: (codi, configs, data) => {
    const r = data.rentalPrices[normalizeIne(codi)];
    return combineSubScores([scoreSingleTf(r?.avgEurMonth, configs.rentalPrices)]);
  },

  employment: (codi, configs, data) => {
    const e = data.employment[normalizeIne(codi)];
    return combineSubScores([
      scoreSingleTf(e?.unemploymentPct, configs.employment),
    ]);
  },

  amenities: (codi, configs, data) => {
    const d = data.amenityDistKm[normalizeIne(codi)];
    return combineSubScores([scoreSingleTf(d, configs.amenities)]);
  },
};

// ── Public API ─────────────────────────────────────────────────────────

/**
 * Compute the composite score for a single municipality.
 *
 * @param codi - Municipality code (any length; normalized internally)
 * @param enabledLayers - Array of enabled layer metadata (with weights)
 * @param configs - Transfer function configs for all layers
 * @param data - All loaded municipality data
 * @returns Composite score, per-layer breakdown, and disqualification flag
 */
export function computeScore(
  codi: string,
  enabledLayers: LayerMeta[],
  configs: LayerConfigs,
  data: MunicipalityData,
): { score: number; layerScores: Partial<Record<LayerId, number>>; disqualified: boolean } {
  const layerScores: Partial<Record<LayerId, number>> = {};
  let weightedSum = 0;
  let totalWeight = 0;
  let disqualified = false;

  for (const layer of enabledLayers) {
    const scorer = SCORERS[layer.id];
    if (!scorer) continue;

    const result = scorer(codi, configs, data);
    if (!result) continue;

    if (result.disqualified) disqualified = true;

    layerScores[layer.id] = result.score;
    weightedSum += result.score * layer.weight;
    totalWeight += layer.weight;
  }

  const score = disqualified ? 0 : totalWeight > 0 ? weightedSum / totalWeight : 0;
  return { score, layerScores, disqualified };
}

/**
 * Compute the composite score for a single municipality, but substitute
 * real-DEM derived slope / elevation / aspect for the terrain sub-layer.
 *
 * Used by the heatmap renderer and point analysis to produce per-pixel
 * terrain variation rather than municipality-averaged synthetic values.
 *
 * @param codi            Municipality code (used for all non-terrain layers)
 * @param enabledLayers   Enabled layer descriptors with weights
 * @param configs         Transfer function configs
 * @param data            Municipality data tables
 * @param terrainOverride Real DEM values at the target pixel; omit to use
 *                        the municipality average fallback.
 */
export function computeScoreWithTerrainOverride(
  codi: string,
  enabledLayers: LayerMeta[],
  configs: LayerConfigs,
  data: MunicipalityData,
  terrainOverride?: { slopeDeg: number; elevationM: number; aspect?: string },
): { score: number; disqualified: boolean } {
  let weightedSum = 0;
  let totalWeight = 0;
  let disqualified = false;

  for (const layer of enabledLayers) {
    const id = layer.id;
    let result: { score: number; disqualified: boolean } | undefined;

    if (id === 'terrain' && terrainOverride) {
      const slope = scoreSingleTf(terrainOverride.slopeDeg, configs.terrain.slope);
      const elev  = scoreSingleTf(terrainOverride.elevationM, configs.terrain.elevation);
      const aspect: SubResult = {
        score: scoreAspect(terrainOverride.aspect ?? 'N', configs.terrain.aspect),
        weight: configs.terrain.aspectWeight ?? 1,
        disqualified: false,
      };
      result = combineSubScores([slope, elev, aspect]);
    } else {
      const scorer = SCORERS[id];
      if (scorer) result = scorer(codi, configs, data);
    }

    if (!result) continue;
    if (result.disqualified) disqualified = true;
    weightedSum += result.score * layer.weight;
    totalWeight += layer.weight;
  }

  const score = disqualified ? 0 : totalWeight > 0 ? weightedSum / totalWeight : 0;
  return { score, disqualified };
}

/* ── Per-pixel terrain helpers (used by heatmap renderer) ────────────── */

/**
 * Cached result of the non-terrain layer composite for one municipality.
 * Computed once per feature before the pixel loop to avoid redundant
 * hash-lookups for every cell inside the same municipality.
 */
export interface NonTerrainCached {
  /** Sum of (score × weight) for all enabled non-terrain layers. */
  weightedSum: number;
  /** Sum of weights for all enabled non-terrain layers. */
  totalWeight: number;
  /** True if any mandatory non-terrain layer is disqualified. */
  disqualified: boolean;
}

/**
 * Pre-compute the weighted composite for all non-terrain enabled layers.
 * Call once per municipality feature before entering the pixel render loop.
 */
export function computeNonTerrainCached(
  codi: string,
  enabledLayers: LayerMeta[],
  configs: LayerConfigs,
  data: MunicipalityData,
): NonTerrainCached {
  let weightedSum = 0;
  let totalWeight = 0;
  let disqualified = false;

  for (const layer of enabledLayers) {
    if (layer.id === 'terrain') continue;
    const scorer = SCORERS[layer.id];
    if (!scorer) continue;
    const result = scorer(codi, configs, data);
    if (!result) continue;
    if (result.disqualified) disqualified = true;
    weightedSum += result.score * layer.weight;
    totalWeight += layer.weight;
  }

  return { weightedSum, totalWeight, disqualified };
}

/**
 * Evaluate only the terrain sub-layer from raw DEM values without any data
 * table lookup.  Pure, deterministic, very fast — safe to call 30 000× per
 * heatmap render.
 *
 * @returns Weighted contribution and weight to be combined with NonTerrainCached.
 */
export function evaluateTerrainPixel(
  slopeDeg: number,
  elevationM: number,
  aspect: string,
  terrainLayerWeight: number,
  configs: LayerConfigs,
): { contrib: number; weight: number; disqualified: boolean } {
  const slope = scoreSingleTf(slopeDeg, configs.terrain.slope);
  const elev  = scoreSingleTf(elevationM, configs.terrain.elevation);
  const asp: SubResult = {
    score: scoreAspect(aspect, configs.terrain.aspect),
    weight: configs.terrain.aspectWeight ?? 1,
    disqualified: false,
  };
  const result = combineSubScores([slope, elev, asp]);
  if (!result) return { contrib: 0, weight: 0, disqualified: false };
  return {
    contrib: result.score * terrainLayerWeight,
    weight: terrainLayerWeight,
    disqualified: result.disqualified,
  };
}

/**
 * Compute scores for all municipalities.
 */
export function computeAllScores(
  municipalityCodes: string[],
  layers: LayerMeta[],
  configs: LayerConfigs,
  data: MunicipalityData,
): Record<string, { score: number } & Partial<Record<LayerId, number>>> {
  const enabled = layers.filter((l) => l.enabled);
  const result: Record<string, { score: number } & Partial<Record<LayerId, number>>> = {};

  for (const codi of municipalityCodes) {
    const { score, layerScores } = computeScore(codi, enabled, configs, data);
    result[codi] = { score, ...layerScores };
  }

  return result;
}
