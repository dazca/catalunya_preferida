/**
 * @file Coordinate conversion utilities.
 *       EPSG:25831 (UTM zone 31N / ETRS89) <-> EPSG:4326 (WGS84 lat/lon).
 *       Uses a simplified formula suitable for Catalonia's extent.
 */

const DEG_TO_RAD = Math.PI / 180;
const RAD_TO_DEG = 180 / Math.PI;
const K0 = 0.9996;
const E = 0.0818192;
const E2 = E * E;
const E_P2 = E2 / (1 - E2);
const A = 6378137.0;

/**
 * Convert EPSG:25831 (UTM 31N) to WGS84 [lon, lat].
 */
export function utm31nToWgs84(easting: number, northing: number): [number, number] {
  const x = easting - 500000;
  const y = northing;

  const m = y / K0;
  const mu = m / (A * (1 - E2 / 4 - 3 * E2 * E2 / 64 - 5 * E2 * E2 * E2 / 256));

  const e1 = (1 - Math.sqrt(1 - E2)) / (1 + Math.sqrt(1 - E2));
  const phi1 =
    mu +
    ((3 * e1) / 2 - (27 * e1 * e1 * e1) / 32) * Math.sin(2 * mu) +
    ((21 * e1 * e1) / 16 - (55 * e1 * e1 * e1 * e1) / 32) * Math.sin(4 * mu) +
    ((151 * e1 * e1 * e1) / 96) * Math.sin(6 * mu);

  const n1 = A / Math.sqrt(1 - E2 * Math.sin(phi1) * Math.sin(phi1));
  const t1 = Math.tan(phi1) * Math.tan(phi1);
  const c1 = E_P2 * Math.cos(phi1) * Math.cos(phi1);
  const r1 = (A * (1 - E2)) / Math.pow(1 - E2 * Math.sin(phi1) * Math.sin(phi1), 1.5);
  const d = x / (n1 * K0);

  const lat =
    phi1 -
    ((n1 * Math.tan(phi1)) / r1) *
      (d * d / 2 - ((5 + 3 * t1 + 10 * c1 - 4 * c1 * c1 - 9 * E_P2) * d * d * d * d) / 24 +
        ((61 + 90 * t1 + 298 * c1 + 45 * t1 * t1 - 252 * E_P2 - 3 * c1 * c1) * d * d * d * d * d * d) / 720);

  const lon =
    (d - ((1 + 2 * t1 + c1) * d * d * d) / 6 +
      ((5 - 2 * c1 + 28 * t1 - 3 * c1 * c1 + 8 * E_P2 + 24 * t1 * t1) * d * d * d * d * d) / 120) /
    Math.cos(phi1);

  const lonDeg = lon * RAD_TO_DEG + 3; // central meridian for zone 31
  const latDeg = lat * RAD_TO_DEG;

  return [lonDeg, latDeg];
}

/**
 * Convert WGS84 [lon, lat] to EPSG:25831 (UTM 31N) [easting, northing].
 */
export function wgs84ToUtm31n(lon: number, lat: number): [number, number] {
  const lonRad = (lon - 3) * DEG_TO_RAD;
  const latRad = lat * DEG_TO_RAD;

  const n = A / Math.sqrt(1 - E2 * Math.sin(latRad) * Math.sin(latRad));
  const t = Math.tan(latRad) * Math.tan(latRad);
  const c = E_P2 * Math.cos(latRad) * Math.cos(latRad);
  const a_ = Math.cos(latRad) * lonRad;

  const m =
    A *
    ((1 - E2 / 4 - 3 * E2 * E2 / 64 - 5 * E2 * E2 * E2 / 256) * latRad -
      ((3 * E2) / 8 + (3 * E2 * E2) / 32 + (45 * E2 * E2 * E2) / 1024) * Math.sin(2 * latRad) +
      ((15 * E2 * E2) / 256 + (45 * E2 * E2 * E2) / 1024) * Math.sin(4 * latRad) -
      ((35 * E2 * E2 * E2) / 3072) * Math.sin(6 * latRad));

  const easting =
    K0 *
      n *
      (a_ + ((1 - t + c) * a_ * a_ * a_) / 6 + ((5 - 18 * t + t * t + 72 * c - 58 * E_P2) * a_ * a_ * a_ * a_ * a_) / 120) +
    500000;

  const northing =
    K0 *
    (m +
      n *
        Math.tan(latRad) *
        ((a_ * a_) / 2 +
          ((5 - t + 9 * c + 4 * c * c) * a_ * a_ * a_ * a_) / 24 +
          ((61 - 58 * t + t * t + 600 * c - 330 * E_P2) * a_ * a_ * a_ * a_ * a_ * a_) / 720));

  return [easting, northing];
}
