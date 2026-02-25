/**
 * @file Shared geo computation core for admin terrain/aspect analysis.
 *       Pure functions — no DOM / React dependencies.
 */

/* ── HSL→RGB helper ───────────────────────────────────────────────── */
function h2r(p: number, q: number, t: number): number {
  if (t < 0) t += 1;
  if (t > 1) t -= 1;
  if (t < 1 / 6) return p + (q - p) * 6 * t;
  if (t < 1 / 2) return q;
  if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
  return p;
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  let r: number, g: number, b: number;
  if (s === 0) {
    r = g = b = l;
  } else {
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    r = h2r(p, q, h + 1 / 3);
    g = h2r(p, q, h);
    b = h2r(p, q, h - 1 / 3);
  }
  return [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)];
}

/* ── Aspect / slope computation ───────────────────────────────────── */

export function computeAspectSlope(dem: Float64Array, N: number) {
  const aspect = new Float64Array(N * N);
  const slope = new Float64Array(N * N);

  for (let y = 1; y < N - 1; y++) {
    for (let x = 1; x < N - 1; x++) {
      const dz_dx = (dem[y * N + (x + 1)] - dem[y * N + (x - 1)]) / 2;
      const dz_dy = (dem[(y + 1) * N + x] - dem[(y - 1) * N + x]) / 2;
      const grad = Math.sqrt(dz_dx * dz_dx + dz_dy * dz_dy);
      slope[y * N + x] = Math.atan(grad) * (180 / Math.PI);
      if (grad < 1e-8) {
        aspect[y * N + x] = -1;
      } else {
        let az = Math.atan2(-dz_dx, dz_dy) * (180 / Math.PI);
        if (az < 0) az += 360;
        aspect[y * N + x] = az;
      }
    }
  }
  // Copy edges from interior
  for (let x = 0; x < N; x++) {
    aspect[x] = aspect[N + x];
    slope[x] = slope[N + x];
    aspect[(N - 1) * N + x] = aspect[(N - 2) * N + x];
    slope[(N - 1) * N + x] = slope[(N - 2) * N + x];
  }
  for (let y = 0; y < N; y++) {
    aspect[y * N] = aspect[y * N + 1];
    slope[y * N] = slope[y * N + 1];
    aspect[y * N + N - 1] = aspect[y * N + N - 2];
    slope[y * N + N - 1] = slope[y * N + N - 2];
  }
  return { aspect, slope };
}

export function computeSuitability(
  aspect: Float64Array,
  slope: Float64Array,
  N: number,
  prefAz: number,
  prefStr: number,
  slopeW: number,
): Float64Array {
  const suit = new Float64Array(N * N);
  const prefRad = (prefAz * Math.PI) / 180;
  const aw = 1 - slopeW;
  for (let i = 0; i < N * N; i++) {
    if (aspect[i] < 0) {
      suit[i] = 0.5;
      continue;
    }
    const azRad = (aspect[i] * Math.PI) / 180;
    const cosScore = (1 + Math.cos(azRad - prefRad)) / 2;
    const aspectScore = 0.5 + (cosScore - 0.5) * prefStr;
    const slopeScore = 1 - Math.min(slope[i] / 60, 1);
    suit[i] = aw * aspectScore + slopeW * slopeScore;
  }
  return suit;
}

export function suitColor(v: number): [number, number, number] {
  v = Math.max(0, Math.min(1, v));
  let r: number, g: number, b: number;
  if (v < 0.5) {
    const t = v / 0.5;
    r = 214 + (253 - 214) * t;
    g = 48 + (203 - 48) * t;
    b = 49 + (110 - 49) * t;
  } else {
    const t = (v - 0.5) / 0.5;
    r = 253 - 253 * t;
    g = 203 + (184 - 203) * t;
    b = 110 + (148 - 110) * t;
  }
  return [Math.round(r), Math.round(g), Math.round(b)];
}

export function aspectColor(az: number): [number, number, number] {
  if (az < 0) return [60, 60, 60];
  return hslToRgb(az / 360, 0.8, 0.5);
}

