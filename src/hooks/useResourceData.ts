/**
 * @file Hook to load all static resource data files from the public/resources directory.
 *       Computes municipality centroids, nearest-facility distances, and
 *       climate interpolation from station data.
 */
import { useState, useEffect } from 'react';
import type {
  MunicipalityCollection,
  VoteSentiment,
  CrimeRate,
  RentalPrice,
  EmploymentData,
  ClimateStats,
  ForestCover,
  TerrainStats,
  AirQualityReading,
  InternetCoverage,
  TransitStopCollection,
  FacilityCollection,
  RawClimateStation,
  ClimateStationCollection,
} from '../types';
import type { MunicipalityData } from '../utils/scorer';
import type { FacilityPoints } from '../utils/pointAnalysis';
import {
  computeCentroid,
  computeDistanceMap,
  idwInterpolate,
} from '../utils/spatial';
import type { PointLocation, StationValue } from '../utils/spatial';

interface ResourceData {
  municipalities: MunicipalityCollection | null;
  municipalityData: MunicipalityData;
  /** Municipality centroids: 5-digit INE -> [lon, lat] */
  centroids: Record<string, [number, number]>;
  /** Facility point arrays for point-based analysis. */
  facilityPoints: FacilityPoints;
  /** Climate station values for point-based IDW interpolation. */
  climateStations: StationValue[];
  transitStops: TransitStopCollection | null;
  healthFacilities: FacilityCollection | null;
  schools: FacilityCollection | null;
  amenities: FacilityCollection | null;
  loading: boolean;
  error: string | null;
}

const EMPTY_DATA: MunicipalityData = {
  terrain: {},
  votes: {},
  forest: {},
  crime: {},
  rentalPrices: {},
  employment: {},
  climate: {},
  airQuality: {},
  internet: {},
  transitDistKm: {},
  healthcareDistKm: {},
  schoolDistKm: {},
  amenityDistKm: {},
};

/**
 * Safely fetch a JSON resource. Returns null if not found.
 */
async function fetchJson<T>(path: string): Promise<T | null> {
  try {
    const resp = await fetch(path);
    if (!resp.ok) return null;
    return (await resp.json()) as T;
  } catch {
    return null;
  }
}

/** Build a resource URL that respects Vite base path in production. */
function resourceUrl(relativePath: string): string {
  const base = import.meta.env.BASE_URL || '/';
  return `${base.replace(/\/$/, '')}/${relativePath.replace(/^\//, '')}`;
}

/**
 * Normalize a municipality code to its 5-digit INE code.
 * - 6-digit GeoJSON codes (e.g. "170010") -> first 5 digits ("17001")
 * - 10-digit vote codes (e.g. "1700100000") -> first 5 digits ("17001")
 * - 5-digit codes pass through unchanged
 */
function normalizeIne(code: string): string {
  return code.substring(0, 5);
}

/**
 * Convert an array of objects with a `codi` field into a Record<string, T>,
 * normalized to 5-digit INE code.
 */
function indexByCodi<T extends { codi: string }>(arr: T[] | null): Record<string, T> {
  if (!arr) return {};
  const map: Record<string, T> = {};
  for (const item of arr) {
    map[normalizeIne(item.codi)] = item;
  }
  return map;
}

/**
 * Extract PointLocation array from a GeoJSON FeatureCollection of Points.
 * Reads coordinates from geometry (more reliable than property lat/lon).
 */
function extractPoints(fc: FacilityCollection | TransitStopCollection | null): PointLocation[] {
  if (!fc) return [];
  const points: PointLocation[] = [];
  for (const f of fc.features) {
    if (f.geometry?.type === 'Point') {
      const [lon, lat] = f.geometry.coordinates;
      if (isFinite(lat) && isFinite(lon)) {
        points.push({ lat, lon });
      }
    }
  }
  return points;
}

/**
 * Compute municipality centroids from MultiPolygon geometries.
 *
 * @returns Map of 5-digit INE code -> [lon, lat]
 */
function buildCentroids(
  municipalities: MunicipalityCollection,
): Record<string, [number, number]> {
  const centroids: Record<string, [number, number]> = {};
  for (const f of municipalities.features) {
    const codi = normalizeIne(f.properties.codi);
    centroids[codi] = computeCentroid(f.geometry);
  }
  return centroids;
}

/**
 * Join climate station readings with station GeoJSON positions and
 * interpolate to municipality centroids using IDW (nearest 3 stations).
 */
function interpolateClimate(
  centroids: Record<string, [number, number]>,
  stationReadings: RawClimateStation[] | null,
  stationGeo: ClimateStationCollection | null,
): Record<string, ClimateStats> {
  if (!stationReadings?.length || !stationGeo?.features?.length) return {};

  // Build station id → coordinate lookup
  const stationCoords: Record<string, [number, number]> = {};
  for (const f of stationGeo.features) {
    if (f.geometry?.type === 'Point') {
      stationCoords[f.properties.id] = [
        f.geometry.coordinates[0],
        f.geometry.coordinates[1],
      ];
    }
  }

  // Merge readings + coordinates into StationValue array
  const stationsWithValues = stationReadings
    .filter((s) => stationCoords[s.id])
    .map((s) => {
      const [lon, lat] = stationCoords[s.id];
      return {
        lat,
        lon,
        values: { avgTempC: s.avgTemp, avgRainfallMm: s.avgPrecip },
      };
    });

  if (stationsWithValues.length === 0) return {};

  const interpolated = idwInterpolate(centroids, stationsWithValues, 3, 2);

  const result: Record<string, ClimateStats> = {};
  for (const [codi, vals] of Object.entries(interpolated)) {
    result[codi] = {
      codi,
      avgTempC: vals.avgTempC,
      avgRainfallMm: vals.avgRainfallMm,
      avgWindKmh: 0,
    };
  }
  return result;
}

