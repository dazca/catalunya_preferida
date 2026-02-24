/**
 * @file Download municipal election results from the Socrata Open Data API.
 *       Processes raw vote data into left/right and independence/unionist sentiment.
 */
import { writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const RESOURCES = join(__dirname, '..', 'resources');

const SOCRATA_BASE = 'https://analisi.transparenciacatalunya.cat/resource';

/**
 * Parties classified by political axis.
 * LEFT includes: PSC, ERC, CUP, Podem, ICV, EUiA, Comuns
 * INDEPENDENCE includes: ERC, JxCat, CUP, CDC, CiU (partial), PDeCAT
 */
const LEFT_PARTIES = [
  'psc', 'erc', 'cup', 'podem', 'icv', 'euia', 'comuns', 'bcomú', 'en comú',
  'iniciativa', 'esquerra', 'socialistes', 'podemos', 'sumar',
  'barcelona en comú', 'catalan european democratic party',
];

const INDEPENDENCE_PARTIES = [
  'erc', 'jxcat', 'cup', 'cdc', 'ciu', 'pdecat', 'junts',
  'convergència', 'esquerra republicana', 'junts per catalunya',
  'candidatura d\'unitat popular',
];

/**
 * Check if a candidature name matches a party list (case-insensitive partial match).
 */
function matchesParty(candidatura, partyList) {
  const lower = candidatura.toLowerCase();
  return partyList.some(p => lower.includes(p));
}

/**
 * Fetch paginated data from Socrata.
 */
async function fetchSocrata(datasetId, params = {}, maxRecords = 100000) {
  const pageSize = 10000;
  const allRecords = [];
  let offset = 0;

  while (offset < maxRecords) {
    const queryParams = new URLSearchParams({
      ...params,
      $limit: String(pageSize),
      $offset: String(offset),
    });

    const url = `${SOCRATA_BASE}/${datasetId}.json?${queryParams}`;
    const response = await fetch(url);

    if (!response.ok) {
      throw new Error(`Socrata ${response.status}: ${response.statusText}`);
    }

    const page = await response.json();
    allRecords.push(...page);

    if (page.length < pageSize) break;
    offset += pageSize;

    // Rate limit courtesy
    await new Promise(r => setTimeout(r, 200));
  }

  return allRecords;
}

async function main() {
  const outDir = join(RESOURCES, 'votes');
  mkdirSync(outDir, { recursive: true });

  console.log('[Votes] Downloading municipal election data...');

  try {
    // Fetch the latest municipal elections data
    // Dataset vq27-2ky2: Municipal elections vote counts
    const rawVotes = await fetchSocrata('vq27-2ky2', {
      $order: 'any_eleccio DESC',
      $where: "any_eleccio >= '2019'",
    });

    console.log(`  Fetched ${rawVotes.length} vote records`);

    // Group by municipality
    const byMunicipality = {};

    for (const record of rawVotes) {
      const codi = record.codi_ens || '';
      const nom = record.municipi || '';
      const candidatura = record.sigles_candidatura || '';
      const vots = parseInt(record.vots || '0', 10);
      const year = parseInt(record.any_eleccio || '0', 10);

      if (!codi || !candidatura) continue;

      if (!byMunicipality[codi]) {
        byMunicipality[codi] = { codi, nom, year, totalVotes: 0, leftVotes: 0, independenceVotes: 0 };
      }

      const muni = byMunicipality[codi];
      if (year > muni.year) {
        muni.year = year;
      }
      muni.totalVotes += vots;

      if (matchesParty(candidatura, LEFT_PARTIES)) {
        muni.leftVotes += vots;
      }
      if (matchesParty(candidatura, INDEPENDENCE_PARTIES)) {
        muni.independenceVotes += vots;
      }
    }

    // Convert to sentiment array
    const sentiment = Object.values(byMunicipality).map(m => ({
      codi: m.codi,
      nom: m.nom,
      leftPct: m.totalVotes > 0 ? Math.round((m.leftVotes / m.totalVotes) * 10000) / 100 : 0,
      rightPct: m.totalVotes > 0 ? Math.round(((m.totalVotes - m.leftVotes) / m.totalVotes) * 10000) / 100 : 0,
      independencePct: m.totalVotes > 0 ? Math.round((m.independenceVotes / m.totalVotes) * 10000) / 100 : 0,
      unionistPct: m.totalVotes > 0 ? Math.round(((m.totalVotes - m.independenceVotes) / m.totalVotes) * 10000) / 100 : 0,
      turnoutPct: 0, // would need participation dataset
      year: m.year,
    }));

    const outPath = join(outDir, 'municipal_sentiment.json');
    writeFileSync(outPath, JSON.stringify(sentiment, null, 2));
    console.log(`  Saved sentiment data for ${sentiment.length} municipalities`);
  } catch (err) {
    console.error('  Failed to download vote data:', err.message);
    writeFileSync(join(outDir, 'municipal_sentiment.json'), '[]');
  }

  console.log('Done: vote sentiment.\n');
}

main().catch(console.error);
