#!/usr/bin/env node
/**
 * check-english-104.mjs — Batch check 104.com.tw jobs for liveness + English 精通 requirement
 *
 * Usage: node check-english-104.mjs [jobno1 jobno2 ...]
 *        node check-english-104.mjs --file urls.txt
 *
 * Output: tab-separated: jobno  status  english_level  title
 *   status: active | closed | uncertain
 *   english_level: 精通 | 良好 | 一般 | 略懂 | none | unknown
 */

import { chromium } from 'playwright';
import { readFile } from 'fs/promises';

const CLOSED_PATTERNS = [
  '職缺已關閉', '此職缺已停止招募', '停止招募', '職缺不存在',
  'This job is no longer available', 'Job is closed', 'no longer accepting',
];

async function checkJob(page, jobno) {
  const url = `https://www.104.com.tw/job/${jobno}`;
  try {
    const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
    const status = response?.status() ?? 0;
    // Wait for 語文條件 heading (signals job content rendered) OR fallback for closed/CF pages
    await page.waitForSelector('h3:has-text("語文條件")', { timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(300);

    const finalUrl = page.url();

    const pageTitle = await page.title().catch(() => '');

    // Closed pages detected via title (must check BEFORE bodyLen — closed pages can have small bodies)
    if (CLOSED_PATTERNS.some(p => pageTitle.includes(p))) {
      return { jobno, status: 'closed', english: 'unknown', title: pageTitle, reason: 'closed pattern in title' };
    }

    // Check for redirect to non-job page (closed)
    if (!finalUrl.includes('/job/')) {
      return { jobno, status: 'closed', english: 'unknown', title: '', reason: 'redirected away from job page' };
    }

    // Cloudflare challenge pages: "Just a moment..." title OR very short body (<350 bytes)
    // Threshold is 350 (not 500) because closed pages can have 400-500 byte bodies
    const bodyLen = await page.evaluate(() => document.body?.innerText?.length ?? 0);
    if (pageTitle.includes('Just a moment') || bodyLen < 350) {
      return { jobno, status: 'uncertain', english: 'unknown', title: '', reason: `Cloudflare block (bodyLen=${bodyLen})` };
    }

    const isClosed = await page.evaluate(() => {
      const t = document.body?.innerText ?? '';
      return ['職缺已關閉', '此職缺已停止招募', '停止招募', 'no longer available', 'Job is closed'].some(p => t.includes(p));
    });
    if (isClosed) {
      return { jobno, status: 'closed', english: 'unknown', title: pageTitle, reason: 'closed pattern in body' };
    }

    // Extract title from h1 (most reliable)
    const title = await page.evaluate(() => {
      const h1 = document.querySelector('h1');
      return h1?.innerText?.trim() || '';
    });

    // Extract English proficiency by targeting 語文條件 heading directly in DOM
    const english = await page.evaluate(() => {
      // Find 語文條件 heading (h3)
      const headings = Array.from(document.querySelectorAll('h3'));
      const langH = headings.find(h => h.textContent.includes('語文條件'));
      if (!langH) {
        // Fallback: search entire body text
        const body = document.body?.innerText ?? '';
        if (/英文[\s\S]{0,60}精通/.test(body)) return '精通';
        if (/英文[\s\S]{0,60}良好/.test(body)) return '良好';
        if (/英文[\s\S]{0,60}一般/.test(body)) return '一般';
        if (/英文[\s\S]{0,60}略懂/.test(body)) return '略懂';
        return 'none';
      }
      // Get the container that follows the heading (sibling or parent's next sibling)
      let container = langH.nextElementSibling;
      if (!container) container = langH.parentElement?.nextElementSibling;
      if (!container) return 'none';
      const text = container.innerText || container.textContent || '';
      if (!(text.includes('英文') || text.includes('英語'))) return 'none';
      if (text.includes('精通')) return '精通';
      if (text.includes('良好')) return '良好';
      if (text.includes('一般')) return '一般';
      if (text.includes('略懂')) return '略懂';
      return 'mentioned';
    });

    return { jobno, status: 'active', english, title, reason: '' };
  } catch (err) {
    return { jobno, status: 'uncertain', english: 'unknown', title: '', reason: err.message.split('\n')[0] };
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.error('Usage: node check-english-104.mjs <jobno1> [jobno2] ...');
    console.error('       node check-english-104.mjs --file urls.txt');
    process.exit(1);
  }

  let jobnos;
  if (args[0] === '--file') {
    const text = await readFile(args[1], 'utf-8');
    jobnos = text.split('\n')
      .map(l => l.trim())
      .filter(l => l && !l.startsWith('#'))
      .map(l => {
        const m = l.match(/104\.com\.tw\/job\/([^/?#\s]+)/);
        return m ? m[1] : l;
      })
      .filter(Boolean);
  } else {
    jobnos = args.map(a => {
      const m = a.match(/104\.com\.tw\/job\/([^/?#\s]+)/);
      return m ? m[1] : a;
    });
  }

  console.error(`Checking ${jobnos.length} 104.com.tw job(s)...\n`);

  // Headed mode: Cloudflare bot detection is far more lenient with visible Chrome than headless.
  const browser = await chromium.launch({
    headless: false,
    args: ['--disable-blink-features=AutomationControlled', '--window-size=1280,900'],
  });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 900 },
  });
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });
  const page = await context.newPage();

  // Warm up the CF session: visit homepage first so subsequent job page loads
  // inherit the already-resolved Cloudflare challenge cookie.
  console.error('Warming up Cloudflare session via homepage...');
  await page.goto('https://www.104.com.tw/', { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(4000);

  const results = [];
  for (const jobno of jobnos) {
    const result = await checkJob(page, jobno);
    results.push(result);
    // Human-like delay between page visits
    await page.waitForTimeout(2500);
    const icon = result.status === 'active' ? '✅' : result.status === 'closed' ? '❌' : '⚠️';
    const engLabel = result.english === '精通' ? ' 英文精通' : result.english !== 'none' && result.english !== 'unknown' ? ` [${result.english}]` : '';
    console.log(`${icon} ${result.status.padEnd(10)} ${result.jobno.padEnd(8)} EN:${result.english.padEnd(6)}${engLabel ? '' : ''} ${result.title || result.reason}`);
  }

  await browser.close();

  const active = results.filter(r => r.status === 'active');
  const closed = results.filter(r => r.status === 'closed');
  const uncertain = results.filter(r => r.status === 'uncertain');
  const withEnglish = results.filter(r => r.english === '精通');

  console.log(`\nResults: ${active.length} active  ${closed.length} closed  ${uncertain.length} uncertain`);
  console.log(`English 精通: ${withEnglish.length} jobs`);
  if (withEnglish.length > 0) {
    console.log('\n英文精通 — Active jobs with mastery-level English requirement:');
    withEnglish.filter(r => r.status === 'active').forEach(r => {
      console.log(`  ${r.jobno} — ${r.title}`);
    });
  }
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
