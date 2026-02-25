/**
 * @file DEM-based slope and elevation utility.
 *
 * Fetches all raster-dem tiles at Z=9 covering Catalonia, stitches them
 * into a single merged elevation grid (Float32Array), then exposes
 * synchronous per-pixel slope/elevation/aspect queries.
 *
 * At zoom 9 each pixel ≈ 228 m — adequate for heatmap cells (~1.5 km wide)
 * and for point analysis.  The full grid for Catalonia is ~5 × 6 tiles
 * = 1 280 × 1 536 px ≈ 7.9 MB as Float32 — well within budget.
 *
 * Slope is computed with Horn's 3 × 3 weighted finite-difference kernel.
 */

const ZOOM = 9;
const TILE_W = 256; // pixels per tile edge

/* Catalonia bounding box */
const CAT_W = 0.16;
const CAT_S = 40.52;
const CAT_E = 3.33;
const CAT_N = 42.86;

/**
 * ICGC 5 m resolution RGB-DEM tiles (mapbox encoding, max Z=14, ~7 m/px).
 * Used for fine-tile demand cache; covers Catalonia.
 */
const FINE_DEM_URL =
  'https://geoserveis.icgc.cat/servei/catalunya/contextmaps-terreny-5m-rgb/wmts/{z}/{x}/{y}.png';

/* ------------------------------------------------------------------ */
/*  Module state                                                       */
/* ------------------------------------------------------------------ */

let _tileUrl = '';
let _encoding: 'mapbox' | 'terrarium' = 'mapbox';

/** Merged elevation raster (Float32, NaN = no data). */
let _elevGrid: Float32Array | null = null;

/** Tile-index origin of the merged grid (top-left tile). */
let _tx0 = 0;
let _ty0 = 0;
let _tilesW = 0; // grid width in tiles
let _tilesH = 0; // grid height in tiles

let _loadPromise: Promise<void> | null = null;
let _loaded = false;

/** Callbacks invoked once loading completes. */
const _listeners: Array<() => void> = [];

/* ------------------------------------------------------------------ */
/*  Fine-tile demand cache (Z=12–14, ICGC 5 m DEM)                   */
/* ------------------------------------------------------------------ */

/**
 * Demand-loaded high-res tiles keyed by "z/tx/ty".
 * Each entry is a TILE_W×TILE_W Float32Array of elevation values.
 */
const _fineTiles = new Map<string, Float32Array>();
/** Keys of tiles currently being fetched (deduplication guard). */
const _fineFetching = new Set<string>();
/** One-shot callbacks fired after any fine tile finishes loading. */
const _fineListeners: Array<() => void> = [];

/* ------------------------------------------------------------------ */
/*  Tile coordinate utilities (Web Mercator / Slippy-map)             */
/* ------------------------------------------------------------------ */

/** Longitude → tile X index at the configured zoom. */
function lonToTx(lon: number): number {
  return Math.floor(((lon + 180) / 360) * (1 << ZOOM));
}

/** Latitude → tile Y index at the configured zoom (Y=0 at top). */
function latToTy(lat: number): number {
  const r = lat * (Math.PI / 180);
  return Math.floor(
    ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * (1 << ZOOM),
  );
}

/* ------------------------------------------------------------------ */
/*  Generic (any-zoom) coordinate helpers                              */
/* ------------------------------------------------------------------ */

/** Longitude → tile X at zoom z. */
function lonToTxZ(lon: number, z: number): number {
  return Math.floor(((lon + 180) / 360) * (1 << z));
}

/** Latitude → tile Y at zoom z. */
function latToTyZ(lat: number, z: number): number {
  const r = lat * (Math.PI / 180);
  return Math.floor(
    ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * (1 << z),
  );
}

/** Convert lon/lat to fractional world-pixel coords at zoom z. */
function lonLatToWorldPx(
  lon: number,
  lat: number,
  z: number,
): { wpx: number; wpy: number } {
  const scale = (1 << z) * TILE_W;
  const wpx = ((lon + 180) / 360) * scale;
  const r = lat * (Math.PI / 180);
  const wpy =
    ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * scale;
  return { wpx, wpy };
}

/* ------------------------------------------------------------------ */
/*  Elevation decode                                                   */
/* ------------------------------------------------------------------ */

function decodeElev(r: number, g: number, b: number): number {
  return _encoding === 'terrarium'
    ? r * 256 + g + b / 256 - 32768
    : -10000 + (r * 65536 + g * 256 + b) * 0.1;
}

/* ------------------------------------------------------------------ */
/*  Fine-tile fetch helpers                                            */
/* ------------------------------------------------------------------ */

/**
 * Choose the best DEM zoom level given a desired ground resolution.
 * ICGC 5 m tiles go up to Z=14 (~7 m/px); we use Z=12–14.
 */