export function useResourceData(): ResourceData {
  const [state, setState] = useState<ResourceData>({
    municipalities: null,
    municipalityData: EMPTY_DATA,
    centroids: {},
    facilityPoints: { transit: [], health: [], schools: [], amenities: [] },
    climateStations: [],
    transitStops: null,
    healthFacilities: null,
    schools: null,
    amenities: null,
    loading: true,
    error: null,
  });

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const [
          municipalities,
          terrainArr,
          votesArr,
          forestArr,
          crimeArr,
          rentalArr,
          employmentArr,
          airArr,
          internetArr,
          transitStops,
          healthFacilities,
          schoolsData,
          amenitiesData,
          climateStations,
          climateStationGeo,
        ] = await Promise.all([
          fetchJson<MunicipalityCollection>(resourceUrl('resources/geo/municipis.geojson')),
          fetchJson<TerrainStats[]>(resourceUrl('resources/terrain/municipality_terrain_stats.json')),
          fetchJson<VoteSentiment[]>(resourceUrl('resources/votes/municipal_sentiment.json')),
          fetchJson<ForestCover[]>(resourceUrl('resources/vegetation/forest_cover.json')),
          fetchJson<CrimeRate[]>(resourceUrl('resources/crime/crime_by_municipality.json')),
          fetchJson<RentalPrice[]>(resourceUrl('resources/economy/rental_prices.json')),
          fetchJson<EmploymentData[]>(resourceUrl('resources/economy/employment.json')),
          fetchJson<AirQualityReading[]>(resourceUrl('resources/air/stations.json')),
          fetchJson<InternetCoverage[]>(resourceUrl('resources/internet/coverage.json')),
          fetchJson<TransitStopCollection>(resourceUrl('resources/transit/all_stations.geojson')),
          fetchJson<FacilityCollection>(resourceUrl('resources/health/facilities.geojson')),
          fetchJson<FacilityCollection>(resourceUrl('resources/education/schools.geojson')),
          fetchJson<FacilityCollection>(resourceUrl('resources/amenities/facilities.geojson')),
          fetchJson<RawClimateStation[]>(resourceUrl('resources/climate/station_climate.json')),
          fetchJson<ClimateStationCollection>(resourceUrl('resources/climate/stations.geojson')),
        ]);

        if (cancelled) return;

        // -- Compute municipality centroids --
        const centroids = municipalities ? buildCentroids(municipalities) : {};

        // -- Extract point arrays from facility GeoJSON --
        const transitPts = extractPoints(transitStops);
        const healthPts = extractPoints(healthFacilities);
        const schoolPts = extractPoints(schoolsData);
        const amenityPts = extractPoints(amenitiesData);

        // -- Nearest-facility distance maps --
        const transitDistKm = computeDistanceMap(centroids, transitPts);
        const healthcareDistKm = computeDistanceMap(centroids, healthPts);
        const schoolDistKm = computeDistanceMap(centroids, schoolPts);
        const amenityDistKm = computeDistanceMap(centroids, amenityPts);

        // -- Climate: IDW interpolation from station readings --
        const climate = interpolateClimate(centroids, climateStations, climateStationGeo);

        // Build climate StationValue array for point-based analysis
        const climateStationValues: StationValue[] = [];
        if (climateStations?.length && climateStationGeo?.features?.length) {
          const stCoords: Record<string, [number, number]> = {};
          for (const f of climateStationGeo.features) {
            if (f.geometry?.type === 'Point') {
              stCoords[f.properties.id] = [
                f.geometry.coordinates[0],
                f.geometry.coordinates[1],
              ];
            }
          }
          for (const s of climateStations) {
            const c = stCoords[s.id];
            if (c) {
              climateStationValues.push({
                lat: c[1],
                lon: c[0],
                values: { avgTempC: s.avgTemp, avgRainfallMm: s.avgPrecip },
              });
            }
          }
        }

        // -- Air quality: stations already have codi (5-digit INE) --
        const airQuality = indexByCodi(airArr);

        const municipalityData: MunicipalityData = {
          terrain: indexByCodi(terrainArr),
          votes: indexByCodi(votesArr),
          forest: indexByCodi(forestArr),
          crime: indexByCodi(crimeArr),
          rentalPrices: indexByCodi(rentalArr),
          employment: indexByCodi(employmentArr),
          climate,
          airQuality,
          internet: indexByCodi(internetArr),
          transitDistKm,
          healthcareDistKm,
          schoolDistKm,
          amenityDistKm,
        };

        setState({
          municipalities,
          municipalityData,
          centroids,
          facilityPoints: {
            transit: transitPts,
            health: healthPts,
            schools: schoolPts,
            amenities: amenityPts,
          },
          climateStations: climateStationValues,
          transitStops,
          healthFacilities,
          schools: schoolsData,
          amenities: amenitiesData,
          loading: false,
          error: null,
        });
      } catch (err) {
        if (!cancelled) {
          setState((prev) => ({
            ...prev,
            loading: false,
            error: err instanceof Error ? err.message : 'Unknown error loading resources',
          }));
        }
      }
    }

    load();
    return () => {
      cancelled = true;
    };
  }, []);

  return state;
}
