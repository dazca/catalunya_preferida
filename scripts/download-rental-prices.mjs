/**
 * @file Download rental price data from INCASOL.
 *       Socrata dataset qww9-bvhh: Average rental prices by municipality.
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
    await new Promise(r => setTimeout(r, 200));
  }

  return all;
}

async function main() {
  const outDir = join(RESOURCES, 'economy');
  mkdirSync(outDir, { recursive: true });

  console.log('[Rental Prices] Downloading INCASOL rental data...');

  try {
    const data = await fetchSocrata('qww9-bvhh', {
      $where: "ambit_territorial = 'Municipi'",
      $order: 'any DESC',
    });

    console.log(`  Got ${data.length} rental price records`);

    // Take the latest record per municipality
    const byMuni = {};
    for (const record of data) {
      const codi = record.codi_territorial || '';
      const nom = record.nom_territori || '';
      const year = parseInt(record.any || '0', 10);
      const avgPrice = parseFloat(record.renda || '0');
      const nHomes = parseInt(record.habitatges || '0', 10);

      if (!codi || avgPrice === 0) continue;

      const key = codi;
      if (!byMuni[key] || year > byMuni[key].year) {
        byMuni[key] = {
          codi,
          nom,
          avgEurMonth: Math.round(avgPrice * 100) / 100,
          eurPerSqm: 0,
          year,
          nHomes,
        };
      }
    }

    const prices = Object.values(byMuni);
    writeFileSync(join(outDir, 'rental_prices.json'), JSON.stringify(prices, null, 2));
    console.log(`  Saved rental prices for ${prices.length} municipalities`);
  } catch (err) {
    console.error('  Failed:', err.message);
    writeFileSync(join(outDir, 'rental_prices.json'), '[]');
  }

  console.log('Done: rental prices.\n');
}

main().catch(console.error);