function fineDemZoom(targetM: number): number {
  if (targetM <= 10) return 14; // ~7 m/px
  if (targetM <= 20) return 13; // ~14 m/px
  return 12;                    // ~28 m/px
}

/**
 * Fetch one fine DEM tile from the ICGC 5 m source and store it in
 * `_fineTiles`.  Duplicate and in-flight requests are suppressed.
 *
 * Note: fine tiles always use mapbox RGB encoding regardless of the
 * basemap-derived `_encoding` setting, because the ICGC 5 m layer
 * uses the same format.
 */
async function fetchFineTile(z: number, tx: number, ty: number): Promise<void> {
  const key = `${z}/${tx}/${ty}`;
  if (_fineTiles.has(key) || _fineFetching.has(key)) return;
  _fineFetching.add(key);

  const url = FINE_DEM_URL
    .replace('{z}', String(z))
    .replace('{x}', String(tx))
    .replace('{y}', String(ty));
  try {
    const res = await fetch(url);
    if (!res.ok) { _fineFetching.delete(key); return; }
    const blob = await res.blob();
    const bmp = await createImageBitmap(blob);

    const canvas = document.createElement('canvas');
    canvas.width = TILE_W;
    canvas.height = TILE_W;
    const ctx = canvas.getContext('2d')!;
    ctx.drawImage(bmp, 0, 0);
    const d = ctx.getImageData(0, 0, TILE_W, TILE_W).data;

    const tile = new Float32Array(TILE_W * TILE_W);
    for (let i = 0; i < TILE_W * TILE_W; i++) {
      const elev = -10000 + (d[i * 4] * 65536 + d[i * 4 + 1] * 256 + d[i * 4 + 2]) * 0.1;
      tile[i] = elev < -1000 ? NaN : elev;
    }
    _fineTiles.set(key, tile);
    _fineFetching.delete(key);

    // Notify one-shot listeners
    const cbs = _fineListeners.splice(0);
    cbs.forEach((cb) => cb());
  } catch {
    _fineFetching.delete(key);
  }
}

/**
 * Sample elevation from the fine-tile cache at the given world pixel
 * coordinate (floating point, at zoom z).
 * Returns null if the tile is not yet cached.
 */
function fineElevAtWorldPx(wpx: number, wpy: number, z: number): number | null {
  const tx = Math.floor(wpx / TILE_W);
  const ty = Math.floor(wpy / TILE_W);
  const tile = _fineTiles.get(`${z}/${tx}/${ty}`);
  if (!tile) return null;
  const px = Math.max(0, Math.min(TILE_W - 1, Math.floor(wpx - tx * TILE_W)));
  const py = Math.max(0, Math.min(TILE_W - 1, Math.floor(wpy - ty * TILE_W)));
  return tile[py * TILE_W + px]; // NaN stays NaN for no-data
}

/**
 * Return the best available fine-tile zoom and world-pixel coords for a
 * lon/lat point, or null when no fine tile is cached for that location.
 *
 * Examines Z=14 → Z=13 → Z=12 in order (finest first).
 */
function bestFineZoomAt(
  lon: number,
  lat: number,
): { z: number; wpx: number; wpy: number } | null {
  for (const z of [14, 13, 12] as const) {
    const { wpx, wpy } = lonLatToWorldPx(lon, lat, z);
    const tx = Math.floor(wpx / TILE_W);
    const ty = Math.floor(wpy / TILE_W);
    if (_fineTiles.has(`${z}/${tx}/${ty}`)) return { z, wpx, wpy };
  }
  return null;
}

/**
 * Sample elevation at offset (dpx, dpy) pixels from (wpx, wpy) using
 * the fine-tile cache at zoom z, with cross-tile boundary support.
 * Returns NaN when the neighbouring tile is not cached (caller must
 * handle NaN via mirror/substitution).
 */
function fineElevNeighbour(
  wpx: number,
  wpy: number,
  dpx: number,
  dpy: number,
  z: number,
): number {
  return fineElevAtWorldPx(wpx + dpx, wpy + dpy, z) ?? NaN;
}

/* ------------------------------------------------------------------ */
/*  Tile fetcher                                                       */
/* ------------------------------------------------------------------ */

/**
 * Fetch one DEM tile, decode its elevation values and write them
 * directly into the shared merged grid.
 */
