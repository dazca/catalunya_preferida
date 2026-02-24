/**
 * @file Spatial utilities for distance computation, centroid calculation,
 *       and climate IDW interpolation. Uses raw Haversine math for performance
 *       (avoids @turf/turf overhead for ~17M distance calculations).
 */

const DEG_TO_RAD = Math.PI / 180;
const EARTH_RADIUS_KM = 6371;

/** Minimal point with lat/lon coordinates. */
export interface PointLocation {
  lat: number;
  lon: number;
}

/**
 * Haversine distance between two geographic points in kilometers.
 *
 * @param lat1 - Latitude of point 1 (degrees)
 * @param lon1 - Longitude of point 1 (degrees)
 * @param lat2 - Latitude of point 2 (degrees)
 * @param lon2 - Longitude of point 2 (degrees)
 * @returns Distance in km
 */
export function haversineKm(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number,
): number {
  const dLat = (lat2 - lat1) * DEG_TO_RAD;
  const dLon = (lon2 - lon1) * DEG_TO_RAD;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * DEG_TO_RAD) *
      Math.cos(lat2 * DEG_TO_RAD) *
      Math.sin(dLon / 2) ** 2;
  return EARTH_RADIUS_KM * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * Compute the centroid of a Polygon or MultiPolygon geometry.
 * Uses the arithmetic mean of all exterior ring coordinates.
 *
 * @param geometry - GeoJSON Polygon or MultiPolygon
 * @returns [lon, lat] tuple
 */
export function computeCentroid(
  geometry: GeoJSON.Polygon | GeoJSON.MultiPolygon,
): [number, number] {
  let sumLon = 0;
  let sumLat = 0;
  let count = 0;

  const rings =
    geometry.type === 'Polygon'
      ? [geometry.coordinates[0]]
      : geometry.coordinates.map((poly) => poly[0]);

  for (const ring of rings) {
    for (const coord of ring) {
      sumLon += coord[0];
      sumLat += coord[1];
      count++;
    }
  }

  return count > 0 ? [sumLon / count, sumLat / count] : [0, 0];
}

/**
 * Compute minimum distance (km) from a point to the nearest point in a set.
 *
 * @param lat - Latitude of the query point
 * @param lon - Longitude of the query point
 * @param points - Array of candidate points
 * @returns Minimum distance in km, or Infinity if no points
 */
export function nearestDistanceKm(
  lat: number,
  lon: number,
  points: PointLocation[],
): number {
  let minDist = Infinity;
  for (const p of points) {
    const d = haversineKm(lat, lon, p.lat, p.lon);
    if (d < minDist) minDist = d;
  }
  return minDist;
}

/**
 * Compute distance-to-nearest-point maps for all municipality centroids.
 *
 * @param centroids - Map of municipality codi → [lon, lat]
 * @param points - Array of facility/station locations
 * @returns Map of codi → distance in km to nearest point
 */
export function computeDistanceMap(
  centroids: Record<string, [number, number]>,
  points: PointLocation[],
): Record<string, number> {
  const result: Record<string, number> = {};
  if (points.length === 0) return result;

  for (const [codi, [lon, lat]] of Object.entries(centroids)) {
    result[codi] = nearestDistanceKm(lat, lon, points);
  }
  return result;
}

// ── Point-in-Polygon (ray-casting) ─────────────────────────────────────

/**
 * Ray-casting test: is a point inside a linear ring?
 * Uses the winding-number / crossing-number variant.
 */
function pointInRing(lon: number, lat: number, ring: number[][]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1];
    const xj = ring[j][0], yj = ring[j][1];
    if (
      (yi > lat) !== (yj > lat) &&
      lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi
    ) {
      inside = !inside;
    }
  }
  return inside;
}

/**
 * Check if a point is inside a single polygon (outer ring minus holes).
 */
function isInsidePolygon(
  lon: number,
  lat: number,
  rings: number[][][],
): boolean {
  if (!pointInRing(lon, lat, rings[0])) return false;
  for (let i = 1; i < rings.length; i++) {
    if (pointInRing(lon, lat, rings[i])) return false;
  }
  return true;
}