export function renderGrid(
  canvas: HTMLCanvasElement,
  data: Float64Array,
  N: number,
  colorFn: (v: number) => [number, number, number],
) {
  canvas.width = N;
  canvas.height = N;
  const ctx = canvas.getContext('2d')!;
  const img = ctx.createImageData(N, N);
  for (let i = 0; i < N * N; i++) {
    const [r, g, b] = colorFn(data[i]);
    img.data[i * 4] = r;
    img.data[i * 4 + 1] = g;
    img.data[i * 4 + 2] = b;
    img.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
}

export function renderOblique(
  canvas: HTMLCanvasElement,
  dem: Float64Array,
  suit: Float64Array,
  N: number,
) {
  const W = canvas.width;
  const H = canvas.height;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#0f1115';
  ctx.fillRect(0, 0, W, H);
  const step = Math.max(1, Math.floor(N / 256));
  const scaleX = W / N;
  let maxZ = 0;
  for (let i = 0; i < dem.length; i++) if (dem[i] > maxZ) maxZ = dem[i];
  if (maxZ === 0) maxZ = 1;
  const elevScale = (H * 0.35) / maxZ;
  const yOffset = H * 0.92;

  for (let y = 0; y < N; y += step) {
    const rd = y / N;
    const baseY = yOffset - (1 - rd) * H * 0.5;
    for (let x = 0; x < N - step; x += step) {
      const z1 = dem[y * N + x];
      const z2 = dem[y * N + x + step];
      const s1 = suit[y * N + x];
      const s2 = suit[y * N + x + step];
      const [r, g, b] = suitColor((s1 + s2) / 2);
      const fog = 0.4 + 0.6 * rd;
      ctx.strokeStyle = `rgb(${Math.round(r * fog)},${Math.round(g * fog)},${Math.round(b * fog)})`;
      ctx.lineWidth = Math.max(1, (2 * step) / N) * 4;
      ctx.beginPath();
      ctx.moveTo(x * scaleX, baseY - z1 * elevScale);
      ctx.lineTo((x + step) * scaleX, baseY - z2 * elevScale);
      ctx.stroke();
    }
  }
  ctx.fillStyle = '#888';
  ctx.font = '10px sans-serif';
  ctx.fillText('← West', 4, H - 4);
  ctx.fillText('East →', W - 46, H - 4);
  ctx.fillText('▲ North (far)', W / 2 - 38, 12);
  ctx.fillText('▼ South (near)', W / 2 - 42, H - 4);
}

export interface OctantStat {
  name: string;
  avg: number | null;
  avgAz: number | null;
  count: number;
}

export interface Assertion {
  pass: boolean;
  text: string;
}

export function analyzeOctants(aspect: Float64Array, suit: Float64Array, N: number): OctantStat[] {
  const names = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  const oct = names.map(() => ({ sum: 0, count: 0, azSum: 0 }));
  for (let i = 0; i < N * N; i++) {
    if (aspect[i] < 0) continue;
    const idx = Math.round(aspect[i] / 45) % 8;
    oct[idx].sum += suit[i];
    oct[idx].count++;
    oct[idx].azSum += aspect[i];
  }
  return names.map((name, i) => ({
    name,
    avg: oct[i].count > 0 ? oct[i].sum / oct[i].count : null,
    avgAz: oct[i].count > 0 ? oct[i].azSum / oct[i].count : null,
    count: oct[i].count,
  }));
}

export function runAssertions(stats: OctantStat[], prefAz: number): Assertion[] {
  const results: Assertion[] = [];
  const byName: Record<string, OctantStat> = {};
  stats.forEach((o) => (byName[o.name] = o));
  const names = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  const pi = Math.round(prefAz / 45) % 8;
  const oi = (pi + 4) % 8;
  const pn = names[pi];
  const on_ = names[oi];
  const p = byName[pn];
  const o = byName[on_];
  if (!p || p.avg === null || !o || o.avg === null) return results;
  const avgs = stats.filter((s) => s.avg !== null).map((s) => s.avg!);
  const mx = Math.max(...avgs);
  const mn = Math.min(...avgs);

  results.push({
    pass: Math.abs(p.avg - mx) < 0.02,
    text: `${pn}-facing has highest suitability (${p.avg.toFixed(3)})${Math.abs(p.avg - mx) >= 0.02 ? ' — max=' + mx.toFixed(3) : ''}`,
  });
  results.push({
    pass: Math.abs(o.avg - mn) < 0.02,
    text: `${on_}-facing has lowest suitability (${o.avg.toFixed(3)})${Math.abs(o.avg - mn) >= 0.02 ? ' — min=' + mn.toFixed(3) : ''}`,
  });
  results.push({ pass: p.avg > 0.7, text: `${pn}-facing avg > 0.7 (${p.avg.toFixed(3)})` });
  results.push({ pass: o.avg < 0.3, text: `${on_}-facing avg < 0.3 (${o.avg.toFixed(3)})` });
  results.push({
    pass: p.avg - o.avg > 0.5,
    text: `Spread (${pn}-${on_}) > 0.5 (${(p.avg - o.avg).toFixed(3)})`,
  });

  const l1 = byName[names[(pi + 2) % 8]];
  const l2 = byName[names[(pi + 6) % 8]];
  if (l1 && l2 && l1.avg !== null && l2.avg !== null) {
    const la = (l1.avg + l2.avg) / 2;
    results.push({
      pass: la > 0.35 && la < 0.65,
      text: `Laterals (${names[(pi + 2) % 8]}+${names[(pi + 6) % 8]}) avg ≈ 0.5 (${la.toFixed(3)})`,
    });
  }
  return results;
}

export function azLabel(v: number): string {
  const dirs = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
  return v + '° (' + dirs[Math.round(v / 22.5) % 16] + ')';
}
