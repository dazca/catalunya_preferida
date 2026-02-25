/**
 * @file Red-Yellow-Green (RYG) traffic-light colormap.
 *
 * Maps a [0, 1] score to an RGBA tuple: bright red (bad, 0) through
 * orange and yellow to bright green (good, 1). Uses HSL interpolation
 * for perceptual smoothness.
 *
 * No colour in the LUT is near-black (min brightness ≥ 40 %), so black
 * is reserved exclusively for null / no-data rendering.
 */

/** Clamp value to [0, 1]. */
function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/**
 * Convert HSL (h 0-360, s 0-1, l 0-1) to RGB [0-255, 0-255, 0-255].
 */
function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let r1: number, g1: number, b1: number;
  if (h < 60)       { r1 = c; g1 = x; b1 = 0; }
  else if (h < 120) { r1 = x; g1 = c; b1 = 0; }
  else if (h < 180) { r1 = 0; g1 = c; b1 = x; }
  else if (h < 240) { r1 = 0; g1 = x; b1 = c; }
  else if (h < 300) { r1 = x; g1 = 0; b1 = c; }
  else              { r1 = c; g1 = 0; b1 = x; }
  return [
    Math.round((r1 + m) * 255),
    Math.round((g1 + m) * 255),
    Math.round((b1 + m) * 255),
  ];
}

/**
 * Evaluate the Red-Yellow-Green colormap at a given t in [0, 1].
 * t=0 → bright red (H=0°), t=0.5 → yellow (H=60°), t=1 → bright green (H=120°).
 * Saturation 90%, lightness 50% — ensures no dark/black-ish colours.
 */
function rygRgb(t: number): [number, number, number] {
  t = clamp01(t);
  const h = t * 120;  // 0° (red) → 120° (green)
  return hslToRgb(h, 0.90, 0.50);
}

/** Pre-computed 256-entry RYG LUT for fast canvas rendering. */
const RYG_LUT: [number, number, number][] = new Array(256);
for (let i = 0; i < 256; i++) {
  RYG_LUT[i] = rygRgb(i / 255);
}

/**
 * Map a score [0, 1] to an RGBA tuple using the Red-Yellow-Green palette.
 *
 * @param score  Normalised score in [0, 1].  0 = bad (red), 1 = good (green).
 * @param alpha  Opacity byte (0-255, default 200).
 * @returns [r, g, b, a] each 0-255.
 */
export function scoreToRgba(
  score: number,
  alpha = 200,
): [number, number, number, number] {
  const idx = Math.round(clamp01(score) * 255);
  const [r, g, b] = RYG_LUT[idx];
  return [r, g, b, alpha];
}

/**
 * Return a CSS rgba() string for a score value.
 * Useful for legend rendering and non-canvas contexts.
 */
export function scoreToCssColor(score: number, opacity = 0.78): string {
  const [r, g, b] = RYG_LUT[Math.round(clamp01(score) * 255)];
  return `rgba(${r},${g},${b},${opacity})`;
}

/**
 * Return the RYG LUT for direct indexed access.
 */
export function getTurboLut(): readonly [number, number, number][] {
  return RYG_LUT;
}
