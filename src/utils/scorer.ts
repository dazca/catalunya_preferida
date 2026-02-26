/**
 * @file Scoring engine: computes a 0-1 score per municipality using
 *       TransferFunction-based configs for sinusoidal decay curves.
 *       Each layer extracts raw values and passes them through the TF evaluator.
 */
import type { LayerId, LayerMeta } from '../types';
import type {
  LayerConfigs,
  LayerTransferConfig,
  VoteMetric,
} from '../types/transferFunction';
import {
  PARTY_METRIC_KEY,
} from '../types/transferFunction';
import {
  evaluateTransferFunction,
  scoreAspect,
  scoreAspectAngle,
} from './transferFunction';
import { evaluateCustomFormula } from './formulaEngine';
import { POLITICAL_AXES, axisLayerId, axisIdFromLayerId, computeAxisScore } from './politicalAxes';
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

export function buildRawFormulaValues(
  codi: string,
  data: MunicipalityData,
  terrainOverride?: { slopeDeg: number; elevationM: number; aspect?: string },
): Record<string, number | undefined> {
  const key = normalizeIne(codi);
  const terrain = data.terrain[key];
  const votes = data.votes[key];
  const forest = data.forest[key];
  const air = data.airQuality[key];
  const climate = data.climate[key];
  const crime = data.crime[key];
  const internet = data.internet[key];
  const rental = data.rentalPrices[key];
  const employment = data.employment[key];

  const slope = terrainOverride?.slopeDeg ?? terrain?.avgSlopeDeg;
  const elevation = terrainOverride?.elevationM ?? terrain?.avgElevationM;
  const publicTransport = data.transitDistKm[key];

  return {
    slope,
    terrainSlope: slope,
    elevation,
    terrainElevation: elevation,
    publicTransport,
    transit: publicTransport,
    leftvotesentinent: votes?.leftPct,
    votesLeft: votes?.leftPct,
    votesRight: votes?.rightPct,
    votesIndep: votes?.independencePct,
    votesUnionist: votes?.unionistPct,
    votesTurnout: votes?.turnoutPct,
    // Party variables
    votesERC: votes?.partyPcts?.ERC,
    votesCUP: votes?.partyPcts?.CUP,
    votesPODEM: votes?.partyPcts?.PODEM,
    votesJUNTS: votes?.partyPcts?.JUNTS,
    votesCOMUNS: votes?.partyPcts?.COMUNS,
    votesPP: votes?.partyPcts?.PP,
    votesVOX: votes?.partyPcts?.VOX,
    votesPSC: votes?.partyPcts?.PSC,
    votesCs: votes?.partyPcts?.Cs,
    votesPDeCAT: votes?.partyPcts?.PDeCAT,
    votesCiU: votes?.partyPcts?.CiU,
    votesOtherParties: votes?.partyPcts?.OTHER,
    // Political axis variables (computed from partyPcts × axis weights)
    ...Object.fromEntries(
      POLITICAL_AXES.map(axis => [
        axisLayerId(axis.id),
        votes?.partyPcts ? computeAxisScore(axis, votes.partyPcts) : undefined,
      ]),
    ),
    forest: forest?.forestPct,
    airQualityPm10: air?.pm10,
    airQualityNo2: air?.no2,
    airPm10: air?.pm10,
    airNo2: air?.no2,
    crime: crime?.ratePerThousand,
    healthcare: data.healthcareDistKm[key],
    schools: data.schoolDistKm[key],
    internet: internet?.fiberPct,
    climateTemp: climate?.avgTempC,
    climateRainfall: climate?.avgRainfallMm,
    climateRain: climate?.avgRainfallMm,
    rentalPrices: rental?.avgEurMonth,
    employment: employment?.unemploymentPct,
    amenities: data.amenityDistKm[key],
  };
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

const SCORERS: { [key: string]: LayerScorer } = {
  terrainSlope: (codi, configs, data) => {
    const t = data.terrain[normalizeIne(codi)];
    if (!t) return undefined;
    return combineSubScores([scoreSingleTf(t.avgSlopeDeg, configs.terrain.slope)]);
  },
  terrainElevation: (codi, configs, data) => {
    const t = data.terrain[normalizeIne(codi)];
    if (!t) return undefined;
    return combineSubScores([scoreSingleTf(t.avgElevationM, configs.terrain.elevation)]);
  },
  terrainAspect: (codi, configs, data) => {
    const t = data.terrain[normalizeIne(codi)];
    if (!t) return undefined;
    return {
      score: scoreAspect(t.dominantAspect, configs.terrain.aspect),
      disqualified: false,
    };
  },

  votesLeft: (codi, configs, data) => {
    const v = data.votes[normalizeIne(codi)];
    if (!v) return undefined;
    const term = configs.votes.terms.find((t) => t.metric === 'leftPct');
    if (!term) return undefined;
    return combineSubScores([scoreSingleTf(v.leftPct, term.value)]);
  },
  votesRight: (codi, configs, data) => {
    const v = data.votes[normalizeIne(codi)];
    if (!v) return undefined;
    const term = configs.votes.terms.find((t) => t.metric === 'rightPct');
    if (!term) return undefined;
    return combineSubScores([scoreSingleTf(v.rightPct, term.value)]);
  },
  votesIndep: (codi, configs, data) => {
    const v = data.votes[normalizeIne(codi)];
    if (!v) return undefined;
    const term = configs.votes.terms.find((t) => t.metric === 'independencePct');
    if (!term) return undefined;
    return combineSubScores([scoreSingleTf(v.independencePct, term.value)]);
  },
  votesUnionist: (codi, configs, data) => {
    const v = data.votes[normalizeIne(codi)];
    if (!v) return undefined;
    const term = configs.votes.terms.find((t) => t.metric === 'unionistPct');
    if (!term) return undefined;
    return combineSubScores([scoreSingleTf(v.unionistPct, term.value)]);
  },
  votesTurnout: (codi, configs, data) => {
    const v = data.votes[normalizeIne(codi)];
    if (!v) return undefined;
    const term = configs.votes.terms.find((t) => t.metric === 'turnoutPct');
    if (!term) return undefined;
    return combineSubScores([scoreSingleTf(v.turnoutPct, term.value)]);
  },

  // ── Party vote scorers (read from partyPcts + partyVotes.terms) ──
  ...(() => {
    /** Build a scorer for a party LayerId by looking up partyPcts and partyVotes.terms. */
    function partyScorer(metric: VoteMetric): LayerScorer {
      const partyKey = PARTY_METRIC_KEY[metric];
      return (codi, configs, data) => {
        const v = data.votes[normalizeIne(codi)];
        if (!v || !v.partyPcts || !partyKey) return undefined;
        const value = v.partyPcts[partyKey];
        const term = configs.partyVotes.terms.find((t) => t.metric === metric);
        if (!term) return undefined;
        return combineSubScores([scoreSingleTf(value, term.value)]);
      };
    }
    return {
      votesERC:          partyScorer('ercPct'),
      votesCUP:          partyScorer('cupPct'),
      votesPODEM:        partyScorer('podemPct'),
      votesJUNTS:        partyScorer('juntsPct'),
      votesCOMUNS:       partyScorer('comunsPct'),
      votesPP:           partyScorer('ppPct'),
      votesVOX:          partyScorer('voxPct'),
      votesPSC:          partyScorer('pscPct'),
      votesCs:           partyScorer('csPct'),
      votesPDeCAT:       partyScorer('pdecatPct'),
      votesCiU:          partyScorer('ciuPct'),
      votesOtherParties: partyScorer('otherPartiesPct'),
    } satisfies Partial<Record<LayerId, LayerScorer>>;
  })(),

  // ── Political axis scorers (derived from POLITICAL_AXES registry) ──
  ...Object.fromEntries(
    POLITICAL_AXES.map(axis => [
      axisLayerId(axis.id),
      ((codi: string, configs: LayerConfigs, data: MunicipalityData) => {
        const v = data.votes[normalizeIne(codi)];
        if (!v?.partyPcts) return undefined;
        const rawPct = computeAxisScore(axis, v.partyPcts);
        const ltc = configs.axisConfigs?.[axis.id];
        if (!ltc) return undefined;
        return combineSubScores([scoreSingleTf(rawPct, ltc)]);
      }) as LayerScorer,
    ]),
  ),

  transit: (codi, configs, data) => {
    const d = data.transitDistKm[normalizeIne(codi)];
    return combineSubScores([scoreSingleTf(d, configs.transit)]);
  },

  forest: (codi, configs, data) => {
    const f = data.forest[normalizeIne(codi)];
    return combineSubScores([scoreSingleTf(f?.forestPct, configs.forest)]);
  },

  soil: () => {
    return { score: 0.5, disqualified: false };
  },

  airQualityPm10: (codi, configs, data) => {
    const a = data.airQuality[normalizeIne(codi)];
    if (!a) return undefined;
    return combineSubScores([scoreSingleTf(a.pm10, configs.airQuality.pm10)]);
  },
  airQualityNo2: (codi, configs, data) => {
    const a = data.airQuality[normalizeIne(codi)];
    if (!a) return undefined;
    return combineSubScores([scoreSingleTf(a.no2, configs.airQuality.no2)]);
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

  climateTemp: (codi, configs, data) => {
    const c = data.climate[normalizeIne(codi)];
    if (!c) return undefined;
    return combineSubScores([scoreSingleTf(c.avgTempC, configs.climate.temperature)]);
  },
  climateRainfall: (codi, configs, data) => {
    const c = data.climate[normalizeIne(codi)];
    if (!c) return undefined;
    return combineSubScores([scoreSingleTf(c.avgRainfallMm, configs.climate.rainfall)]);
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
  customFormula?: string,
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

  let score = disqualified ? 0 : totalWeight > 0 ? weightedSum / totalWeight : 0;
  if (!disqualified && customFormula && customFormula.trim()) {
    score = evaluateCustomFormula(customFormula, buildRawFormulaValues(codi, data));
  }
  return { score, layerScores, disqualified };
}

/**
 * Compute the composite score for a single municipality, but substitute
 * real-DEM derived slope / elevation / aspect for terrain sub-layers.
 *
 * Used by the heatmap renderer and point analysis to produce per-pixel
 * terrain variation rather than municipality-averaged synthetic values.
 */
export function computeScoreWithTerrainOverride(
  codi: string,
  enabledLayers: LayerMeta[],
  configs: LayerConfigs,
  data: MunicipalityData,
  terrainOverride?: { slopeDeg: number; elevationM: number; aspect?: string },
  customFormula?: string,
): { score: number; disqualified: boolean } {
  let weightedSum = 0;
  let totalWeight = 0;
  let disqualified = false;

  for (const layer of enabledLayers) {
    const id = layer.id;
    let result: { score: number; disqualified: boolean } | undefined;

    if (TERRAIN_SUB_IDS.has(id) && terrainOverride) {
      switch (id) {
        case 'terrainSlope':
          result = combineSubScores([scoreSingleTf(terrainOverride.slopeDeg, configs.terrain.slope)]);
          break;
        case 'terrainElevation':
          result = combineSubScores([scoreSingleTf(terrainOverride.elevationM, configs.terrain.elevation)]);
          break;
        case 'terrainAspect':
          result = { score: scoreAspect(terrainOverride.aspect ?? 'N', configs.terrain.aspect), disqualified: false };
          break;
      }
    } else {
      const scorer = SCORERS[id];
      if (scorer) result = scorer(codi, configs, data);
    }

    if (!result) continue;
    if (result.disqualified) disqualified = true;
    weightedSum += result.score * layer.weight;
    totalWeight += layer.weight;
  }

  let score = disqualified ? 0 : totalWeight > 0 ? weightedSum / totalWeight : 0;
  if (!disqualified && customFormula && customFormula.trim()) {
    score = evaluateCustomFormula(customFormula, buildRawFormulaValues(codi, data, terrainOverride));
  }
  return { score, disqualified };
}

/* ── Per-pixel terrain helpers (used by heatmap renderer) ────────────── */

/** Set of terrain sub-layer IDs that require per-pixel DEM evaluation. */
export const TERRAIN_SUB_IDS: ReadonlySet<string> = new Set([
  'terrainSlope',
  'terrainElevation',
  'terrainAspect',
]);

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
    if (TERRAIN_SUB_IDS.has(layer.id)) continue;
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
 * Check if a municipality is disqualified (any mandatory layer scores below
 * its floor). Early-exits on the first disqualified layer.
 */
export function isDisqualified(
  codi: string,
  enabledLayers: LayerMeta[],
  configs: LayerConfigs,
  data: MunicipalityData,
): boolean {
  for (const layer of enabledLayers) {
    const scorer = SCORERS[layer.id];
    if (!scorer) continue;
    const result = scorer(codi, configs, data);
    if (result?.disqualified) return true;
  }
  return false;
}

/**
 * Check if a municipality is disqualified by non-terrain layers only.
 * Used for the per-municipality cache in the heatmap custom-formula path.
 */
export function isNonTerrainDisqualified(
  codi: string,
  enabledLayers: LayerMeta[],
  configs: LayerConfigs,
  data: MunicipalityData,
): boolean {
  for (const layer of enabledLayers) {
    if (TERRAIN_SUB_IDS.has(layer.id)) continue;
    const scorer = SCORERS[layer.id];
    if (!scorer) continue;
    const result = scorer(codi, configs, data);
    if (result?.disqualified) return true;
  }
  return false;
}

/**
 * Check if a single pixel is disqualified by terrain mandatory layers.
 * Only evaluates slope and elevation TFs (aspect has no mandatory).
 * Called per-pixel in the heatmap loop — must be very fast.
 */
export function isTerrainDisqualifiedPixel(
  slopeDeg: number,
  elevationM: number,
  terrainSubLayers: LayerMeta[],
  configs: LayerConfigs,
): boolean {
  for (const layer of terrainSubLayers) {
    switch (layer.id) {
      case 'terrainSlope': {
        const r = scoreSingleTf(slopeDeg, configs.terrain.slope);
        if (r?.disqualified) return true;
        break;
      }
      case 'terrainElevation': {
        const r = scoreSingleTf(elevationM, configs.terrain.elevation);
        if (r?.disqualified) return true;
        break;
      }
    }
  }
  return false;
}

/**
 * Evaluate all enabled terrain sub-layers from raw DEM values.
 * Pure, deterministic, fast — safe to call 30 000× per heatmap render.
 *
 * @returns Weighted contributions and total weight to combine with NonTerrainCached.
 */
export function evaluateTerrainPixels(
  slopeDeg: number,
  elevationM: number,
  aspect: string | number,
  terrainSubLayers: LayerMeta[],
  configs: LayerConfigs,
): { weightedSum: number; totalWeight: number; disqualified: boolean } {
  let weightedSum = 0;
  let totalWeight = 0;
  let disqualified = false;

  for (const layer of terrainSubLayers) {
    let result: { score: number; disqualified: boolean } | undefined;
    switch (layer.id) {
      case 'terrainSlope':
        result = combineSubScores([scoreSingleTf(slopeDeg, configs.terrain.slope)]);
        break;
      case 'terrainElevation':
        result = combineSubScores([scoreSingleTf(elevationM, configs.terrain.elevation)]);
        break;
      case 'terrainAspect': {
        const rawAspect = typeof aspect === 'number'
          ? scoreAspectAngle(aspect, configs.terrain.aspect)
          : scoreAspect(aspect, configs.terrain.aspect);
        // aspectWeight dampens the score's deviation from neutral (0.5)
        const aw = configs.terrain.aspectWeight ?? 1;
        result = {
          score: 0.5 + (rawAspect - 0.5) * aw,
          disqualified: false,
        };
        break;
      }
    }
    if (!result) continue;
    weightedSum += result.score * layer.weight;
    totalWeight += layer.weight;
    if (result.disqualified) disqualified = true;
  }

  return { weightedSum, totalWeight, disqualified };
}

/**
 * Compute scores for all municipalities.
 */
export function computeAllScores(
  municipalityCodes: string[],
  layers: LayerMeta[],
  configs: LayerConfigs,
  data: MunicipalityData,
  customFormula?: string,
): Record<string, { score: number } & Partial<Record<LayerId, number>>> {
  const enabled = layers.filter((l) => l.enabled);
  const result: Record<string, { score: number } & Partial<Record<LayerId, number>>> = {};

  for (const codi of municipalityCodes) {
    const { score, layerScores } = computeScore(codi, enabled, configs, data, customFormula);
    result[codi] = { score, ...layerScores };
  }

  return result;
}
