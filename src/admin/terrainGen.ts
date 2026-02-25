/**
 * @file Synthetic terrain DEM generators for admin testing.
 */

function mulberry32(a: number) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export type TerrainShape = 'cone' | 'ridge_ns' | 'ridge_ew' | 'pyramid' | 'hemisphere' | 'noise_peaks';

export function generateDEM(
  shape: TerrainShape,
  N: number,
  height: number,
  radiusPct: number,
): Float64Array {
  const dem = new Float64Array(N * N);
  const cx = N / 2;
  const cy = N / 2;
  const R = (N / 2) * (radiusPct / 100);

  if (shape === 'cone') {
    for (let y = 0; y < N; y++)
      for (let x = 0; x < N; x++) {
        const d = Math.sqrt((x - cx) ** 2 + (y - cy) ** 2);
        dem[y * N + x] = Math.max(0, height * (1 - d / R));
      }
  } else if (shape === 'pyramid') {
    for (let y = 0; y < N; y++)
      for (let x = 0; x < N; x++) {
        const dx = Math.abs(x - cx) / R;
        const dy = Math.abs(y - cy) / R;
        dem[y * N + x] = Math.max(0, height * (1 - Math.max(dx, dy)));
      }
  } else if (shape === 'ridge_ns') {
    for (let y = 0; y < N; y++)
      for (let x = 0; x < N; x++)
        dem[y * N + x] = Math.max(0, height * (1 - Math.abs(x - cx) / R));
  } else if (shape === 'ridge_ew') {
    for (let y = 0; y < N; y++)
      for (let x = 0; x < N; x++)
        dem[y * N + x] = Math.max(0, height * (1 - Math.abs(y - cy) / R));
  } else if (shape === 'hemisphere') {
    for (let y = 0; y < N; y++)
      for (let x = 0; x < N; x++) {
        const r = Math.sqrt((x - cx) ** 2 + (y - cy) ** 2) / R;
        dem[y * N + x] = r >= 1 ? 0 : height * Math.sqrt(1 - r * r);
      }
  } else if (shape === 'noise_peaks') {
    const rng = mulberry32(42);
    const peaks: { x: number; y: number; h: number; r: number }[] = [];
    for (let i = 0; i < 8; i++)
      peaks.push({
        x: rng() * N,
        y: rng() * N,
        h: height * (0.4 + rng() * 0.6),
        r: R * (0.3 + rng() * 0.5),
      });
    for (let y = 0; y < N; y++)
      for (let x = 0; x < N; x++) {
        let maxH = 0;
        for (const p of peaks)
          maxH = Math.max(maxH, p.h * Math.max(0, 1 - Math.sqrt((x - p.x) ** 2 + (y - p.y) ** 2) / p.r));
        dem[y * N + x] = maxH;
      }
  }
  return dem;
}
