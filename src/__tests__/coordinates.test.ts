/**
 * @file Tests for coordinate conversion utilities.
 */
import { describe, it, expect } from 'vitest';
import { utm31nToWgs84, wgs84ToUtm31n } from '../utils/coordinates';

describe('utm31nToWgs84', () => {
  it('converts a known Barcelona coordinate correctly', () => {
    // Barcelona: approx UTM 31N (431000, 4581000) -> (2.17, 41.39)
    const [lon, lat] = utm31nToWgs84(431000, 4581000);
    expect(lon).toBeCloseTo(2.17, 1);
    expect(lat).toBeCloseTo(41.39, 1);
  });

  it('converts a known Girona coordinate', () => {
    // Girona: approx UTM 31N (486000, 4646000) -> (2.82, 41.98)
    const [lon, lat] = utm31nToWgs84(486000, 4646000);
    expect(lon).toBeCloseTo(2.82, 1);
    expect(lat).toBeCloseTo(41.98, 1);
  });
});

describe('wgs84ToUtm31n', () => {
  it('converts Barcelona WGS84 back to UTM with reasonable accuracy', () => {
    // First get the "true" UTM from our converter, then verify it round-trips
    const [easting, northing] = wgs84ToUtm31n(2.17, 41.39);
    const [lonBack, latBack] = utm31nToWgs84(easting, northing);
    expect(lonBack).toBeCloseTo(2.17, 2);
    expect(latBack).toBeCloseTo(41.39, 2);
  });

  it('round-trips correctly', () => {
    const origE = 450000;
    const origN = 4600000;
    const [lon, lat] = utm31nToWgs84(origE, origN);
    const [e, n] = wgs84ToUtm31n(lon, lat);
    expect(e).toBeCloseTo(origE, 0);
    expect(n).toBeCloseTo(origN, 0);
  });
});
