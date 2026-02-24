/**
 * @file Download municipality boundaries from ICGC WFS as GeoJSON.
 *       Fetches both municipis and comarques at 1:5000 scale.
 */
import { writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const RESOURCES = join(__dirname, '..', 'resources');

const WFS_BASE = 'https://geoserveis.icgc.cat/servei/catalunya/divisions-administratives/wfs';
const WFS_NS = 'divisions_administratives_wfs';

/**
 * Fetch a WFS layer as GeoJSON.
 * @param {string} typeName - WFS layer name (without namespace prefix)
 * @returns {Promise<object>} GeoJSON FeatureCollection
 */
async function fetchWfsLayer(typeName) {
  const params = new URLSearchParams({
    service: 'WFS',
    version: '2.0.0',
    request: 'GetFeature',
    typeName: `${WFS_NS}:${typeName}`,
    outputFormat: 'GEOJSON',
  });

  const url = `${WFS_BASE}?${params}`;
  console.log(`  Fetching ${typeName}...`);

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`WFS request failed: ${response.status} ${response.statusText}`);
  }

  return response.json();
}

/**
 * Normalize ICGC WFS GeoJSON properties into our standard schema.
 * ICGC uses fields like 'nom_muni', 'codi_muni', 'nom_comarca', etc.
 */
function normalizeProperties(fc, type) {
  for (const feature of fc.features) {
    const p = feature.properties;
    if (type === 'municipis') {
      feature.properties = {
        nom: p.NOMMUNI || p.nom_muni || p.municipi || p.nom || '',
        codi: p.CODIMUNI || p.codi_muni || p.codi || '',
        comarca: p.NOMCOMAR || p.nom_comarca || p.comarca || '',
        capmuni: p.CAPMUNI || '',
        codicomar: p.CODICOMAR || '',
        nomvegue: p.NOMVEGUE || '',
        nomprov: p.NOMPROV || '',
        area: p.AREAM5000 || 0,
      };
    } else {
      feature.properties = {
        nom: p.NOMCOMAR || p.nom_comarca || p.nom || '',
        codi: p.CODICOMAR || p.codi_comarca || p.codi || '',
        capcomar: p.CAPCOMAR || '',
      };
    }
  }
  return fc;
}

async function main() {
  const outDir = join(RESOURCES, 'geo');
  mkdirSync(outDir, { recursive: true });

  console.log('[1/2] Downloading municipality boundaries...');
  try {
    // Use 100k scale for faster download (5k is very detailed/large)
    const municipis = await fetchWfsLayer('divisions_administratives_municipis_100000');
    const normalized = normalizeProperties(municipis, 'municipis');
    const outPath = join(outDir, 'municipis.geojson');
    writeFileSync(outPath, JSON.stringify(normalized));
    console.log(`  Saved ${normalized.features.length} municipalities to municipis.geojson`);
  } catch (err) {
    console.error('  Failed to download municipalities:', err.message);
    // Create a minimal placeholder so the app still loads
    const placeholder = { type: 'FeatureCollection', features: [] };
    writeFileSync(join(outDir, 'municipis.geojson'), JSON.stringify(placeholder));
    console.log('  Created empty placeholder municipis.geojson');
  }

  console.log('[2/2] Downloading comarca boundaries...');
  try {
    const comarques = await fetchWfsLayer('divisions_administratives_comarques_100000');
    const normalized = normalizeProperties(comarques, 'comarques');
    const outPath = join(outDir, 'comarques.geojson');
    writeFileSync(outPath, JSON.stringify(normalized));
    console.log(`  Saved ${normalized.features.length} comarques to comarques.geojson`);
  } catch (err) {
    console.error('  Failed to download comarques:', err.message);
    writeFileSync(join(outDir, 'comarques.geojson'), JSON.stringify({ type: 'FeatureCollection', features: [] }));
  }

  console.log('Done: municipality boundaries.\n');
}

main().catch(console.error);
