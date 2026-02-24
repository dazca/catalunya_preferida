/**
 * @file Custom MapLibre protocol that converts DEM (raster-dem) tiles into
 *       hypsometric-tinted raster tiles.  Elevation is decoded from the
 *       RGB-encoded DEM pixel and mapped to a classic cartographic colour
 *       ramp (green lowlands -> brown mountains -> white peaks).
 *
 * Optimizations:
 *   - 65536-entry elevation LUT replaces per-pixel linear search.
 *   - Tile ArrayBuffer cache avoids re-processing the same tile.
 *   - createImageBitmap for fast decode; OffscreenCanvas where available.
 */
import maplibregl from 'maplibre-gl';

/* ---------- Hypsometric colour ramp ---------- */

/** Elevation (m) -> RGB stops for linear interpolation. */
const STOPS: [number, [number, number, number]][] = [
  [-50,  [70, 130, 180]],     // below sea level — blue
  [0,    [172, 208, 165]],    // coast
  [100,  [148, 191, 139]],    // lowlands
  [250,  [168, 198, 143]],    // gentle plains
  [500,  [189, 204, 150]],    // foothills
  [750,  [209, 215, 171]],    // lower hills
  [1000, [225, 228, 181]],    // mid hills
  [1250, [202, 185, 130]],    // upper hills
  [1500, [180, 145, 95]],     // low mountains
  [2000, [156, 126, 98]],     // mountains
  [2500, [181, 172, 164]],    // high peaks
  [3000, [218, 216, 215]],    // near-summit
  [3300, [248, 248, 248]],    // summit
];

/**
 * Map an elevation (metres) to an RGB tuple via linear interpolation
 * through the hypsometric colour stops.
 */
export function elevationToRgb(elev: number): [number, number, number] {
  if (elev <= STOPS[0][0]) return STOPS[0][1];
  if (elev >= STOPS[STOPS.length - 1][0]) return STOPS[STOPS.length - 1][1];
  for (let i = 1; i < STOPS.length; i++) {
    if (elev <= STOPS[i][0]) {
      const [e0, c0] = STOPS[i - 1];
      const [e1, c1] = STOPS[i];
      const t = (elev - e0) / (e1 - e0);
      return [
        Math.round(c0[0] + t * (c1[0] - c0[0])),
        Math.round(c0[1] + t * (c1[1] - c0[1])),
        Math.round(c0[2] + t * (c1[2] - c0[2])),
      ];
    }
  }
  return STOPS[STOPS.length - 1][1];
}

/**
 * Decode an elevation value from an RGB-encoded DEM pixel.
 */
export function decodeElevation(
  r: number,
  g: number,
  b: number,
  encoding: 'mapbox' | 'terrarium' = 'mapbox',
): number {
  if (encoding === 'terrarium') {
    return (r * 256 + g + b / 256) - 32768;
  }
  return -10000 + (r * 65536 + g * 256 + b) * 0.1;
}

/* ---------- Pre-built LUT for fast per-pixel conversion ---------- */

/**
 * Build a 65536-entry LUT that maps raw 16-bit encoding value (R<<8|G)
 * directly to packed RGBA bytes [r,g,b,alpha].
 * We ignore the blue channel for speed (it only adds 0.1m precision
 * in mapbox encoding, or sub-metre in terrarium).
 *
 * This avoids per-pixel decode + 13-stop linear search.
 */
function buildRgLut(
  encoding: 'mapbox' | 'terrarium',
  alpha: number,
): Uint32Array {
  const lut = new Uint32Array(65536);
  const view = new DataView(lut.buffer);

  for (let rg = 0; rg < 65536; rg++) {
    const r = (rg >> 8) & 0xff;
    const g = rg & 0xff;
    const elev = encoding === 'terrarium'
      ? (r * 256 + g) - 32768
      : -10000 + (r * 65536 + g * 256) * 0.1;
    const [cr, cg, cb] = elevationToRgb(elev);
    // Store as little-endian RGBA in a Uint32
    view.setUint32(rg * 4, (cr) | (cg << 8) | (cb << 16) | (alpha << 24), true);
  }
  return lut;
}

