const HARD_EXPIRED_PATTERNS = [
  /job (is )?no longer available/i,
  /job.*no longer open/i,
  /position has been filled/i,
  /this job has expired/i,
  /job posting has expired/i,
  /no longer accepting applications/i,
  /this (position|role|job) (is )?no longer/i,
  /this job (listing )?is closed/i,
  /job (listing )?not found/i,
  /the page you are looking for doesn.t exist/i,
  /diese stelle (ist )?(nicht mehr|bereits) besetzt/i,
  /offre (expirée|n'est plus disponible)/i,
  /職缺已關閉/,    // zh-TW: "job closed" — 104.com.tw
  /\bClosed\.\s/,  // yourator.co closed listing
];

const LISTING_PAGE_PATTERNS = [
  /\d+\s+jobs?\s+found/i,
  /search for jobs page is loaded/i,
];

const EXPIRED_URL_PATTERNS = [
  /[?&]error=true/i,
];

const APPLY_PATTERNS = [
  /\bapply\b/i,
  /\bsolicitar\b/i,
  /\bbewerben\b/i,
  /\bpostuler\b/i,
  /submit application/i,
  /easy apply/i,
  /start application/i,
  /ich bewerbe mich/i,
];

// Some platforms (104.com.tw, 1111.com.tw) render the apply button as a
// non-semantic div — invisible to the DOM interactive-element query. Check
// body text as a fallback for known CJK apply keywords.
const BODY_APPLY_PATTERNS = [
  /應徵/,   // zh-TW: "apply" — 104.com.tw, 1111.com.tw
  /立即應徵/, // "apply now"
];

const MIN_CONTENT_CHARS = 300;

function firstMatch(patterns, text = '') {
  return patterns.find((pattern) => pattern.test(text));
}

function hasApplyControl(controls = []) {
  return controls.some((control) => APPLY_PATTERNS.some((pattern) => pattern.test(control)));
}

export function classifyLiveness({ status = 0, finalUrl = '', bodyText = '', applyControls = [] } = {}) {
  if (status === 404 || status === 410) {
    return { result: 'expired', reason: `HTTP ${status}` };
  }

  const expiredUrl = firstMatch(EXPIRED_URL_PATTERNS, finalUrl);
  if (expiredUrl) {
    return { result: 'expired', reason: `redirect to ${finalUrl}` };
  }

  const expiredBody = firstMatch(HARD_EXPIRED_PATTERNS, bodyText);
  if (expiredBody) {
    return { result: 'expired', reason: `pattern matched: ${expiredBody.source}` };
  }

  if (hasApplyControl(applyControls)) {
    return { result: 'active', reason: 'visible apply control detected' };
  }

  if (BODY_APPLY_PATTERNS.some((p) => p.test(bodyText))) {
    return { result: 'active', reason: 'apply text detected in body (non-semantic button platform)' };
  }

  const listingPage = firstMatch(LISTING_PAGE_PATTERNS, bodyText);
  if (listingPage) {
    return { result: 'expired', reason: `pattern matched: ${listingPage.source}` };
  }

  if (bodyText.trim().length < MIN_CONTENT_CHARS) {
    return { result: 'expired', reason: 'insufficient content — likely nav/footer only' };
  }

  return { result: 'uncertain', reason: 'content present but no visible apply control found' };
}

/**
 * Extract English proficiency level from a 104.com.tw job page body text.
 * Looks for the 語文條件 (language conditions) section and finds 英文 level.
 * Returns: '精通' | '良好' | '一般' | '略懂' | 'mentioned' | 'none'
 */
export function extractEnglish104(bodyText = '') {
  const langIdx = bodyText.indexOf('語文條件');
  if (langIdx !== -1) {
    // Look within the 200 chars after the heading for the English entry
    const section = bodyText.slice(langIdx, langIdx + 300);
    if (section.includes('英文') || section.includes('英語')) {
      // Find the level in a tight window *after* 英文/英語 to avoid matching
      // a different language's level (e.g. 中文精通 appearing near 英文略懂).
      const engPos = section.indexOf('英文') !== -1 ? section.indexOf('英文') : section.indexOf('英語');
      const engWindow = section.slice(engPos, engPos + 15);
      if (engWindow.includes('精通')) return '精通';
      if (engWindow.includes('良好')) return '良好';
      if (engWindow.includes('一般')) return '一般';
      if (engWindow.includes('略懂')) return '略懂';
      return 'mentioned';
    }
    return 'none';
  }
  // Fallback: broad cross-line search (語文條件 section may not be in body text if SPA not hydrated).
  // Window kept tight (≤15 chars) so a nearby 中文精通 cannot contaminate an 英文略懂 match.
  if (/英文[\s\S]{0,15}精通/.test(bodyText)) return '精通';
  if (/英文[\s\S]{0,15}良好/.test(bodyText)) return '良好';
  if (/英文[\s\S]{0,15}一般/.test(bodyText)) return '一般';
  if (/英文[\s\S]{0,15}略懂/.test(bodyText)) return '略懂';
  return 'none';
}
