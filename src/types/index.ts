/**
 * @file Core type definitions for data layers and filters.
 */
import type { FeatureCollection, Feature, Point, Polygon, MultiPolygon } from 'geojson';

/** Identifiers for all available data layers (each sub-metric is its own layer). */
export type LayerId =
  | 'terrainSlope'
  | 'terrainElevation'
  | 'terrainAspect'
  | 'votesLeft'
  | 'votesRight'
  | 'votesIndep'
  | 'votesUnionist'
  | 'votesTurnout'
  // Party vote layers — major
  | 'votesERC'
  | 'votesCUP'
  | 'votesPODEM'
  | 'votesJUNTS'
  | 'votesCOMUNS'
  | 'votesPP'
  | 'votesVOX'
  | 'votesPSC'
  // Party vote layers — minor (Others)
  | 'votesCs'
  | 'votesPDeCAT'
  | 'votesCiU'
  | 'votesOtherParties'
  // Political axis layers (auto-derived from POLITICAL_AXES registry)
  | `axis_${string}`
  | 'transit'
  | 'forest'
  | 'soil'
  | 'airQualityPm10'
  | 'airQualityNo2'
  | 'crime'
  | 'healthcare'
  | 'schools'
  | 'internet'
  | 'noise'
  | 'climateTemp'
  | 'climateRainfall'
  | 'rentalPrices'
  | 'employment'
  | 'amenities';

/** Metadata describing a layer */
export interface LayerMeta {
  id: LayerId;
  label: string;
  description: string;
  icon: string;
  enabled: boolean;
  weight: number;
}

/** Municipality properties in the GeoJSON */
export interface MunicipalityProperties {
  nom: string;
  codi: string;
  comarca: string;
  /** Composite score 0-1 based on active filters */
  score?: number;
  /** Per-layer scores */
  layerScores?: Partial<Record<LayerId, number>>;
}

/** A municipality GeoJSON feature */
export type MunicipalityFeature = Feature<Polygon | MultiPolygon, MunicipalityProperties>;
export type MunicipalityCollection = FeatureCollection<Polygon | MultiPolygon, MunicipalityProperties>;

/** Transit station properties */
export interface TransitStopProperties {
  name: string;
  system: 'fgc' | 'renfe' | 'metro' | 'bus' | 'other';
  line?: string;
  lat: number;
  lon: number;
}

export type TransitStopFeature = Feature<Point, TransitStopProperties>;
export type TransitStopCollection = FeatureCollection<Point, TransitStopProperties>;

/** Facility (healthcare, school, amenity) properties */
export interface FacilityProperties {
  name: string;
  type: string;
  subtype?: string;
  municipality?: string;
  lat: number;
  lon: number;
}

export type FacilityFeature = Feature<Point, FacilityProperties>;
export type FacilityCollection = FeatureCollection<Point, FacilityProperties>;

/** Vote sentiment aggregated per municipality */
export interface VoteSentiment {
  codi: string;
  nom: string;
  leftPct: number;
  rightPct: number;
  independencePct: number;
  unionistPct: number;
  turnoutPct: number;
  year: number;
  /** Per-party vote percentages (e.g. { ERC: 25.3, PSC: 18.1, ... }) */
  partyPcts?: Record<string, number>;
  /** Per-axis sentiment scores (computed at runtime from partyPcts × axis weights) */
  axisPcts?: Record<string, number>;
}

/** Climate stats per municipality */
export interface ClimateStats {
  codi: string;
  avgTempC: number;
  avgRainfallMm: number;
  avgWindKmh: number;
}

/** Air quality station reading (codi = 5-digit INE of the station municipality) */
export interface AirQualityReading {
  codi: string;
  stationId: string;
  stationName: string;
  lat: number;
  lon: number;
  municipi?: string;
  no2?: number;
  pm10?: number;
  pm25?: number;
  o3?: number;
}

/** Raw climate station reading from station_climate.json */
export interface RawClimateStation {
  id: string;
  avgTemp: number;
  avgPrecip: number;
}

/** Climate station GeoJSON properties from stations.geojson */
export interface ClimateStationProperties {
  id: string;
  name: string;
  municipality: string;
  altitude: number;
}

/** Climate station GeoJSON feature */
export type ClimateStationFeature = Feature<Point, ClimateStationProperties>;
export type ClimateStationCollection = FeatureCollection<Point, ClimateStationProperties>;

/** Crime rate per municipality */
export interface CrimeRate {
  codi: string;
  nom: string;
  totalOffenses: number;
  ratePerThousand: number;
  year: number;
}

/** Rental price per municipality */
export interface RentalPrice {
  codi: string;
  nom: string;
  avgEurMonth: number;
  eurPerSqm: number;
  year: number;
  quarter: number;
}

/** Employment/economic data per municipality */
export interface EmploymentData {
  codi: string;
  nom: string;
  population: number;
  unemploymentPct: number;
  avgIncome?: number;
}

/** Terrain stats per municipality */
export interface TerrainStats {
  codi: string;
  avgSlopeDeg: number;
  dominantAspect: string;
  avgElevationM: number;
}

/** Forest cover per municipality */
export interface ForestCover {
  codi: string;
  forestPct: number;
  agriculturalPct: number;
  urbanPct: number;
}

/** Internet coverage per municipality */
export interface InternetCoverage {
  codi: string;
  fiberPct: number;
  adslPct: number;
  coverageScore: number;
}

/** Filter state for all layers */
export interface FilterState {
  terrain: {
    maxSlopeDeg: number;
    aspects: string[];
    minElevation: number;
    maxElevation: number;
  };
  votes: {
    axis: 'left-right' | 'independence';
    minLeftPct: number;
    minIndependencePct: number;
  };
  transit: {
    maxDistanceKm: number;
    systems: string[];
  };
  forest: {
    minForestPct: number;
  };
  soil: {
    aquiferRequired: boolean;
  };
  airQuality: {
    maxPm10: number;
    maxNo2: number;
  };
  crime: {
    maxRatePerThousand: number;
  };
  healthcare: {
    maxDistanceKm: number;
  };
  schools: {
    maxDistanceKm: number;
  };
  internet: {
    minFiberPct: number;
  };
  noise: {
    maxDb: number;
  };
  climate: {
    minAvgTempC: number;
    maxAvgTempC: number;
    maxRainfallMm: number;
  };
  rentalPrices: {
    maxEurMonth: number;
  };
  employment: {
    maxUnemploymentPct: number;
  };
  amenities: {
    maxDistanceKm: number;
  };
}
