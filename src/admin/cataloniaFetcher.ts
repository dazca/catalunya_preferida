/**
 * @file Catalonia real-DEM fetcher using Open-Meteo Elevation API.
 *       Includes retry with exponential backoff for 429 rate-limit errors.
 */

const CHUNK = 100;
const MAX_RETRIES = 5;
const BASE_DELAY_MS = 500;

/**
 * Fetch a single chunk with retry on 429 rate-limit.
 */
async function fetchChunkWithRetry(url: string): Promise<Response> {
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const resp = await fetch(url);
    if (resp.status === 429) {
      const retryAfter = resp.headers.get('Retry-After');
      const delayMs = retryAfter
        ? parseInt(retryAfter, 10) * 1000
        : BASE_DELAY_MS * Math.pow(2, attempt);
      await new Promise((r) => setTimeout(r, delayMs));
      continue;
    }
    return resp;
  }
  // Final attempt without catch
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

    const resp = await fetchChunkWithRetry(url);
    if (!resp.ok) throw new Error(`API returned ${resp.status}`);
    const data = await resp.json();

    const elev: (number | null)[] = data.elevation;
    for (let j = 0; j < elev.length; j++) {
      elevations[i + j] = elev[j] != null ? elev[j]! : 0;
    }

    fetched += elev.length;
    onProgress?.(fetched, total);

    // Rate-limit courtesy delay between chunks
    if (i + CHUNK < total) await new Promise((r) => setTimeout(r, 120));
  }

  return { dem: elevations, N };
}