async function fetchTile(
  tx: number,
  ty: number,
  grid: Float32Array,
  gridW: number,
  offX: number,
  offY: number,
): Promise<void> {
  const url = _tileUrl
    .replace('{z}', String(ZOOM))
    .replace('{x}', String(tx))
    .replace('{y}', String(ty));

  try {
    const res = await fetch(url);
    if (!res.ok) return;
    const blob = await res.blob();
    const bmp = await createImageBitmap(blob);

    const canvas = document.createElement('canvas');
    canvas.width = TILE_W;
    canvas.height = TILE_W;
    const ctx = canvas.getContext('2d')!;
    ctx.drawImage(bmp, 0, 0);
    const d = ctx.getImageData(0, 0, TILE_W, TILE_W).data;

    for (let py = 0; py < TILE_W; py++) {
      for (let px = 0; px < TILE_W; px++) {
        const si = (py * TILE_W + px) * 4;
        const elev = decodeElev(d[si], d[si + 1], d[si + 2]);
        // Mark extreme no-data values as NaN (Catalonia min ≈ 0 m,
        // -1000 is an extremely safe sentinel threshold).
        grid[(offY + py) * gridW + (offX + px)] = elev < -1000 ? NaN : elev;
      }
    }
  } catch {
    // Tile unavailable — NaN values stay from fill(-1) sentinel
  }
}

/* ------------------------------------------------------------------ */
/*  Public API                                                         */
/* ------------------------------------------------------------------ */

/**
 * Set the DEM tile URL template and encoding.
 * Resets any previously loaded grid so tiles are refetched.
 */
export function configureDemSlope(
  tileUrl: string,
  encoding: 'mapbox' | 'terrarium' = 'mapbox',
): void {
  // Idempotent — skip if already configured with the same params
  if (_tileUrl === tileUrl && _encoding === encoding && _loadPromise) return;
  _tileUrl = tileUrl;
  _encoding = encoding;
  _elevGrid = null;
  _loaded = false;
  _loadPromise = null;
}

/**
 * Asynchronously fetch and decode all DEM tiles covering Catalonia.
 * Returns a promise that resolves when loading is complete.
 * Subsequent calls return the same promise (idempotent).
 */
export function loadDemSlope(): Promise<void> {
  if (_loaded) return Promise.resolve();
  if (_loadPromise) return _loadPromise;
  if (!_tileUrl) return Promise.resolve();

  _loadPromise = (async () => {
    const minTx = lonToTx(CAT_W);
    const maxTx = lonToTx(CAT_E);
    const minTy = latToTy(CAT_N); // northernmost → smallest Y tile index
    const maxTy = latToTy(CAT_S); // southernmost → largest  Y tile index

    _tx0 = minTx;
    _ty0 = minTy;
    _tilesW = maxTx - minTx + 1;
    _tilesH = maxTy - minTy + 1;

    const gridW = _tilesW * TILE_W;
    const gridH = _tilesH * TILE_W;
    const grid = new Float32Array(gridW * gridH).fill(NaN);

    const jobs: Promise<void>[] = [];
    for (let ty = minTy; ty <= maxTy; ty++) {
      for (let tx = minTx; tx <= maxTx; tx++) {
        const offX = (tx - minTx) * TILE_W;
        const offY = (ty - minTy) * TILE_W;
        jobs.push(fetchTile(tx, ty, grid, gridW, offX, offY));
      }
    }
    await Promise.all(jobs);

    _elevGrid = grid;
    _loaded = true;
    _listeners.forEach((cb) => cb());
    _listeners.length = 0;
  })();

  return _loadPromise;
}

/** Returns true once the merged elevation grid is ready. */
export function isDemLoaded(): boolean {
  return _loaded && _elevGrid !== null;
}

/**
 * Register a callback that fires once (and immediately if already loaded)
 * when the DEM grid finishes loading.
 * Returns an unsubscribe function.
 */
export function onDemLoaded(cb: () => void): () => void {
  if (_loaded) {
    cb();
    return () => undefined;
  }
  _listeners.push(cb);
  return () => {
    const i = _listeners.indexOf(cb);
    if (i >= 0) _listeners.splice(i, 1);
  };
}

/**
 * Demand-load fine DEM tiles that cover the supplied viewport bounds at the
 * resolution appropriate for `targetPixelSizeM` (metres per heatmap pixel).
 *
 * Already-cached tiles are skipped. Returns `true` when at least one new
 * tile was loaded (caller can trigger a heatmap re-render).
 *
 * @param w  West longitude
 * @param s  South latitude
 * @param e  East longitude
 * @param n  North latitude
 * @param targetPixelSizeM  Desired ground resolution in metres/pixel
 */
export async function loadViewportTiles(
  w: number,
  s: number,
  e: number,
  n: number,
  targetPixelSizeM: number,
): Promise<boolean> {
  const z = fineDemZoom(targetPixelSizeM);
  const minTx = lonToTxZ(w, z);
  const maxTx = lonToTxZ(e, z);
  const minTy = latToTyZ(n, z); // north = smaller Y index
  const maxTy = latToTyZ(s, z); // south = larger  Y index

  const jobs: Promise<void>[] = [];
  let anyNew = false;
  for (let ty = minTy; ty <= maxTy; ty++) {
    for (let tx = minTx; tx <= maxTx; tx++) {
      const key = `${z}/${tx}/${ty}`;
      if (!_fineTiles.has(key) && !_fineFetching.has(key)) {
        anyNew = true;
        jobs.push(fetchFineTile(z, tx, ty));
      }
    }
  }
  if (jobs.length > 0) await Promise.all(jobs);
  return anyNew;
}