/**
 * Test whether a point (lon, lat) falls inside a Polygon or MultiPolygon.
 *
 * @param lon - Longitude of the test point
 * @param lat - Latitude of the test point
 * @param geometry - GeoJSON Polygon or MultiPolygon
 * @returns true if the point is inside the geometry
 */
export function pointInPolygon(
  lon: number,
  lat: number,
  geometry: GeoJSON.Polygon | GeoJSON.MultiPolygon,
): boolean {
  if (geometry.type === 'Polygon') {
    return isInsidePolygon(lon, lat, geometry.coordinates);
  }
  return geometry.coordinates.some((poly) =>
    isInsidePolygon(lon, lat, poly),
  );
}

// ── Station IDW ────────────────────────────────────────────────────────

/** Station with geographic position and numeric values to interpolate. */
export interface StationValue {
  lat: number;
  lon: number;
  values: Record<string, number>;
}

/**
 * Inverse Distance Weighting (IDW) interpolation from station readings
 * to municipality centroids.
 *
 * @param centroids - Map of municipality codi → [lon, lat]
 * @param stations - Array of station locations with associated values
 * @param numNearest - Number of nearest stations to use (default: 3)
 * @param power - Distance decay exponent (default: 2)
 * @returns Map of codi → interpolated values
 */
export function idwInterpolate(
  centroids: Record<string, [number, number]>,
  stations: StationValue[],
  numNearest = 3,
  power = 2,
): Record<string, Record<string, number>> {
  const result: Record<string, Record<string, number>> = {};
  if (stations.length === 0) return result;

  for (const [codi, [lon, lat]] of Object.entries(centroids)) {
    const withDist = stations.map((s) => ({
      ...s,
      dist: haversineKm(lat, lon, s.lat, s.lon),
    }));

    withDist.sort((a, b) => a.dist - b.dist);
    const nearest = withDist.slice(0, numNearest);

    // Exact hit — station is at (or very near) the centroid
    if (nearest[0].dist < 0.01) {
      result[codi] = { ...nearest[0].values };
      continue;
    }

    const keys = Object.keys(nearest[0].values);
    const interpolated: Record<string, number> = {};
    let totalWeight = 0;

    for (const s of nearest) {
      const w = 1 / s.dist ** power;
      totalWeight += w;
      for (const key of keys) {
        interpolated[key] = (interpolated[key] || 0) + w * s.values[key];
      }
    }

    for (const key of keys) {
      interpolated[key] = interpolated[key] / totalWeight;
    }

    result[codi] = interpolated;
  }

  return result;
}

/**
 * IDW interpolation for a single query point from station data.
 * Useful for point-based analysis where we don't need to process
 * all municipality centroids.
 *
 * @param lat - Latitude of the query point
 * @param lon - Longitude of the query point
 * @param stations - Array of station locations with values
 * @param numNearest - Number of nearest stations to use (default: 3)
 * @param power - Distance decay exponent (default: 2)
 * @returns Interpolated values at the query point
 */
export function idwInterpolatePoint(
  lat: number,
  lon: number,
  stations: StationValue[],
  numNearest = 3,
  power = 2,
): Record<string, number> {
  if (stations.length === 0) return {};

  const withDist = stations.map((s) => ({
    ...s,
    dist: haversineKm(lat, lon, s.lat, s.lon),
  }));

  withDist.sort((a, b) => a.dist - b.dist);
  const nearest = withDist.slice(0, numNearest);

  if (nearest[0].dist < 0.01) return { ...nearest[0].values };

  const keys = Object.keys(nearest[0].values);
  const result: Record<string, number> = {};
  let totalWeight = 0;

  for (const s of nearest) {
    const w = 1 / s.dist ** power;
    totalWeight += w;
    for (const key of keys) {
      result[key] = (result[key] || 0) + w * s.values[key];
    }
  }

  for (const key of keys) {
    result[key] /= totalWeight;
  }

  return result;
}
