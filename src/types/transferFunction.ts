/**
 * @file TransferFunction type definitions.
 *
 * A TransferFunction maps a raw data value to a 0-1 output score using a
 * sinusoidal decay curve: full output (1.0) up to `plateauEnd`, then a
 * half-cosine decay to `floor` at `decayEnd`, flat `floor` beyond.
 *
 * The `mandatory` flag disqualifies municipalities that score below the floor.
 * The `multiplier` scales the final weight contribution of this layer.
 */

/**
 * Sinusoidal decay transfer function.
 *
 * Curve shape:
 *   input <= plateauEnd  →  1.0
 *   plateauEnd < input < decayEnd  →  floor + (1-floor) * 0.5 * (1 + cos(π * t))
 *       where t = (input - plateauEnd) / (decayEnd - plateauEnd)
 *   input >= decayEnd  →  floor
 *
 * When `invert` is true, the input is mirrored: effective = max - (input - min).
 * This is for "lower is better" metrics (crime, pollution, rent, distance).
 */
/** Curve shape: sinusoidal or linear, normal or inverted direction. */
export type TfShape = 'sin' | 'invsin' | 'range' | 'invrange';

export interface TransferFunction {
  /** Start of the transition zone (raw data units). */
  plateauEnd: number;
  /** End of the transition zone (raw data units). */
  decayEnd: number;
  /** Output value at the "low" end of the curve (0-1). */
  floor: number;
  /** If true, this layer is required — municipality is disqualified if score = floor. */
  mandatory: boolean;
  /** Weight multiplier (default 1.0). Scales this layer's contribution. */
  multiplier: number;
  /**
   * Curve shape:
   * - `sin`      : sinusoidal ≤M→1, ≥N→floor  (default)
   * - `invsin`   : sinusoidal ≤M→floor, ≥N→1   (ascending)
   * - `range`    : linear     ≤M→1, ≥N→floor
   * - `invrange` : linear     ≤M→floor, ≥N→1   (ascending)
   */
  shape: TfShape;
}

/**
 * Per-layer configuration that wraps a TransferFunction with layer-specific
 * settings. Each quantitative layer gets one of these.
 */
export interface LayerTransferConfig {
  /** Whether this layer is enabled in scoring. */
  enabled: boolean;
  /** The transfer function parameters. */
  tf: TransferFunction;
}

/**
 * Data statistics computed from the actual loaded data for a layer.
 * Shown as range indicators on the CurveEditor.
 */
export interface DataStats {
  min: number;
  max: number;
  p25: number;
  median: number;
  p75: number;
  unit: string;
  count: number;
}

/**
 * Wind-rose direction preference for terrain aspect scoring.
 * Each cardinal direction gets a 0-1 weight representing how desirable it is.
 */
export interface AspectPreferences {
  N: number;
  NE: number;
  E: number;
  SE: number;
  S: number;
  SW: number;
  W: number;
  NW: number;
}

/** Available vote metric keys mapped to VoteSentiment fields. */
export type VoteMetric =
  | 'leftPct'
  | 'rightPct'
  | 'independencePct'
  | 'unionistPct'
  | 'turnoutPct';

/** A single vote scoring term the user can add to the formula. */
export interface VoteTerm {
  /** Unique id within the terms array (nanoid-style or sequential). */
  id: string;
  /** Which vote metric this term evaluates. */
  metric: VoteMetric;
  /** Transfer function config for this metric. */
  value: LayerTransferConfig;
}

/** Human-readable labels per VoteMetric (used in i18n). */
export const VOTE_METRIC_OPTIONS: { metric: VoteMetric; labelKey: string }[] = [
  { metric: 'leftPct', labelKey: 'vote.metric.left' },
  { metric: 'rightPct', labelKey: 'vote.metric.right' },
  { metric: 'independencePct', labelKey: 'vote.metric.indep' },
  { metric: 'unionistPct', labelKey: 'vote.metric.union' },
  { metric: 'turnoutPct', labelKey: 'vote.metric.turnout' },
];

/**
 * Complete filter configuration for all layers.
 * Quantitative layers use TransferFunction; terrain aspect uses wind-rose.
 */