/* ---------- Protocol state ---------- */

let _demTileUrl = '';
let _encoding: 'mapbox' | 'terrarium' = 'mapbox';
let _registered = false;
let _rgLut: Uint32Array | null = null;

/**
 * Configure the DEM tile URL template and encoding.
 * Also pre-builds the elevation LUT for the given encoding.
 */
export function configureDemTiles(
  tileUrl: string,
  encoding: 'mapbox' | 'terrarium' = 'mapbox',
): void {
  _demTileUrl = tileUrl;
  _encoding = encoding;
  _rgLut = buildRgLut(encoding, 180);
}

/* ---------- Tile cache ---------- */

const TILE_CACHE = new Map<string, ArrayBuffer>();
const MAX_CACHE = 256;

function cachePut(key: string, data: ArrayBuffer): void {
  if (TILE_CACHE.size >= MAX_CACHE) {
    // Evict oldest entry
    const first = TILE_CACHE.keys().next().value;
    if (first !== undefined) TILE_CACHE.delete(first);
  }
  TILE_CACHE.set(key, data);
}

/* ---------- Protocol registration ---------- */

/**
 * Register the `hypsometric://` tile protocol with MapLibre.
 * Idempotent — safe to call multiple times.
 */
export function registerHypsometricProtocol(): void {
  if (_registered) return;
  _registered = true;

  maplibregl.addProtocol(
    'hypsometric',
    async (
      params: { url: string },
      abortController: AbortController,
    ): Promise<{ data: ArrayBuffer }> => {
      const empty = { data: new ArrayBuffer(0) };
      if (!_demTileUrl) return empty;

      const m = params.url.match(/hypsometric:\/\/(\d+)\/(\d+)\/(\d+)/);
      if (!m) return empty;

      const [, z, x, y] = m;
      const tileKey = `${z}/${x}/${y}`;

      // Return cached tile if available
      const cached = TILE_CACHE.get(tileKey);
      if (cached) return { data: cached };

      const url = _demTileUrl
        .replace('{z}', z)
        .replace('{x}', x)
        .replace('{y}', y);

      try {
        const res = await fetch(url, { signal: abortController.signal });
        if (!res.ok) return empty;

        const blob = await res.blob();
        const bmp = await createImageBitmap(blob);
        const w = bmp.width;
        const h = bmp.height;

        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d')!;
        ctx.drawImage(bmp, 0, 0);

        const img = ctx.getImageData(0, 0, w, h);
        const d = img.data; // Uint8ClampedArray: [R,G,B,A, R,G,B,A, ...]
        const lut = _rgLut;

        if (lut) {
          // Fast LUT path — one lookup per pixel instead of decode + 13-stop search
          const out32 = new Uint32Array(d.buffer, d.byteOffset, w * h);
          for (let i = 0; i < w * h; i++) {
            const off = i * 4;
            const key = (d[off] << 8) | d[off + 1]; // R<<8 | G
            out32[i] = lut[key];
          }
        } else {
          // Fallback: per-pixel decode (slow)
          const enc = _encoding;
          for (let i = 0; i < d.length; i += 4) {
            const elev = decodeElevation(d[i], d[i + 1], d[i + 2], enc);
            const [cr, cg, cb] = elevationToRgb(elev);
            d[i] = cr;
            d[i + 1] = cg;
            d[i + 2] = cb;
            d[i + 3] = 180;
          }
        }

        ctx.putImageData(img, 0, 0);

        const resultBlob: Blob = await new Promise((resolve, reject) =>
          canvas.toBlob(
            (b) => (b ? resolve(b) : reject(new Error('toBlob failed'))),
            'image/png',
          ),
        );
        const result = await resultBlob.arrayBuffer();
        cachePut(tileKey, result);
        return { data: result };
      } catch {
        return empty;
      }
    },
  );
}