/**
 * Register a one-shot callback that fires after the next fine tile
 * finishes loading. Returns an unsubscribe function.
 */
export function onFineTileLoaded(cb: () => void): () => void {
  _fineListeners.push(cb);
  return () => {
    const i = _fineListeners.indexOf(cb);
    if (i >= 0) _fineListeners.splice(i, 1);
  };
}

/* ------------------------------------------------------------------ */
/*  Grid sampling                                                      */
/* ------------------------------------------------------------------ */

/**
 * Convert lon/lat to a pixel position in the merged elevation grid.
 * Returns { px, py, valid } — valid=false when outside the grid extent.
 */
function lonLatToPx(
  lon: number,
  lat: number,
): { px: number; py: number; valid: boolean } {
  const scale = (1 << ZOOM) * TILE_W;
  const worldPx = ((lon + 180) / 360) * scale;
  const r = lat * (Math.PI / 180);
  const worldPy =
    ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * scale;

  const px = Math.floor(worldPx - _tx0 * TILE_W);
  const py = Math.floor(worldPy - _ty0 * TILE_W);

  const gridW = _tilesW * TILE_W;
  const gridH = _tilesH * TILE_W;

  return { px, py, valid: px >= 0 && px < gridW && py >= 0 && py < gridH };
}

/**
 * Read elevation from the merged grid with clamped boundary.
 * Returns NaN for no-data pixels so the Horn kernel can detect gaps.
 */
function gridElev(px: number, py: number): number {
  if (!_elevGrid) return NaN;
  const gridW = _tilesW * TILE_W;
  const gridH = _tilesH * TILE_W;
  if (px < 0 || px >= gridW || py < 0 || py >= gridH) return NaN;
  return _elevGrid[py * gridW + px]; // NaN stays NaN
}

/**
 * Return the elevation (metres) at a given coordinate.
 *
 * Priority: fine-tile cache (Z=12–14) → Z=9 global grid → null.
 */
export function getElevationAt(lon: number, lat: number): number | null {
  // Try fine-resolution tiles first
  const fine = bestFineZoomAt(lon, lat);
  if (fine) {
    const v = fineElevAtWorldPx(fine.wpx, fine.wpy, fine.z);
    if (v !== null && !isNaN(v)) return v;
  }
  // Fall back to Z=9 global grid
  if (!isDemLoaded()) return null;
  const { px, py, valid } = lonLatToPx(lon, lat);
  if (!valid) return null;
  const ev = gridElev(px, py);
  return isNaN(ev) ? null : ev;
}

/**
 * Return the terrain slope in degrees at a given coordinate using
 * Horn's weighted 3 × 3 finite-difference kernel, or null when not ready.
 *
 * Horn's formula:
 *   dz/dx = ((c+2f+i) − (a+2d+g)) / (8 * cellW)
 *   dz/dy = ((g+2h+i) − (a+2b+c)) / (8 * cellH)
 *   slope  = atan(sqrt(dzdx² + dzdy²))
 *
 * Cell dimensions (metres) are recomputed per point to account for
 * Mercator latitude distortion.
 */
