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
export interface TransferFunction {
  /** Start of the plateau zone (raw data units). Full score (1.0) below this. */
  plateauEnd: number;
  /** End of the decay zone (raw data units). Score = floor beyond this. */
  decayEnd: number;
  /** Minimum output score (0-1) past the decay zone. */
  floor: number;
  /** If true, this layer is required — municipality is disqualified if score = floor. */
  mandatory: boolean;
  /** Weight multiplier (default 1.0). Scales this layer's contribution. */
  multiplier: number;
  /** If true, invert the input axis (lower raw value = higher score). */
  invert: boolean;
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
    axis: 'left-right' | 'independence';
    value: LayerTransferConfig;
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
  invert = false,
  floor = 0,
): TransferFunction {
  return { plateauEnd, decayEnd, floor, mandatory: false, multiplier: 1, invert };
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
    /* Slopes above 5 ° start decaying; above 20 ° score drops to floor.
       Elevation: gentle preference for 100–1500 m range. */
    slope: { enabled: true, tf: defaultTf(5, 20, false, 0) },
    elevation: { enabled: true, tf: defaultTf(100, 1500, false, 0) },
    aspect: { ...DEFAULT_ASPECT_PREFS },
    aspectWeight: 1,
  },
  votes: {
    axis: 'left-right',
    value: { enabled: true, tf: defaultTf(0, 100, false, 0) },
  },
  transit: { enabled: true, tf: defaultTf(5, 25, true, 0.1) },
  forest: { enabled: true, tf: defaultTf(10, 80, false, 0) },
  airQuality: {
    pm10: { enabled: false, tf: defaultTf(10, 50, true, 0) },
    no2: { enabled: false, tf: defaultTf(10, 40, true, 0) },
  },
  crime: { enabled: false, tf: defaultTf(5, 50, true, 0) },
  healthcare: { enabled: false, tf: defaultTf(3, 15, true, 0.1) },
  schools: { enabled: false, tf: defaultTf(3, 10, true, 0.1) },
  internet: { enabled: false, tf: defaultTf(50, 100, false, 0) },
  climate: {
    temperature: { enabled: false, tf: defaultTf(10, 25, false, 0) },
    rainfall: { enabled: false, tf: defaultTf(200, 800, true, 0) },
  },
  rentalPrices: { enabled: false, tf: defaultTf(300, 1500, true, 0) },
  employment: { enabled: false, tf: defaultTf(3, 15, true, 0) },
  amenities: { enabled: false, tf: defaultTf(3, 20, true, 0.1) },
};
