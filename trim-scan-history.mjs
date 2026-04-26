#!/usr/bin/env node
/**
 * Trims scan-history.tsv entries older than RETENTION_DAYS (default 90).
 * Block G repost detection only looks back 90 days, so older entries are pure dead weight.
 * Run manually: node trim-scan-history.mjs
 * Run with custom window: node trim-scan-history.mjs --days 60
 */

import { readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TSV_PATH = join(__dirname, 'data/scan-history.tsv');

const args = process.argv.slice(2);
const daysFlag = args.indexOf('--days');
const RETENTION_DAYS = daysFlag !== -1 ? parseInt(args[daysFlag + 1], 10) : 90;

const cutoff = new Date();
cutoff.setDate(cutoff.getDate() - RETENTION_DAYS);

const raw = readFileSync(TSV_PATH, 'utf8');
const lines = raw.split('\n');
const header = lines[0];
const rows = lines.slice(1).filter(l => l.trim());

const kept = [];
const trimmed = [];

for (const row of rows) {
  const cols = row.split('\t');
  const dateStr = cols[1]; // second column: first_seen (YYYY-MM-DD)
  const rowDate = new Date(dateStr);
  if (!isNaN(rowDate) && rowDate < cutoff) {
    trimmed.push(row);
  } else {
    kept.push(row);
  }
}

if (trimmed.length === 0) {
  console.log(`✅ Nothing to trim — all ${rows.length} entries are within ${RETENTION_DAYS} days.`);
  process.exit(0);
}

const output = [header, ...kept, ''].join('\n');
writeFileSync(TSV_PATH, output, 'utf8');
console.log(`✂️  Trimmed ${trimmed.length} entries older than ${RETENTION_DAYS} days.`);
console.log(`📊 Remaining: ${kept.length} entries.`);
