#!/usr/bin/env node
/**
 * sort-pipeline.mjs — Move completed [x] entries from Pending to Processed.
 *
 * Usage:
 *   node sort-pipeline.mjs [--dry-run]
 *     Move all [x] entries to Processed (end-of-session cleanup)
 *
 *   node sort-pipeline.mjs --complete "<URL>" --num NNN --score "X.X/5" --pdf "✅/❌"
 *     Mark a specific URL as done and move it atomically (no Edit tool call needed)
 *
 *   node sort-pipeline.mjs --complete "<URL>" --error "reason"
 *     Mark a specific URL as [!] (inaccessible) with an error note
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const CAREER_OPS = dirname(fileURLToPath(import.meta.url));
const PIPELINE_FILE = join(CAREER_OPS, 'data/pipeline.md');
const DRY_RUN = process.argv.includes('--dry-run');

// Parse --complete mode args
const completeIdx = process.argv.indexOf('--complete');
const COMPLETE_URL = completeIdx !== -1 ? process.argv[completeIdx + 1] : null;

function getArg(flag) {
  const idx = process.argv.indexOf(flag);
  return idx !== -1 ? process.argv[idx + 1] : null;
}

if (!existsSync(PIPELINE_FILE)) {
  console.error('pipeline.md not found at', PIPELINE_FILE);
  process.exit(1);
}

const raw = readFileSync(PIPELINE_FILE, 'utf8');
const lines = raw.split('\n');

const pendingIdx = lines.findIndex(l => l.trim() === '## Pending');
const processedIdx = lines.findIndex(l => l.trim() === '## Processed');

if (pendingIdx === -1 || processedIdx === -1) {
  console.error('Could not find ## Pending or ## Processed sections.');
  process.exit(1);
}

// ── --complete mode: mark a specific URL done, then sort ──────────────────────
if (COMPLETE_URL) {
  const num = getArg('--num');
  const score = getArg('--score');
  const pdf = getArg('--pdf');
  const error = getArg('--error');

  const urlEscaped = COMPLETE_URL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const matchRe = new RegExp(`^- \\[ \\].*${urlEscaped}`);

  const targetIdx = lines.findIndex(l => matchRe.test(l));
  if (targetIdx === -1) {
    console.error(`URL not found in Pending: ${COMPLETE_URL}`);
    process.exit(1);
  }

  const original = lines[targetIdx];

  if (error) {
    // Mark as inaccessible [!]
    lines[targetIdx] = original.replace('- [ ]', `- [!]`) + ` — Error: ${error}`;
    console.log(`⚠️  Marked as inaccessible: ${COMPLETE_URL}`);
  } else {
    // Extract all metadata from pipe-delimited comment in pending entry.
    // Format: - [ ] <URL> | Company | Role [| extra...]
    // All fields after the URL are preserved so scan-added markers (🇬🇧精通) survive processing.
    const parts = original.replace(/^- \[ \]\s*/, '').split('|').map(s => s.trim());
    const url = parts[0];
    const meta = parts.slice(1).filter(Boolean); // company, role, any extras

    // --extra: additional field appended after preserved meta (only if not already present)
    const extra = getArg('--extra');
    if (extra && !meta.includes(extra)) meta.push(extra);

    const suffix = meta.length ? ` | ${meta.join(' | ')}` : '';
    const company = meta[0] || '';
    const role = meta[1] || '';

    lines[targetIdx] = `- [x] #${num} | ${url}${suffix} | ${score} | PDF ${pdf}`;
    console.log(`✅ Marked done: #${num} ${company} — ${role} (${score})`);
  }

  if (DRY_RUN) {
    console.log('[dry-run] Would write:', lines[targetIdx]);
    process.exit(0);
  }

  writeFileSync(PIPELINE_FILE, lines.join('\n'), 'utf8');
}

// ── Sort: move all [x] entries from Pending → Processed ──────────────────
const fresh = readFileSync(PIPELINE_FILE, 'utf8').split('\n');
const pIdx = fresh.findIndex(l => l.trim() === '## Pending');
const prIdx = fresh.findIndex(l => l.trim() === '## Processed');

const header = fresh.slice(0, pIdx + 1);
const pendientesBody = fresh.slice(pIdx + 1, prIdx);
const procesadasHeader = fresh.slice(prIdx, prIdx + 1);
const procesadasBody = fresh.slice(prIdx + 1);

const doneLines = pendientesBody.filter(l => /^- \[x\]/.test(l));
const pendingLines = pendientesBody.filter(l => !/^- \[x\]/.test(l));

if (doneLines.length === 0) {
  if (!COMPLETE_URL) console.log('Nothing to move — no [x] entries in Pending.');
  process.exit(0);
}

// Trim trailing blank lines that accumulate as entries are moved out
const trimmedPendingLines = [...pendingLines];
while (trimmedPendingLines.length > 0 && trimmedPendingLines[trimmedPendingLines.length - 1].trim() === '') {
  trimmedPendingLines.pop();
}

const newProcessadasBody = [...doneLines, ...procesadasBody];

const output = [
  ...header,
  ...trimmedPendingLines,
  '',
  ...procesadasHeader,
  ...newProcessadasBody,
].join('\n');

if (DRY_RUN) {
  console.log(`[dry-run] Would move ${doneLines.length} entries to Processed.`);
  doneLines.forEach(l => console.log(' ', l));
  process.exit(0);
}

writeFileSync(PIPELINE_FILE, output, 'utf8');
if (!COMPLETE_URL) {
  console.log(`✅ Moved ${doneLines.length} completed entries to Processed.`);
  doneLines.forEach(l => console.log(' ', l.slice(0, 80)));
}
