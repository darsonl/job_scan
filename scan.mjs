#!/usr/bin/env node

/**
 * scan.mjs — Zero-token portal scanner
 *
 * Fetches Greenhouse, Ashby, and Lever APIs directly, applies title
 * filters from portals.yml, deduplicates against existing history,
 * and appends new offers to pipeline.md + scan-history.tsv.
 *
 * Zero Claude API tokens — pure HTTP + JSON.
 *
 * Usage:
 *   node scan.mjs                        # scan all enabled companies
 *   node scan.mjs --dry-run              # preview without writing files
 *   node scan.mjs --company Cohere       # scan a single company
 *   node scan.mjs --validate-pipeline    # check liveness of existing [ ] pipeline items
 *   node scan.mjs --validate-pipeline --dry-run  # preview without marking [!]
 */

import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync } from 'fs';
import yaml from 'js-yaml';
const parseYaml = yaml.load;

// ── Config ──────────────────────────────────────────────────────────

const PORTALS_PATH = 'portals.yml';
const SCAN_HISTORY_PATH = 'data/scan-history.tsv';
const PIPELINE_PATH = 'data/pipeline.md';
const APPLICATIONS_PATH = 'data/applications.md';

// Ensure required directories exist (fresh setup)
mkdirSync('data', { recursive: true });

const CONCURRENCY = 10;
const FETCH_TIMEOUT_MS = 10_000;

// ── API detection ───────────────────────────────────────────────────

