/**
 * @file Download healthcare and educational facilities from Equipaments de Catalunya
 *       (Socrata dataset 8gmd-gz7i). Filters by type to produce separate GeoJSON files.
 */
import { writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const RESOURCES = join(__dirname, '..', 'resources');

const SOCRATA_BASE = 'https://analisi.transparenciacatalunya.cat/resource';

async function fetchSocrata(datasetId, params = {}) {
  const pageSize = 10000;
  const all = [];
  let offset = 0;

  while (true) {
    const queryParams = new URLSearchParams({ ...params, $limit: String(pageSize), $offset: String(offset) });
    const url = `${SOCRATA_BASE}/${datasetId}.json?${queryParams}`;
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Socrata ${response.status}`);
    const page = await response.json();
    all.push(...page);
    if (page.length < pageSize) break;
    offset += pageSize;
    await new Promise(r => setTimeout(r, 300));
  }

  return all;
}

function toGeoJSON(facilities) {
  return {
    type: 'FeatureCollection',
    features: facilities
      .filter(f => f.lat && f.lon)
      .map(f => ({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [f.lon, f.lat] },
        properties: {
          name: f.name,
          type: f.type,
          subtype: f.subtype || '',
          municipality: f.municipality || '',
          lat: f.lat,
          lon: f.lon,
        },
      })),
  };
}

async function main() {
  console.log('[Facilities] Downloading equipaments dataset...');

  try {
    const data = await fetchSocrata('8gmd-gz7i');
    console.log(`  Got ${data.length} facility records`);

    const healthFacilities = [];
    const schools = [];
    const amenities = [];

    for (const record of data) {
      const lat = parseFloat(record.latitud || '0');
      const lon = parseFloat(record.longitud || '0');
      const name = record.nom || record.alies || '';
      // categoria is pipe-delimited, e.g. "Sanitat|Hospitals|Centre hospitalari|"
      const categoria = (record.categoria || '').toLowerCase();
      const municipality = record.poblacio || '';
      const codiMuni = record.codi_municipi || '';

      if (lat === 0 && lon === 0) continue;

      const facility = { name, type: categoria.split('|')[0], subtype: categoria, municipality, codiMuni, lat, lon };

      if (categoria.includes('sanit') || categoria.includes('salut') || categoria.includes('hospital')
          || categoria.includes('farmà') || categoria.includes('cap ') || categoria.includes('centre d\'atenció')) {
        healthFacilities.push(facility);
      } else if (categoria.includes('educa') || categoria.includes('ensen') || categoria.includes('escola')
          || categoria.includes('institut') || categoria.includes('llar d\'infants') || categoria.includes('universit')) {
        schools.push(facility);
      } else if (
        categoria.includes('cultur') || categoria.includes('esport') || categoria.includes('lleure') ||
        categoria.includes('biblio') || categoria.includes('museu') || categoria.includes('teatr') ||
        categoria.includes('cinema') || categoria.includes('piscin')
      ) {
        amenities.push(facility);
      }
    }

    // Save healthcare
    const healthDir = join(RESOURCES, 'health');
    mkdirSync(healthDir, { recursive: true });
    writeFileSync(join(healthDir, 'facilities.geojson'), JSON.stringify(toGeoJSON(healthFacilities)));
    console.log(`  Saved ${healthFacilities.length} health facilities`);

    // Save schools
    const eduDir = join(RESOURCES, 'education');
    mkdirSync(eduDir, { recursive: true });
    writeFileSync(join(eduDir, 'schools.geojson'), JSON.stringify(toGeoJSON(schools)));
    console.log(`  Saved ${schools.length} schools`);

    // Save amenities
    const amenDir = join(RESOURCES, 'amenities');
    mkdirSync(amenDir, { recursive: true });
    writeFileSync(join(amenDir, 'facilities.geojson'), JSON.stringify(toGeoJSON(amenities)));
    console.log(`  Saved ${amenities.length} amenities`);
  } catch (err) {
    console.error('  Failed:', err.message);
    // Create empty placeholders
    for (const dir of ['health', 'education', 'amenities']) {
      const d = join(RESOURCES, dir);
      mkdirSync(d, { recursive: true });
      writeFileSync(join(d, dir === 'education' ? 'schools.geojson' : 'facilities.geojson'),
        JSON.stringify({ type: 'FeatureCollection', features: [] }));
    }
  }

  console.log('Done: facilities.\n');
}

main().catch(console.error);