export function getSlopeAt(lon: number, lat: number): number | null {
  const cosLat = Math.cos(lat * (Math.PI / 180));

  // --- Try fine-tile Horn kernel first ---
  const fine = bestFineZoomAt(lon, lat);
  if (fine) {
    const { z, wpx, wpy } = fine;
    const degPerFinePx = 360 / ((1 << z) * TILE_W);
    const fCellW = degPerFinePx * 111_320 * cosLat;
    const fCellH = degPerFinePx * 110_540 * cosLat;

    const fe = fineElevAtWorldPx(wpx, wpy, z);
    if (fe === null || isNaN(fe)) return null;
    const fa = fineElevNeighbour(wpx, wpy, -1, -1, z);
    const fb = fineElevNeighbour(wpx, wpy,  0, -1, z);
    const fc = fineElevNeighbour(wpx, wpy,  1, -1, z);
    const fd = fineElevNeighbour(wpx, wpy, -1,  0, z);
    const ff = fineElevNeighbour(wpx, wpy,  1,  0, z);
    const fg = fineElevNeighbour(wpx, wpy, -1,  1, z);
    const fh = fineElevNeighbour(wpx, wpy,  0,  1, z);
    const fi = fineElevNeighbour(wpx, wpy,  1,  1, z);

    // NaN-safe: substitute centre elevation for missing neighbours
    const sa = isNaN(fa) ? fe : fa;
    const sb = isNaN(fb) ? fe : fb;
    const sc = isNaN(fc) ? fe : fc;
    const sd = isNaN(fd) ? fe : fd;
    const sf = isNaN(ff) ? fe : ff;
    const sg = isNaN(fg) ? fe : fg;
    const sh = isNaN(fh) ? fe : fh;
    const si = isNaN(fi) ? fe : fi;

    const dzdx = ((sc + 2 * sf + si) - (sa + 2 * sd + sg)) / (8 * fCellW);
    const dzdy = ((sg + 2 * sh + si) - (sa + 2 * sb + sc)) / (8 * fCellH);
    return Math.atan(Math.sqrt(dzdx * dzdx + dzdy * dzdy)) * (180 / Math.PI);
  }

  // --- Fall back to Z=9 global grid ---
  if (!isDemLoaded()) return null;
  const { px, py, valid } = lonLatToPx(lon, lat);
  if (!valid) return null;

  const degPerPx = 360 / ((1 << ZOOM) * TILE_W);
  const cellW = degPerPx * 111_320 * cosLat;
  const cellH = degPerPx * 110_540 * cosLat;

  const ev = gridElev(px, py);
  if (isNaN(ev)) return null;
  const a = gridElev(px - 1, py - 1);
  const b = gridElev(px,     py - 1);
  const c = gridElev(px + 1, py - 1);
  const d = gridElev(px - 1, py    );
  const f = gridElev(px + 1, py    );
  const g = gridElev(px - 1, py + 1);
  const h = gridElev(px,     py + 1);
  const i = gridElev(px + 1, py + 1);

  // NaN-safe: substitute centre elevation for missing neighbours
  const sa = isNaN(a) ? ev : a;
  const sb = isNaN(b) ? ev : b;
  const sc = isNaN(c) ? ev : c;
  const sd = isNaN(d) ? ev : d;
  const sf = isNaN(f) ? ev : f;
  const sg = isNaN(g) ? ev : g;
  const sh = isNaN(h) ? ev : h;
  const si = isNaN(i) ? ev : i;

  const dzdx = ((sc + 2 * sf + si) - (sa + 2 * sd + sg)) / (8 * cellW);
  const dzdy = ((sg + 2 * sh + si) - (sa + 2 * sb + sc)) / (8 * cellH);
  return Math.atan(Math.sqrt(dzdx * dzdx + dzdy * dzdy)) * (180 / Math.PI);
}

/**
 * Return the aspect (slope-facing direction) at a given coordinate as
 * one of the 8 cardinal/intercardinal compass points, or null when not ready.
 *
 * Convention: aspect is the direction the slope faces (downhill direction).
 */
export function getAspectAt(lon: number, lat: number): string | null {
  let dzdx: number, dzdy: number;
  const cosLat = Math.cos(lat * (Math.PI / 180));

  // --- Try fine-tile Horn kernel first ---
  const fine = bestFineZoomAt(lon, lat);
  if (fine) {
    const { z, wpx, wpy } = fine;
    const degPerFinePx = 360 / ((1 << z) * TILE_W);
    const fCellW = degPerFinePx * 111_320 * cosLat;
    const fCellH = degPerFinePx * 110_540 * cosLat;

    const fe = fineElevAtWorldPx(wpx, wpy, z);
    if (fe === null || isNaN(fe)) return null;
    const fa = fineElevNeighbour(wpx, wpy, -1, -1, z);
    const fb = fineElevNeighbour(wpx, wpy,  0, -1, z);
    const fc = fineElevNeighbour(wpx, wpy,  1, -1, z);
    const fd = fineElevNeighbour(wpx, wpy, -1,  0, z);
    const ff = fineElevNeighbour(wpx, wpy,  1,  0, z);
    const fg = fineElevNeighbour(wpx, wpy, -1,  1, z);
    const fh = fineElevNeighbour(wpx, wpy,  0,  1, z);
    const fi = fineElevNeighbour(wpx, wpy,  1,  1, z);

    const sa = isNaN(fa) ? fe : fa;
    const sb = isNaN(fb) ? fe : fb;
    const sc = isNaN(fc) ? fe : fc;
    const sd = isNaN(fd) ? fe : fd;
    const sf = isNaN(ff) ? fe : ff;
    const sg = isNaN(fg) ? fe : fg;
    const sh = isNaN(fh) ? fe : fh;
    const si = isNaN(fi) ? fe : fi;

    dzdx = ((sc + 2 * sf + si) - (sa + 2 * sd + sg)) / (8 * fCellW);
    dzdy = ((sg + 2 * sh + si) - (sa + 2 * sb + sc)) / (8 * fCellH);
  } else {
    // --- Fall back to Z=9 global grid ---
    if (!isDemLoaded()) return null;
    const { px, py, valid } = lonLatToPx(lon, lat);
    if (!valid) return null;

    const degPerPx = 360 / ((1 << ZOOM) * TILE_W);
    const cellW = degPerPx * 111_320 * cosLat;
    const cellH = degPerPx * 110_540 * cosLat;

    const ev = gridElev(px, py);
    if (isNaN(ev)) return null;
    const a = gridElev(px - 1, py - 1);
    const b = gridElev(px,     py - 1);
    const c = gridElev(px + 1, py - 1);
    const d = gridElev(px - 1, py    );
    const f = gridElev(px + 1, py    );
    const g = gridElev(px - 1, py + 1);
    const h = gridElev(px,     py + 1);
    const i = gridElev(px + 1, py + 1);

    const sa = isNaN(a) ? ev : a;
    const sb = isNaN(b) ? ev : b;
    const sc = isNaN(c) ? ev : c;
    const sd = isNaN(d) ? ev : d;
    const sf = isNaN(f) ? ev : f;
    const sg = isNaN(g) ? ev : g;
    const sh = isNaN(h) ? ev : h;
    const si = isNaN(i) ? ev : i;

    dzdx = ((sc + 2 * sf + si) - (sa + 2 * sd + sg)) / (8 * cellW);
    dzdy = ((sg + 2 * sh + si) - (sa + 2 * sb + sc)) / (8 * cellH);
  }

  // Downhill bearing: atan2(east, north) with gradient negated
  // In pixel coords: +px = east, +py = south, so north = -dzdy
  let deg = Math.atan2(-dzdx, dzdy) * (180 / Math.PI);
  if (deg < 0) deg += 360;

  if (deg < 22.5 || deg >= 337.5) return 'N';
  if (deg < 67.5)  return 'NE';
  if (deg < 112.5) return 'E';
  if (deg < 157.5) return 'SE';
  if (deg < 202.5) return 'S';
  if (deg < 247.5) return 'SW';
  if (deg < 292.5) return 'W';
  return 'NW';
}

