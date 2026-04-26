#!/usr/bin/env node
/**
 * Archives terminal-state rows (SKIP, Discarded, Rejected) older than RETENTION_DAYS
 * from data/applications.md into data/applications-archive.md.
 * Keeps applications.md lean so it loads faster in every evaluation session.
 * Run manually: node archive-old-tracker.mjs
 * Run with custom window: node archive-old-tracker.mjs --days 30
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TRACKER_PATH = join(__dirname, 'data/applications.md');
const ARCHIVE_PATH = join(__dirname, 'data/applications-archive.md');

const args = process.argv.slice(2);
const daysFlag = args.indexOf('--days');
const RETENTION_DAYS = daysFlag !== -1 ? parseInt(args[daysFlag + 1], 10) : 60;

const TERMINAL_STATES = ['SKIP', 'Discarded', 'Rejected'];

const cutoff = new Date();
cutoff.setDate(cutoff.getDate() - RETENTION_DAYS);

const raw = readFileSync(TRACKER_PATH, 'utf8');
const lines = raw.split('\n');

// Separate header (everything up to and including the column-separator row)
const headerLines = [];
const dataLines = [];
let headerDone = false;

for (const line of lines) {
  if (!headerDone) {
    headerLines.push(line);
    if (line.startsWith('|---')) headerDone = true;
  } else {
    dataLines.push(line);
  }
}

const toArchive = [];
const toKeep = [];

for (const line of dataLines) {
  if (!line.trim() || !line.startsWith('|')) {
    toKeep.push(line);
    continue;
  }
  const cols = line.split('|').map(c => c.trim()).filter(Boolean);
  // cols[1] = date, cols[5] = status (0-indexed after split)
  const dateStr = cols[1];
  const status = cols[5];
  const rowDate = new Date(dateStr);

  if (TERMINAL_STATES.includes(status) && !isNaN(rowDate) && rowDate < cutoff) {
    toArchive.push(line);
  } else {
    toKeep.push(line);
  }
}

if (toArchive.length === 0) {
  console.log(`✅ Nothing to archive — no terminal-state entries older than ${RETENTION_DAYS} days.`);
  process.exit(0);
}

// Write updated tracker
const updatedTracker = [...headerLines, ...toKeep].join('\n');
writeFileSync(TRACKER_PATH, updatedTracker, 'utf8');

// Append to archive (create with header if new)
const archiveHeader = `# Applications Archive\n\n| # | Date | Company | Role | Score | Status | PDF | Report | Notes |\n|---|------|---------|------|-------|--------|-----|--------|-------|\n`;
if (!existsSync(ARCHIVE_PATH)) {
  writeFileSync(ARCHIVE_PATH, archiveHeader, 'utf8');
}
const archiveAppend = toArchive.join('\n') + '\n';
const existingArchive = readFileSync(ARCHIVE_PATH, 'utf8');
writeFileSync(ARCHIVE_PATH, existingArchive + archiveAppend, 'utf8');

console.log(`📦 Archived ${toArchive.length} terminal-state entries (>${RETENTION_DAYS} days old) to applications-archive.md.`);
console.log(`📊 Active tracker: ${toKeep.filter(l => l.startsWith('|') && !l.startsWith('|---')).length} entries remaining.`);