function detectApi(company) {
  // Greenhouse: explicit api field
  if (company.api && company.api.includes('greenhouse')) {
    return { type: 'greenhouse', url: company.api };
  }

  const url = company.careers_url || '';

  // Ashby
  const ashbyMatch = url.match(/jobs\.ashbyhq\.com\/([^/?#]+)/);
  if (ashbyMatch) {
    return {
      type: 'ashby',
      url: `https://api.ashbyhq.com/posting-api/job-board/${ashbyMatch[1]}?includeCompensation=true`,
    };
  }

  // Lever
  const leverMatch = url.match(/jobs\.lever\.co\/([^/?#]+)/);
  if (leverMatch) {
    return {
      type: 'lever',
      url: `https://api.lever.co/v0/postings/${leverMatch[1]}`,
    };
  }

  // Greenhouse EU boards
  const ghEuMatch = url.match(/job-boards(?:\.eu)?\.greenhouse\.io\/([^/?#]+)/);
  if (ghEuMatch && !company.api) {
    return {
      type: 'greenhouse',
      url: `https://boards-api.greenhouse.io/v1/boards/${ghEuMatch[1]}/jobs`,
    };
  }

  return null;
}

// ── API parsers ─────────────────────────────────────────────────────

function parseGreenhouse(json, companyName) {
  const jobs = json.jobs || [];
  return jobs.map(j => ({
    title: j.title || '',
    url: j.absolute_url || '',
    company: companyName,
    location: j.location?.name || '',
  }));
}

function parseAshby(json, companyName) {
  const jobs = json.jobs || [];
  return jobs.map(j => ({
    title: j.title || '',
    url: j.jobUrl || '',
    company: companyName,
    location: j.location || '',
  }));
}

function parseLever(json, companyName) {
  if (!Array.isArray(json)) return [];
  return json.map(j => ({
    title: j.text || '',
    url: j.hostedUrl || '',
    company: companyName,
    location: j.categories?.location || '',
  }));
}

const PARSERS = { greenhouse: parseGreenhouse, ashby: parseAshby, lever: parseLever };

// ── Fetch with timeout ──────────────────────────────────────────────

async function fetchJson(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

// ── Portal-specific liveness filters ───────────────────────────────

const YOURATOR_MIN_JOB_ID = 30000;

/**
 * Yourator: job IDs below 30000 correlate strongly with dead postings.
 * Confirmed dead in manual review: 4589, 10465, 16559, 24624 (all < 30k).
 * Returns { live, reason } or null if URL is not a Yourator job.
 */
function checkYourator(url) {
  const match = url.match(/yourator\.co\/companies\/[^/]+\/jobs\/(\d+)/);
  if (!match) return null;
  const id = parseInt(match[1], 10);
  if (id < YOURATOR_MIN_JOB_ID) {
    return { live: false, reason: `Yourator job ID ${id} < ${YOURATOR_MIN_JOB_ID} (stale)` };
  }
  return { live: true, reason: `Yourator job ID ${id} >= ${YOURATOR_MIN_JOB_ID}` };
}

/**
 * 104.com.tw: query internal AJAX API with browser headers.
 * switch:on = active, switch:off = closed.
 * Returns { live, reason } or null if URL is not a 104 job or check fails.
 */
async function check104(url) {
  const match = url.match(/104\.com\.tw\/job(?:\/|\?jobno=)([^/?#&\s]+)/);
  if (!match) return null;
  const jobno = match[1];
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    const res = await fetch(`https://www.104.com.tw/job/ajax/content/${jobno}`, {
      signal: controller.signal,
      headers: {
        'Referer': 'https://www.104.com.tw/',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      },
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    const json = await res.json();
    const sw = json?.data?.switch;
    const title = json?.data?.header?.jobName || jobno;
    if (sw === 'off') return { live: false, reason: `104 switch:off — ${title}` };
    if (sw === 'on')  return { live: true,  reason: `104 switch:on — ${title}` };
    return null;
  } catch {
    return null; // timeout or network error — pass through
  }
}

/**
 * Run portal-specific liveness check for a URL.
 * Returns { live, reason } or null (no portal-specific check available).
 */
async function checkPortalLiveness(url) {
  const yourator = checkYourator(url);
  if (yourator !== null) return yourator;

  const result104 = await check104(url);
  if (result104 !== null) return result104;

  return null;
}

// ── Title filter ────────────────────────────────────────────────────

function buildTitleFilter(titleFilter) {
  const positive = (titleFilter?.positive || []).map(k => k.toLowerCase());
  const negative = (titleFilter?.negative || []).map(k => k.toLowerCase());

  return (title) => {
    const lower = title.toLowerCase();
    const hasPositive = positive.length === 0 || positive.some(k => lower.includes(k));
    const hasNegative = negative.some(k => lower.includes(k));
    return hasPositive && !hasNegative;
  };
}

// ── Dedup ───────────────────────────────────────────────────────────

function loadSeenUrls() {
  const seen = new Set();

  // scan-history.tsv
  if (existsSync(SCAN_HISTORY_PATH)) {
    const lines = readFileSync(SCAN_HISTORY_PATH, 'utf-8').split('\n');
    for (const line of lines.slice(1)) { // skip header
      const url = line.split('\t')[0];
      if (url) seen.add(url);
    }
  }

  // pipeline.md — extract URLs from checkbox lines
  if (existsSync(PIPELINE_PATH)) {
    const text = readFileSync(PIPELINE_PATH, 'utf-8');
    for (const match of text.matchAll(/- \[[ x]\] (https?:\/\/\S+)/g)) {
      seen.add(match[1]);
    }
  }

  // applications.md — extract URLs from report links and any inline URLs
  if (existsSync(APPLICATIONS_PATH)) {
    const text = readFileSync(APPLICATIONS_PATH, 'utf-8');
    for (const match of text.matchAll(/https?:\/\/[^\s|)]+/g)) {
      seen.add(match[0]);
    }
  }

  return seen;
}

function loadSeenCompanyRoles() {
  const seen = new Set();
  if (existsSync(APPLICATIONS_PATH)) {
    const text = readFileSync(APPLICATIONS_PATH, 'utf-8');
    // Parse markdown table rows: | # | Date | Company | Role | ...
    for (const match of text.matchAll(/\|[^|]+\|[^|]+\|\s*([^|]+)\s*\|\s*([^|]+)\s*\|/g)) {
      const company = match[1].trim().toLowerCase();
      const role = match[2].trim().toLowerCase();
      if (company && role && company !== 'company') {
        seen.add(`${company}::${role}`);
      }
    }
  }
  return seen;
}

// ── Pipeline writer ─────────────────────────────────────────────────

function appendToPipeline(offers) {
  if (offers.length === 0) return;

  let text = readFileSync(PIPELINE_PATH, 'utf-8');

  // Find "## Pendientes" section and append after it
  const marker = '## Pendientes';
  const idx = text.indexOf(marker);
  if (idx === -1) {
    // No Pendientes section — append at end before Procesadas
    const procIdx = text.indexOf('## Procesadas');
    const insertAt = procIdx === -1 ? text.length : procIdx;
    const block = `\n${marker}\n\n` + offers.map(o =>
      `- [ ] ${o.url} | ${o.company} | ${o.title}`
    ).join('\n') + '\n\n';
    text = text.slice(0, insertAt) + block + text.slice(insertAt);
  } else {
    // Find the end of existing Pendientes content (next ## or end)
    const afterMarker = idx + marker.length;
    const nextSection = text.indexOf('\n## ', afterMarker);
    const insertAt = nextSection === -1 ? text.length : nextSection;

    const block = '\n' + offers.map(o =>
      `- [ ] ${o.url} | ${o.company} | ${o.title}`
    ).join('\n') + '\n';
    text = text.slice(0, insertAt) + block + text.slice(insertAt);
  }

  writeFileSync(PIPELINE_PATH, text, 'utf-8');
}

function appendToScanHistory(offers, date) {
  // Ensure file + header exist
  if (!existsSync(SCAN_HISTORY_PATH)) {
    writeFileSync(SCAN_HISTORY_PATH, 'url\tfirst_seen\tportal\ttitle\tcompany\tstatus\n', 'utf-8');
  }

  const lines = offers.map(o =>
    `${o.url}\t${date}\t${o.source}\t${o.title}\t${o.company}\tadded`
  ).join('\n') + '\n';

  appendFileSync(SCAN_HISTORY_PATH, lines, 'utf-8');
}

// ── Parallel fetch with concurrency limit ───────────────────────────

async function parallelFetch(tasks, limit) {
  const results = [];
  let i = 0;

  async function next() {
    while (i < tasks.length) {
      const task = tasks[i++];
      results.push(await task());
    }
  }

  const workers = Array.from({ length: Math.min(limit, tasks.length) }, () => next());
  await Promise.all(workers);
  return results;
}

// ── Validate pipeline ───────────────────────────────────────────────

/**
 * Reads pipeline.md, runs portal-specific liveness checks on all pending
 * [ ] items, and marks dead ones as [!]. Handles 104 and Yourator today;
 * extend checkPortalLiveness() to add more portals.
 */
async function validatePipeline(dryRun) {
  if (!existsSync(PIPELINE_PATH)) {
    console.error(`Error: ${PIPELINE_PATH} not found.`);
    process.exit(1);
  }

  const text = readFileSync(PIPELINE_PATH, 'utf-8');
  const lines = text.split('\n');

  const pending = lines
    .map((line, i) => ({ line, i, match: line.match(/^(- \[ \] )(https?:\/\/\S+)(.*)/) }))
    .filter(({ match }) => match !== null);

  if (pending.length === 0) {
    console.log('No pending items to validate.');
    return;
  }

  console.log(`Validating ${pending.length} pending pipeline items...\n`);

  let dead = 0, alive = 0, unknown = 0;

  for (const { i, match } of pending) {
    const url = match[2];
    const rest = match[3];
    const result = await checkPortalLiveness(url);

    if (result === null) {
      unknown++;
      console.log(`  ? ${url.slice(0, 70)}`);
    } else if (!result.live) {
      dead++;
      console.log(`  ✗ ${url.slice(0, 70)}\n      → ${result.reason}`);
      if (!dryRun) {
        lines[i] = `- [!] ${url}${rest} — ${result.reason}`;
      }
    } else {
      alive++;
      console.log(`  ✓ ${url.slice(0, 70)}\n      → ${result.reason}`);
    }
  }

  if (!dryRun && dead > 0) {
    writeFileSync(PIPELINE_PATH, lines.join('\n'), 'utf-8');
  }

  console.log(`\n${'━'.repeat(45)}`);
  console.log(`Pipeline Validation`);
  console.log(`${'━'.repeat(45)}`);
  console.log(`Active:        ${alive}`);
  console.log(`Dead (marked): ${dead}${dryRun ? ' (dry run — not written)' : ''}`);
  console.log(`Unverifiable:  ${unknown} (no portal check for this URL type)`);
  if (dead > 0 && !dryRun) {
    console.log(`\nMarked ${dead} item(s) as [!] in ${PIPELINE_PATH}`);
  }
}

// ── Main ────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');

  // --validate-pipeline: check liveness of existing pipeline [ ] items
  if (args.includes('--validate-pipeline')) {
    await validatePipeline(dryRun);
    return;
  }

  const companyFlag = args.indexOf('--company');
  const filterCompany = companyFlag !== -1 ? args[companyFlag + 1]?.toLowerCase() : null;

  // 1. Read portals.yml
  if (!existsSync(PORTALS_PATH)) {
    console.error('Error: portals.yml not found. Run onboarding first.');
    process.exit(1);
  }

  const config = parseYaml(readFileSync(PORTALS_PATH, 'utf-8'));
  const companies = config.tracked_companies || [];
  const titleFilter = buildTitleFilter(config.title_filter);

  // 2. Filter to enabled companies with detectable APIs
  const targets = companies
    .filter(c => c.enabled !== false)
    .filter(c => !filterCompany || c.name.toLowerCase().includes(filterCompany))
    .map(c => ({ ...c, _api: detectApi(c) }))
    .filter(c => c._api !== null);

  const skippedCount = companies.filter(c => c.enabled !== false).length - targets.length;

  console.log(`Scanning ${targets.length} companies via API (${skippedCount} skipped — no API detected)`);
  if (dryRun) console.log('(dry run — no files will be written)\n');

  // 3. Load dedup sets
  const seenUrls = loadSeenUrls();
  const seenCompanyRoles = loadSeenCompanyRoles();

  // 4. Fetch all APIs
  const date = new Date().toISOString().slice(0, 10);
  let totalFound = 0;
  let totalFiltered = 0;
  let totalDupes = 0;
  const newOffers = [];
  const errors = [];

  const tasks = targets.map(company => async () => {
    const { type, url } = company._api;
    try {
      const json = await fetchJson(url);
      const jobs = PARSERS[type](json, company.name);
      totalFound += jobs.length;

      for (const job of jobs) {
        if (!titleFilter(job.title)) {
          totalFiltered++;
          continue;
        }
        if (seenUrls.has(job.url)) {
          totalDupes++;
          continue;
        }
        const key = `${job.company.toLowerCase()}::${job.title.toLowerCase()}`;
        if (seenCompanyRoles.has(key)) {
          totalDupes++;
          continue;
        }
        // Mark as seen to avoid intra-scan dupes
        seenUrls.add(job.url);
        seenCompanyRoles.add(key);
        newOffers.push({ ...job, source: `${type}-api` });
      }
    } catch (err) {
      errors.push({ company: company.name, error: err.message });
    }
  });

  await parallelFetch(tasks, CONCURRENCY);

  // 5. Portal-specific liveness pre-filter (104 AJAX + Yourator ID)
  const liveOffers = [];
  const preFiltered = [];
  for (const offer of newOffers) {
    const result = await checkPortalLiveness(offer.url);
    if (result !== null && !result.live) {
      preFiltered.push({ ...offer, reason: result.reason });
    } else {
      liveOffers.push(offer);
    }
  }

  // 6. Write results
  if (!dryRun && liveOffers.length > 0) {
    appendToPipeline(liveOffers);
    appendToScanHistory(liveOffers, date);
  }

  // 7. Print summary
  console.log(`\n${'━'.repeat(45)}`);
  console.log(`Portal Scan — ${date}`);
  console.log(`${'━'.repeat(45)}`);
  console.log(`Companies scanned:     ${targets.length}`);
  console.log(`Total jobs found:      ${totalFound}`);
  console.log(`Filtered by title:     ${totalFiltered} removed`);
  console.log(`Duplicates:            ${totalDupes} skipped`);
  console.log(`Pre-filtered (dead):   ${preFiltered.length} removed`);
  console.log(`New offers added:      ${liveOffers.length}`);

  if (errors.length > 0) {
    console.log(`\nErrors (${errors.length}):`);
    for (const e of errors) {
      console.log(`  ✗ ${e.company}: ${e.error}`);
    }
  }

  if (preFiltered.length > 0) {
    console.log('\nPre-filtered (dead before pipeline):');
    for (const o of preFiltered) {
      console.log(`  ✗ ${o.company} | ${o.title} — ${o.reason}`);
    }
  }

  if (liveOffers.length > 0) {
    console.log('\nNew offers:');
    for (const o of liveOffers) {
      console.log(`  + ${o.company} | ${o.title} | ${o.location || 'N/A'}`);
    }
    if (dryRun) {
      console.log('\n(dry run — run without --dry-run to save results)');
    } else {
      console.log(`\nResults saved to ${PIPELINE_PATH} and ${SCAN_HISTORY_PATH}`);
    }
  }

  console.log(`\n→ Run /career-ops pipeline to evaluate new offers.`);
  console.log('→ Share results and get help: https://discord.gg/8pRpHETxa4');
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
