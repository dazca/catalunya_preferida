/**
 * @file Generate placeholder data for layers that require heavy processing:
 *       - Terrain stats (would need DEM raster processing)
 *       - Forest/vegetation cover (would need MCSC raster/vector processing)
 *       - Soil/aquifer data (from ACA WFS)
 *       - Internet coverage (from CNMC, not in Socrata)
 *
 *       For terrain and forest, we generate synthetic but realistic data
 *       based on known Catalonia geography until proper raster processing
 *       pipeline is in place.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const RESOURCES = join(__dirname, '..', 'resources');

/**
 * Simple seeded PRNG for reproducible test data.
 */
function seededRandom(seed) {
  let x = seed;
  return () => {
    x = (x * 1103515245 + 12345) & 0x7fffffff;
    return x / 0x7fffffff;
  };
}

function generateTerrainStats(municipisCodes) {
  const rng = seededRandom(42);
  return municipisCodes.map(codi => {
    const numCodi = parseInt(codi.replace(/\D/g, ''), 10) || 0;
    // Higher municipality codes tend to be more mountainous in Catalonia
    const mountainFactor = Math.min(1, (numCodi % 1000) / 500);

    return {
      codi,
      avgSlopeDeg: Math.round((rng() * 25 + mountainFactor * 20) * 10) / 10,
      dominantAspect: ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.floor(rng() * 8)],
      avgElevationM: Math.round(50 + rng() * 500 + mountainFactor * 800),
    };
  });
}

function generateForestCover(municipisCodes) {
  const rng = seededRandom(123);
  return municipisCodes.map(codi => {
    const forest = Math.round(rng() * 70 * 10) / 10;
    const urban = Math.round(rng() * (100 - forest) * 0.4 * 10) / 10;
    const agri = Math.round((100 - forest - urban) * 10) / 10;

    return {
      codi,
      forestPct: forest,
      agriculturalPct: Math.max(0, agri),
      urbanPct: urban,
    };
  });
}

function generateInternetCoverage(municipisCodes) {
  const rng = seededRandom(456);
  return municipisCodes.map(codi => ({
    codi,
    fiberPct: Math.round(rng() * 100 * 10) / 10,
    adslPct: Math.round((80 + rng() * 20) * 10) / 10,
    coverageScore: Math.round(rng() * 100 * 10) / 10,
  }));
}

async function main() {
  console.log('[Synthetic] Generating placeholder data for terrain, forest, soil, internet...');

  // Load municipality codes from downloaded GeoJSON
  const geoPath = join(RESOURCES, 'geo', 'municipis.geojson');
  let municipisCodes = [];

  if (existsSync(geoPath)) {
    try {
      const geojson = JSON.parse(readFileSync(geoPath, 'utf-8'));
      municipisCodes = geojson.features
        .map(f => f.properties?.codi || f.properties?.codi_muni || '')
        .filter(Boolean);
      console.log(`  Found ${municipisCodes.length} municipality codes from GeoJSON`);
    } catch {
      console.log('  Could not parse municipis.geojson, using sample codes');
    }
  }

  // Fallback sample codes if none found
  if (municipisCodes.length === 0) {
    municipisCodes = Array.from({ length: 947 }, (_, i) => String(8001 + i).padStart(5, '0'));
    console.log(`  Using ${municipisCodes.length} synthetic municipality codes`);
  }

  // Terrain stats
  const terrainDir = join(RESOURCES, 'terrain');
  mkdirSync(terrainDir, { recursive: true });
  const terrain = generateTerrainStats(municipisCodes);
  writeFileSync(join(terrainDir, 'municipality_terrain_stats.json'), JSON.stringify(terrain, null, 2));
  console.log(`  Saved terrain stats for ${terrain.length} municipalities`);

  // Forest cover
  const vegDir = join(RESOURCES, 'vegetation');
  mkdirSync(vegDir, { recursive: true });
  const forest = generateForestCover(municipisCodes);
  writeFileSync(join(vegDir, 'forest_cover.json'), JSON.stringify(forest, null, 2));
  console.log(`  Saved forest cover for ${forest.length} municipalities`);

  // Internet coverage
  const netDir = join(RESOURCES, 'internet');
  mkdirSync(netDir, { recursive: true });
  const internet = generateInternetCoverage(municipisCodes);
  writeFileSync(join(netDir, 'coverage.json'), JSON.stringify(internet, null, 2));
  console.log(`  Saved internet coverage for ${internet.length} municipalities`);

  // Soil/aquifers placeholder
  const soilDir = join(RESOURCES, 'soil');
  mkdirSync(soilDir, { recursive: true });
  writeFileSync(join(soilDir, 'aquifers.geojson'), JSON.stringify({ type: 'FeatureCollection', features: [] }));
  console.log('  Saved empty aquifers placeholder');

  // Noise placeholder
  const noiseDir = join(RESOURCES, 'noise');
  mkdirSync(noiseDir, { recursive: true });
  writeFileSync(join(noiseDir, 'README.md'),
    '# Noise Data\nBarcelona noise maps can be downloaded from:\nhttps://opendata-ajuntament.barcelona.cat/data/en/dataset/rasters-mapa-estrategic-soroll\n');
  console.log('  Saved noise placeholder');

  console.log('Done: synthetic/placeholder data.\n');
}

main().catch(console.error);