/* ------------------------------------------------------------------ */
/*  Viewport batch sampler                                            */
/* ------------------------------------------------------------------ */

/** Aspect label lookup indexed by the 3-bit encoding (0=N … 7=NW). */
export const DEM_ASPECT_LABELS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'] as const;

/**
 * Convert a 0-255 aspect code to one of the 8 cardinal/intercardinal labels.
 * Code 0 = N (0°), 32 = NE (45°), 64 = E (90°), … 224 = NW (315°).
 */
export function aspectCodeToLabel(code: number): string {
  const idx = Math.round((code & 0xFF) / 32) % 8;
  return DEM_ASPECT_LABELS[idx];
}

/** Per-pixel DEM data pre-sampled for a whole viewport grid. */
export interface DemViewportSamples {
  /** Horn-kernel slope in degrees. */
  slopes: Float32Array;
  /** Elevation in metres. */
  elevations: Float32Array;
  /** Aspect encoded as 0-255 representing 0°-360° (0=N, 64=E, 128=S, 192=W). */
  aspects: Uint8Array;
  /** 1 = valid DEM sample, 0 = outside grid / no data. */
  hasData: Uint8Array;
}

/**
 * Pre-sample slope, elevation and aspect for every cell of a viewport grid.
 *
 * This is ~100–1000× faster than calling getSlopeAt/getElevationAt/getAspectAt
 * per pixel because:
 *   - Mercator Y projections are precomputed once per row (not per pixel).
 *   - Fine-tile lookups use a numeric-keyed in-viewport Map (no string allocs).
 *   - The Horn 3×3 kernel uses direct Float32Array arithmetic for interior
 *     pixels (97 %+ of pixels), bypassing Map lookups entirely.
 *
 * Returns null when the Z=9 base grid is not yet loaded.
 */
