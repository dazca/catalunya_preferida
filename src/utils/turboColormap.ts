/**
 * @file Turbo colormap – a perceptually-optimised rainbow palette from
 *       Google AI (Mikhailov 2019).  Maps a [0, 1] score to an RGBA tuple
 *       suitable for canvas pixel operations.
 *
 * The 256-entry LUT is generated from the polynomial approximation so we
 * avoid bundling a large lookup table.
 */

/** Clamp value to [0, 1]. */
function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/**
 * Evaluate the Turbo colormap polynomial at a given t in [0, 1].
 * Returns [r, g, b] in 0–255.
 *
 * Polynomial coefficients from:
 * https://gist.github.com/mikhailov-work/0d177465a8151eb6ede1768d51d476c7
 */
function turboRgb(t: number): [number, number, number] {
  t = clamp01(t);

  const r =
    0.13572138 +
    t *
      (4.6153926 +
        t * (-42.66032258 + t * (132.13108234 + t * (-152.94239396 + t * 59.28637943))));
  const g =
    0.09140261 +
    t *
      (2.19418839 +
        t * (4.84296658 + t * (-14.18503333 + t * (4.27729857 + t * 2.82956604))));
  const b =
    0.1066733 +
    t *
      (12.64194608 +
        t * (-60.58204836 + t * (110.36276771 + t * (-89.90310912 + t * 27.34824973))));

  return [
    Math.round(clamp01(r) * 255),
    Math.round(clamp01(g) * 255),
    Math.round(clamp01(b) * 255),
  ];
}

/** Pre-computed 256-entry Turbo LUT for fast canvas rendering. */
const TURBO_LUT: [number, number, number][] = new Array(256);
for (let i = 0; i < 256; i++) {
  TURBO_LUT[i] = turboRgb(i / 255);
}

/**
 * Map a score [0, 1] to an RGBA tuple using the Turbo palette.
 *
 * @param score  Normalised score in [0, 1].
 * @param alpha  Opacity byte (0-255, default 200).
 * @returns [r, g, b, a] each 0-255.
 */
export function scoreToRgba(
  score: number,
  alpha = 200,
): [number, number, number, number] {
  // Invert: high score (good) -> blue end; low score (bad) -> red end.
  const idx = 255 - Math.round(clamp01(score) * 255);
  const [r, g, b] = TURBO_LUT[idx];
  return [r, g, b, alpha];
}

/**
 * Return a CSS rgba() string for a score value.
 * Useful for legend rendering and non-canvas contexts.
 */
export function scoreToCssColor(score: number, opacity = 0.78): string {
  // Invert: high score (good) -> blue end; low score (bad) -> red end.
  const [r, g, b] = TURBO_LUT[255 - Math.round(clamp01(score) * 255)];
  return `rgba(${r},${g},${b},${opacity})`;
}

/**
 * Return the Turbo LUT for direct indexed access.
 */
export function getTurboLut(): readonly [number, number, number][] {
  return TURBO_LUT;
}
