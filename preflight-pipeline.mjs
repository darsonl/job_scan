#!/usr/bin/env node
/**
 * preflight-pipeline.mjs — Single pre-flight check for pipeline mode.
 *
 * Replaces 4 separate bash calls at session start:
 *   1. node update-system.mjs check
 *   2. file existence checks (cv.md, config/profile.yml, modes/_profile.md, portals.yml)
 *   3. node cv-sync-check.mjs
 *   4. ls reports/ | grep report number
 *
 * Also reads data/pipeline.md and returns pending URLs, so pipeline mode
 * does not need a separate Read call.
 *
 * Usage: node preflight-pipeline.mjs
 * Output: JSON to stdout
 */

import { existsSync, readdirSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execFileSync } from 'child_process';

const ROOT = dirname(fileURLToPath(import.meta.url));
const NODE = process.execPath; // path to current node binary

// ── 1. Update check ───────────────────────────────────────────────────────────
let updateAvailable = { status: 'unknown' };
try {
  const raw = execFileSync(NODE, [join(ROOT, 'update-system.mjs'), 'check'], {
    timeout: 8000,
    encoding: 'utf8',
  }).trim();
  updateAvailable = JSON.parse(raw);
} catch {
  updateAvailable = { status: 'offline' };
}

// ── 2. Onboarding file checks ─────────────────────────────────────────────────
const onboarding = {
  cv: existsSync(join(ROOT, 'cv.md')),
  profile: existsSync(join(ROOT, 'config/profile.yml')),
  _profile: existsSync(join(ROOT, 'modes/_profile.md')),
  portals: existsSync(join(ROOT, 'portals.yml')),
};

// ── 3. CV sync check ──────────────────────────────────────────────────────────
let cvSync = { ok: true, warnings: [] };
try {
  const raw = execFileSync(NODE, [join(ROOT, 'cv-sync-check.mjs')], {
    timeout: 8000,
    encoding: 'utf8',
  });
  const warnings = raw.split('\n').filter(l => /^[⚠️]|WARNING|WARN/.test(l.trim()));
  cvSync = { ok: warnings.length === 0, warnings };
} catch (e) {
  cvSync = { ok: false, warnings: [e.message] };
}

// ── 4. Next report number ─────────────────────────────────────────────────────
let nextReportNum = 1;
try {
  const reportsDir = join(ROOT, 'reports');
  if (existsSync(reportsDir)) {
    const nums = readdirSync(reportsDir)
      .map(f => parseInt(f.match(/^(\d+)/)?.[1] ?? '0', 10))
      .filter(n => n > 0);
    if (nums.length > 0) nextReportNum = Math.max(...nums) + 1;
  }
} catch {
  // leave as 1
}

// ── 5. Pending pipeline URLs ──────────────────────────────────────────────────
let pendingUrls = [];
const pipelineFile = join(ROOT, 'data/pipeline.md');
if (existsSync(pipelineFile)) {
  const content = readFileSync(pipelineFile, 'utf8');
  const lines = content.split('\n');
  const pendientesIdx = lines.findIndex(l => l.trim() === '## Pendientes');
  const procesadasIdx = lines.findIndex(l => l.trim() === '## Procesadas');
  const body = pendientesIdx !== -1
    ? lines.slice(pendientesIdx + 1, procesadasIdx !== -1 ? procesadasIdx : undefined)
    : [];

  pendingUrls = body
    .filter(l => /^- \[ \]/.test(l))
    .map(l => {
      const parts = l.replace(/^- \[ \]\s*/, '').split('|').map(s => s.trim());
      return { url: parts[0], company: parts[1] || '', role: parts[2] || '' };
    });
}

// ── 6. article-digest.md existence ───────────────────────────────────────────
const articleDigestExists = existsSync(join(ROOT, 'article-digest.md'));

// ── Output ────────────────────────────────────────────────────────────────────
console.log(JSON.stringify({
  updateAvailable,
  onboarding,
  cvSync,
  nextReportNum,
  pendingUrls,
  articleDigestExists,
}, null, 2));
