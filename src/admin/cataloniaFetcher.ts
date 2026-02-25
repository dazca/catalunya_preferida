/**
 * @file Catalonia real-DEM fetcher using Open-Meteo Elevation API.
 *       Includes retry with exponential backoff for 429 rate-limit errors.
 */

const CHUNK = 100;
const MAX_RETRIES = 6;
const BASE_DELAY_MS = 1500;
const INTER_CHUNK_DELAY_MS = 350;

/** Sleep helper. */
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Parse Retry-After header value (seconds or HTTP-date).
 * Returns milliseconds to wait, or null if unparseable.
 */
function parseRetryAfter(header: string | null): number | null {
  if (!header) return null;
  const secs = Number(header);
  if (Number.isFinite(secs) && secs > 0) return secs * 1000;
  // Try HTTP-date (e.g. "Wed, 21 Oct 2015 07:28:00 GMT")
  const date = Date.parse(header);
  if (Number.isFinite(date)) {
    const delta = date - Date.now();
    return delta > 0 ? delta : 1000;
  }
  return null;
}

/**
 * Fetch a single chunk with retry on 429 rate-limit.
 * Reports delays via optional onWait callback.
 */
async function fetchChunkWithRetry(
  url: string,
  onWait?: (msg: string) => void,
): Promise<Response> {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const resp = await fetch(url);
    if (resp.status !== 429) return resp;

    if (attempt === MAX_RETRIES) {
      return resp; // give up, return the 429
    }

    const retryMs = parseRetryAfter(resp.headers.get('Retry-After'))
      ?? BASE_DELAY_MS * Math.pow(2, attempt);
    const delaySec = (retryMs / 1000).toFixed(1);
    onWait?.(`Rate-limited (429). Retry ${attempt + 1}/${MAX_RETRIES} in ${delaySec}s…`);
    await sleep(retryMs);
  }
  // Unreachable, but satisfies TS
  return fetch(url);
}

export interface ElevationResult {
  dem: Float64Array;
  N: number;
}

export async function fetchElevationGrid(
  latMin: number,
  latMax: number,
  lonMin: number,
  lonMax: number,
  res: number,
  onProgress?: (fetched: number, total: number) => void,
  onStatus?: (msg: string) => void,
): Promise<ElevationResult> {
  const N = res;
  const lats: string[] = [];
  const lons: string[] = [];
  const dLat = (latMax - latMin) / (N - 1);
  const dLon = (lonMax - lonMin) / (N - 1);

  // Row-major, Y=0 is NORTH (latMax), Y=N-1 is SOUTH (latMin)
  for (let row = 0; row < N; row++) {
    const lat = latMax - row * dLat;
    for (let col = 0; col < N; col++) {
      const lon = lonMin + col * dLon;
      lats.push(lat.toFixed(6));
      lons.push(lon.toFixed(6));
    }
  }

  const total = lats.length;
  const elevations = new Float64Array(total);
  let fetched = 0;

  for (let i = 0; i < total; i += CHUNK) {
    const chunkLats = lats.slice(i, i + CHUNK).join(',');
    const chunkLons = lons.slice(i, i + CHUNK).join(',');
    const url = `https://api.open-meteo.com/v1/elevation?latitude=${chunkLats}&longitude=${chunkLons}`;

    const resp = await fetchChunkWithRetry(url, onStatus);
    if (!resp.ok) throw new Error(`API returned ${resp.status} after ${MAX_RETRIES} retries`);
    const data = await resp.json();

    const elev: (number | null)[] = data.elevation;
    for (let j = 0; j < elev.length; j++) {
      elevations[i + j] = elev[j] != null ? elev[j]! : 0;
    }

    fetched += elev.length;
    onProgress?.(fetched, total);

    // Courtesy delay between chunks to avoid triggering 429
    if (i + CHUNK < total) await sleep(INTER_CHUNK_DELAY_MS);
  }

  return { dem: elevations, N };
}