export interface LayerConfigs {
  terrain: {
    slope: LayerTransferConfig;
    elevation: LayerTransferConfig;
    aspect: AspectPreferences;
    /** Relative weight of the aspect sub-score vs slope/elevation. */
    aspectWeight?: number;
  };
  votes: {
    /** Multi-term vote scoring. Each term evaluates a different metric. */
    terms: VoteTerm[];
  };
  transit: LayerTransferConfig;
  forest: LayerTransferConfig;
  airQuality: {
    pm10: LayerTransferConfig;
    no2: LayerTransferConfig;
  };
  crime: LayerTransferConfig;
  healthcare: LayerTransferConfig;
  schools: LayerTransferConfig;
  internet: LayerTransferConfig;
  climate: {
    temperature: LayerTransferConfig;
    rainfall: LayerTransferConfig;
  };
  rentalPrices: LayerTransferConfig;
  employment: LayerTransferConfig;
  amenities: LayerTransferConfig;
}

/** Default transfer function — full plateau across typical range. */
export function defaultTf(
  plateauEnd: number,
  decayEnd: number,
  shape: TfShape = 'sin',
  floor = 0,
): TransferFunction {
  return { plateauEnd, decayEnd, floor, mandatory: false, multiplier: 1, shape };
}

/** Default aspect preferences: slight preference for south-facing slopes. */
export const DEFAULT_ASPECT_PREFS: AspectPreferences = {
  N: 0.3,
  NE: 0.5,
  E: 0.7,
  SE: 0.9,
  S: 1.0,
  SW: 0.9,
  W: 0.7,
  NW: 0.5,
};

/** Default layer configurations with sensible ranges. */
export const DEFAULT_LAYER_CONFIGS: LayerConfigs = {
  terrain: {
    /* Slopes above 5° start decaying; above 20° score drops to floor.
       Elevation: gentle preference for 100–1500 m range. */
    slope: { enabled: true, tf: defaultTf(5, 20, 'sin', 0) },
    elevation: { enabled: true, tf: defaultTf(100, 1500, 'sin', 0) },
    aspect: { ...DEFAULT_ASPECT_PREFS },
    aspectWeight: 1,
  },
  votes: {
    terms: [
      { id: 'v1', metric: 'leftPct', value: { enabled: true, tf: defaultTf(0, 100, 'sin', 0) } },
      { id: 'v2', metric: 'rightPct', value: { enabled: true, tf: defaultTf(0, 100, 'sin', 0) } },
      { id: 'v3', metric: 'independencePct', value: { enabled: true, tf: defaultTf(0, 100, 'sin', 0) } },
      { id: 'v4', metric: 'unionistPct', value: { enabled: true, tf: defaultTf(0, 100, 'sin', 0) } },
      { id: 'v5', metric: 'turnoutPct', value: { enabled: true, tf: defaultTf(0, 100, 'sin', 0) } },
    ],
  },
  transit: { enabled: true, tf: defaultTf(5, 25, 'sin', 0.1) },
  forest: { enabled: true, tf: defaultTf(10, 80, 'sin', 0) },
  airQuality: {
    pm10: { enabled: false, tf: defaultTf(10, 50, 'sin', 0) },
    no2: { enabled: false, tf: defaultTf(10, 40, 'sin', 0) },
  },
  crime: { enabled: false, tf: defaultTf(5, 50, 'sin', 0) },
  healthcare: { enabled: false, tf: defaultTf(3, 15, 'sin', 0.1) },
  schools: { enabled: false, tf: defaultTf(3, 10, 'sin', 0.1) },
  internet: { enabled: false, tf: defaultTf(50, 100, 'sin', 0) },
  climate: {
    temperature: { enabled: false, tf: defaultTf(10, 25, 'sin', 0) },
    rainfall: { enabled: false, tf: defaultTf(200, 800, 'sin', 0) },
  },
  rentalPrices: { enabled: false, tf: defaultTf(300, 1500, 'sin', 0) },
  employment: { enabled: false, tf: defaultTf(3, 15, 'sin', 0) },
  amenities: { enabled: false, tf: defaultTf(3, 20, 'sin', 0.1) },
};
