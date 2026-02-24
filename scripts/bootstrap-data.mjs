/**
 * @file Download required runtime datasets from deployed server into public/resources.
 *
 * Usage:
 *   node scripts/bootstrap-data.mjs
 *   node scripts/bootstrap-data.mjs --force
 *
 * Env:
 *   DATA_BASE_URL (default: https://azemar.eu/altres/catmap)
 */
import { mkdirSync, existsSync, statSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = join(__dirname, '..');

const BASE_URL = (process.env.DATA_BASE_URL || 'https://azemar.eu/altres/catmap').replace(/\/$/, '');
const force = process.argv.includes('--force');

const REQUIRED_FILES = [
  'resources/geo/municipis.geojson',
  'resources/terrain/municipality_terrain_stats.json',
  'resources/votes/municipal_sentiment.json',
  'resources/vegetation/forest_cover.json',
  'resources/crime/crime_by_municipality.json',
  'resources/economy/rental_prices.json',
  'resources/economy/employment.json',
  'resources/air/stations.json',
  'resources/internet/coverage.json',
  'resources/transit/all_stations.geojson',
  'resources/health/facilities.geojson',
  'resources/education/schools.geojson',
  'resources/amenities/facilities.geojson',
  'resources/climate/station_climate.json',
  'resources/climate/stations.geojson',
];

function outPath(relPath) {
  return join(ROOT, 'public', relPath);
}

async function downloadFile(relPath) {
  const target = outPath(relPath);
  const dir = dirname(target);
  mkdirSync(dir, { recursive: true });

  if (!force && existsSync(target)) {
    const size = statSync(target).size;
    if (size > 0) {
      console.log(`skip  ${relPath}`);
      return;
    }
  }

  const url = `${BASE_URL}/${relPath}`;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`${resp.status} ${resp.statusText}`);

  const buf = Buffer.from(await resp.arrayBuffer());
  if (buf.length === 0) throw new Error('empty file');

  writeFileSync(target, buf);
  console.log(`saved ${relPath} (${Math.round(buf.length / 1024)} KB)`);
}

async function main() {
  console.log(`Bootstrap source: ${BASE_URL}`);
  console.log(`Bootstrap target: public/resources`);

  let ok = 0;
  let fail = 0;

  for (const relPath of REQUIRED_FILES) {
    try {
      await downloadFile(relPath);
      ok += 1;
    } catch (err) {
      console.error(`fail  ${relPath} -> ${err.message}`);
      fail += 1;
    }
  }

  console.log(`\nDone. downloaded/kept: ${ok}, failed: ${fail}`);
  if (fail > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