export function sampleDemViewport(
  w: number,
  s: number,
  e: number,
  n: number,
  cols: number,
  rows: number,
): DemViewportSamples | null {
  if (!_elevGrid) return null;

  const dx = (e - w) / cols;
  const dy = (n - s) / rows;

  /* ── Precompute Z=9 integer pixel coords (one trig call per row) ── */
  const z9Scale = (1 << ZOOM) * TILE_W;
  const z9DegPx = 360 / z9Scale;

  const z9ColPx = new Int32Array(cols);
  for (let c = 0; c < cols; c++) {
    const lon = w + (c + 0.5) * dx;
    z9ColPx[c] = Math.floor(((lon + 180) / 360) * z9Scale - _tx0 * TILE_W);
  }
  const z9RowPy = new Int32Array(rows);
  const z9RowCW = new Float32Array(rows); // cell width metres per row
  const z9RowCH = new Float32Array(rows); // cell height metres per row
  for (let r = 0; r < rows; r++) {
    const lat = n - (r + 0.5) * dy;
    const rad = lat * (Math.PI / 180);
    const cosR = Math.cos(rad);
    z9RowPy[r] = Math.floor(((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * z9Scale - _ty0 * TILE_W);
    z9RowCW[r] = z9DegPx * 111_320 * cosR;
    z9RowCH[r] = z9DegPx * 110_540 * cosR;
  }
  const gridW9 = _tilesW * TILE_W;
  const gridH9 = _tilesH * TILE_W;

  /* ── Fine-tile setup ──────────────────────────────────────────────
   * Determine the best fine zoom at the viewport centre once.
   * Pre-index tiles covering the viewport with a numeric key so the
   * inner loop never allocates template-literal strings.
   * Key = tx * 65536 + ty  (safe: tx/ty < 2^14 < 65536)             */
  const cLon = (w + e) / 2;
  const cLat = (s + n) / 2;
  const centFine = bestFineZoomAt(cLon, cLat);
  const fz   = centFine?.z ?? 0;

  let fColWpx: Float32Array | null = null;
  let fRowWpy: Float32Array | null = null;
  let fColTx:  Int32Array   | null = null;
  let fRowTy:  Int32Array   | null = null;
  let fColLx:  Uint8Array   | null = null;
  let fRowLy:  Uint8Array   | null = null;
  let fRowCW:  Float32Array | null = null;
  let fRowCH:  Float32Array | null = null;
  const fTileMap = new Map<number, Float32Array>(); // numeric-key tile index

  if (fz > 0) {
    const fScale = (1 << fz) * TILE_W;
    const fDegPx = 360 / fScale;
    fRowCW = new Float32Array(rows);
    fRowCH = new Float32Array(rows);

    fColWpx = new Float32Array(cols);
    fColTx  = new Int32Array(cols);
    fColLx  = new Uint8Array(cols);
    for (let c = 0; c < cols; c++) {
      const lon = w + (c + 0.5) * dx;
      const wpx = ((lon + 180) / 360) * fScale;
      fColWpx[c] = wpx;
      fColTx[c]  = Math.floor(wpx / TILE_W);
      fColLx[c]  = Math.floor(wpx - fColTx[c] * TILE_W);
    }

    fRowWpy = new Float32Array(rows);
    fRowTy  = new Int32Array(rows);
    fRowLy  = new Uint8Array(rows);
    for (let r = 0; r < rows; r++) {
      const lat = n - (r + 0.5) * dy;
      const rad = lat * (Math.PI / 180);
      const cosR = Math.cos(rad);
      const wpy = ((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * fScale;
      fRowWpy[r] = wpy;
      fRowTy[r]  = Math.floor(wpy / TILE_W);
      fRowLy[r]  = Math.floor(wpy - fRowTy[r] * TILE_W);
      fRowCW![r] = fDegPx * 111_320 * cosR;
      fRowCH![r] = fDegPx * 110_540 * cosR;
    }

    // Pre-index tiles covering the viewport
    const minTileX = fColTx[0];
    const maxTileX = fColTx[cols - 1];
    const minTileY = fRowTy[0];
    const maxTileY = fRowTy[rows - 1];
    for (let tx = minTileX; tx <= maxTileX; tx++) {
      for (let ty = minTileY; ty <= maxTileY; ty++) {
        const tile = _fineTiles.get(`${fz}/${tx}/${ty}`);
        if (tile) fTileMap.set(tx * 65536 + ty, tile);
      }
    }
  }

  /* ── Output buffers ───────────────────────────────────────────── */
  const n_px = cols * rows;
  const slopes     = new Float32Array(n_px);
  const elevations = new Float32Array(n_px);
  const aspects    = new Uint8Array(n_px);
  const hasData    = new Uint8Array(n_px);

  /* ── Main loop ────────────────────────────────────────────────── */
  for (let r = 0; r < rows; r++) {
    const py9 = z9RowPy[r];
    const cw9 = z9RowCW[r];
    const ch9 = z9RowCH[r];

    // Fine-tile row data
    const fty    = fz > 0 ? fRowTy![r]  : 0;
    const fly    = fz > 0 ? fRowLy![r]  : 0;
    const fwpy   = fz > 0 ? fRowWpy![r] : 0;
    const fCellW = fz > 0 ? fRowCW![r]  : 0;
    const fCellH = fz > 0 ? fRowCH![r]  : 0;

    for (let c = 0; c < cols; c++) {
      const idx = r * cols + c;

      /* ── Try fine tiles ───────────────────────────────────────── */
      if (fz > 0) {
        const ftx  = fColTx![c];
        const flx  = fColLx![c];
        const fwpx = fColWpx![c];
        const tile = fTileMap.get(ftx * 65536 + fty);

        if (tile) {
          let a: number, b: number, cv: number,
              d: number, ev: number, fv: number,
              g: number, h: number, iv: number;

          if (flx >= 1 && flx <= TILE_W - 2 && fly >= 1 && fly <= TILE_W - 2) {
            /* ── Fast path: all 9 neighbours in the same tile ── */
            const base = fly * TILE_W + flx;
            a  = tile[base - TILE_W - 1]; b  = tile[base - TILE_W]; cv = tile[base - TILE_W + 1];
            d  = tile[base            - 1]; ev = tile[base];          fv = tile[base            + 1];
            g  = tile[base + TILE_W - 1]; h  = tile[base + TILE_W]; iv = tile[base + TILE_W + 1];
          } else {
            /* ── Slow path: cross-tile boundary ── */
            a  = fineElevAtWorldPx(fwpx - 1, fwpy - 1, fz) ?? NaN;
            b  = fineElevAtWorldPx(fwpx,     fwpy - 1, fz) ?? NaN;
            cv = fineElevAtWorldPx(fwpx + 1, fwpy - 1, fz) ?? NaN;
            d  = fineElevAtWorldPx(fwpx - 1, fwpy,     fz) ?? NaN;
            ev = tile[fly * TILE_W + flx]; // centre always in tile
            fv = fineElevAtWorldPx(fwpx + 1, fwpy,     fz) ?? NaN;
            g  = fineElevAtWorldPx(fwpx - 1, fwpy + 1, fz) ?? NaN;
            h  = fineElevAtWorldPx(fwpx,     fwpy + 1, fz) ?? NaN;
            iv = fineElevAtWorldPx(fwpx + 1, fwpy + 1, fz) ?? NaN;
          }

          // Skip pixel if centre is no-data
          if (isNaN(ev)) continue;
          // NaN-safe: substitute centre elevation for missing neighbours
          if (isNaN(a))  a  = ev;  if (isNaN(b))  b  = ev;  if (isNaN(cv)) cv = ev;
          if (isNaN(d))  d  = ev;  if (isNaN(fv)) fv = ev;
          if (isNaN(g))  g  = ev;  if (isNaN(h))  h  = ev;  if (isNaN(iv)) iv = ev;

          const dzdx = ((cv + 2*fv + iv) - (a + 2*d + g)) / (8 * fCellW);
          const dzdy = ((g  + 2*h  + iv) - (a + 2*b + cv)) / (8 * fCellH);
          slopes[idx]     = Math.atan(Math.sqrt(dzdx*dzdx + dzdy*dzdy)) * (180 / Math.PI);
          elevations[idx] = ev;
          let deg = Math.atan2(-dzdx, dzdy) * (180 / Math.PI);
          if (deg < 0) deg += 360;
          aspects[idx] = Math.round(deg * 256 / 360) & 0xFF;
          hasData[idx] = 1;
          continue;
        }
      }

      /* ── Z=9 fallback ─────────────────────────────────────────── */
      const px9 = z9ColPx[c];
      if (px9 < 0 || px9 >= gridW9 || py9 < 0 || py9 >= gridH9) continue;

      const ev = gridElev(px9, py9);
      if (isNaN(ev)) continue; // no-data → leave as 0 (transparent)

      let a  = gridElev(px9 - 1, py9 - 1);
      let b  = gridElev(px9,     py9 - 1);
      let cv = gridElev(px9 + 1, py9 - 1);
      let d  = gridElev(px9 - 1, py9);
      let fv = gridElev(px9 + 1, py9);
      let g  = gridElev(px9 - 1, py9 + 1);
      let h  = gridElev(px9,     py9 + 1);
      let iv = gridElev(px9 + 1, py9 + 1);

      // NaN-safe: substitute centre elevation for missing neighbours
      if (isNaN(a))  a  = ev;  if (isNaN(b))  b  = ev;  if (isNaN(cv)) cv = ev;
      if (isNaN(d))  d  = ev;  if (isNaN(fv)) fv = ev;
      if (isNaN(g))  g  = ev;  if (isNaN(h))  h  = ev;  if (isNaN(iv)) iv = ev;

      const dzdx = ((cv + 2*fv + iv) - (a + 2*d + g)) / (8 * cw9);
      const dzdy = ((g  + 2*h  + iv) - (a + 2*b + cv)) / (8 * ch9);
      slopes[idx]     = Math.atan(Math.sqrt(dzdx*dzdx + dzdy*dzdy)) * (180 / Math.PI);
      elevations[idx] = ev;
      let deg = Math.atan2(-dzdx, dzdy) * (180 / Math.PI);
      if (deg < 0) deg += 360;
      aspects[idx] = Math.round(deg * 256 / 360) & 0xFF;
      hasData[idx] = 1;
    }
  }

  return { slopes, elevations, aspects, hasData };
}
