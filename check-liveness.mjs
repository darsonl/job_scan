#!/usr/bin/env node

/**
 * check-liveness.mjs — Playwright job link liveness checker
 *
 * Tests whether job posting URLs are still active or have expired.
 * Uses the same detection logic as scan.md step 7.5.
 * Zero Claude API tokens — pure Playwright.
 *
 * Usage:
 *   node check-liveness.mjs <url1> [url2] ...
 *   node check-liveness.mjs --file urls.txt
 *
 * Exit code: 0 if all active, 1 if any expired or uncertain
 */

import { chromium } from 'playwright';
import { readFile } from 'fs/promises';
import { classifyLiveness, extractEnglish104 } from './liveness-core.mjs';

async function checkUrl(page, url) {
  try {
    const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });

    const status = response?.status() ?? 0;

    // Give SPAs (Ashby, Lever, Workday, 104.com.tw) time to hydrate
    await page.waitForTimeout(2000);

    const finalUrl = page.url();
    const bodyText = await page.evaluate(() => document.body?.innerText ?? '');
    const applyControls = await page.evaluate(() => {
      const candidates = Array.from(
        document.querySelectorAll('a, button, input[type="submit"], input[type="button"], [role="button"]')
      );

      return candidates
        .filter((element) => {
          if (element.closest('nav, header, footer')) return false;
          if (element.closest('[aria-hidden="true"]')) return false;

          const style = window.getComputedStyle(element);
          if (style.display === 'none' || style.visibility === 'hidden') return false;
          if (!element.getClientRects().length) return false;

          return Array.from(element.getClientRects()).some((rect) => rect.width > 0 && rect.height > 0);
        })
        .map((element) => {
          const label = [
            element.innerText,
            element.value,
            element.getAttribute('aria-label'),
            element.getAttribute('title'),
          ]
            .filter(Boolean)
            .join(' ')
            .replace(/\s+/g, ' ')
            .trim();

          return label;
        })
        .filter(Boolean);
    });

    const liveness = classifyLiveness({ status, finalUrl, bodyText, applyControls });

    // 104.com.tw: "insufficient content" means Cloudflare blocked us, not necessarily a
    // closed listing. Hard expired patterns (職缺已關閉) fire before this fallback, so
    // a true closed page still classifies correctly. Only the ambiguous short-body case
    // needs to be treated as uncertain to avoid false negatives.
    if (/104\.com\.tw\/job/.test(url) && liveness.result === 'expired' && liveness.reason.includes('insufficient content')) {
      return { result: 'uncertain', reason: 'Cloudflare may have blocked — manual check needed' };
    }

    // For active 104.com.tw job pages, also extract English proficiency level
    if (/104\.com\.tw\/job/.test(url) && liveness.result === 'active') {
      liveness.english = extractEnglish104(bodyText);
    }

    return liveness;

  } catch (err) {
    return { result: 'expired', reason: `navigation error: ${err.message.split('\n')[0]}` };
  }
}

async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    console.error('Usage: node check-liveness.mjs <url1> [url2] ...');
    console.error('       node check-liveness.mjs --file urls.txt');
    process.exit(1);
  }

  let urls;
  if (args[0] === '--file') {
    const text = await readFile(args[1], 'utf-8');
    urls = text.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'));
  } else {
    urls = args;
  }

  console.log(`Checking ${urls.length} URL(s)...\n`);

  // Headed mode bypasses Cloudflare bot checks on 104.com.tw. Headless Chromium triggers
  // CF's interstitial after the first page; headed mode does not.
  const has104 = urls.some(u => /104\.com\.tw\/job/.test(u));
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

  // Warm up Cloudflare session before visiting individual 104.com.tw job pages
  if (has104) {
    await page.goto('https://www.104.com.tw/', { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(4000);
  }

  let active = 0, expired = 0, uncertain = 0;

  // Sequential — project rule: never Playwright in parallel
  for (const url of urls) {
    const { result, reason, english } = await checkUrl(page, url);
    const icon = { active: '✅', expired: '❌', uncertain: '⚠️' }[result];
    const engTag = english === '精通' ? '  英文精通' : english && english !== 'none' ? `  英文:${english}` : '';
    console.log(`${icon} ${result.padEnd(10)} ${url}${engTag}`);
    if (result !== 'active') console.log(`           ${reason}`);
    if (result === 'active') active++;
    else if (result === 'expired') expired++;
    else uncertain++;
  }

  await browser.close();

  console.log(`\nResults: ${active} active  ${expired} expired  ${uncertain} uncertain`);
  if (expired > 0 || uncertain > 0) process.exit(1);
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
