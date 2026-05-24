# Mode: pipeline — URL Inbox (Second Brain)

Processes job URLs accumulated in `data/pipeline.md`. The user adds URLs at any time, then runs `/career-ops pipeline` to process them.

## Pre-conditions (run before anything else)

**Step 0a — Load Playwright tools:** Call `ToolSearch` with query `select:mcp__plugin_playwright_playwright__browser_navigate,mcp__plugin_playwright_playwright__browser_snapshot,mcp__plugin_playwright_playwright__browser_close` before the first navigation.

**Step 0b — Pre-flight:** Run `node preflight-pipeline.mjs` (one bash call). Parse the JSON output:
- `updateAvailable` → if status is `update-available`, notify user before proceeding
- `onboarding` → if any file is missing, enter onboarding mode (see CLAUDE.md)
- `cvSync.warnings` → if non-empty, notify user
- `nextReportNum` → use this as the starting report number (no separate ls/grep needed)
- `pendingUrls` → list of `{ url, company, role }` objects to process (no separate Read of pipeline.md needed)
- `articleDigestExists` → whether to load article-digest.md during evaluation

## Workflow

1. **From `preflight-pipeline.mjs` output**, get the list of pending URLs and starting report number.
2. **For each pending URL**:
   a. Assign `REPORT_NUM` sequentially from `nextReportNum` (increment for each job)
   b. **Extract JD** using Playwright → WebFetch → WebSearch (fallback chain):
      - `browser_navigate` to URL, then `browser_snapshot` (use default depth for all portals)
      - Pre-flight reset: if first `browser_navigate` fails with "Target page, context or browser has been closed", call `browser_close` once to reset, then retry
   c. If URL is inaccessible → run `node sort-pipeline.mjs --complete "<URL>" --error "login required"` and continue
   d. **Run full auto-pipeline**: Evaluation A-F → Report .md → PDF (if score ≥ 3.0) → Cover Letter → Tracker TSV
   d2. **Cover letter (mandatory when PDF is generated):** Write `output/{NNN}-{company-slug}-cl-{YYYY-MM-DD}.md` — 3-4 paragraphs: hook (why this company), skills + metrics from CV, key differentiator, close with comp ask. Match the language of the JD. Do NOT proceed to step (e) until this file is written.
   e. **Mark complete (atomic):** Run `node sort-pipeline.mjs --complete "<URL>" --num NNN --score "X.X/5" --pdf PDF_STATUS`
      where `PDF_STATUS` is **`✅`** if the PDF was successfully generated in this step, or **`❌`** if not (score < 3.0 or generation failed).
      Do NOT call this before the PDF step — the PDF status must be known before calling this command.
      This marks the entry as `[x]` and moves it to Processed in one operation — no Edit tool call needed.
3. **If 3+ pending URLs**, launch parallel agents (Agent tool with `run_in_background`) to maximize speed.
4. **Close the browser**: Call `browser_close` when done with all URLs.
5. **Show summary table:**

```
| # | Company | Role | Score | PDF | Recommendation |
```

## pipeline.md Format

```markdown
## Pending
- [ ] https://jobs.example.com/posting/123
- [ ] https://boards.greenhouse.io/company/jobs/456 | Company Inc | Senior PM
- [!] https://private.url/job — Error: login required

## Processed
- [x] #143 | https://jobs.example.com/posting/789 | Acme Corp | AI PM | 4.2/5 | PDF ✅
- [x] #144 | https://boards.greenhouse.io/xyz/jobs/012 | BigCo | SA | 2.1/5 | PDF ❌
```

## Intelligent JD Extraction from URL

1. **Playwright (preferred):** `browser_navigate` + `browser_snapshot`. Works with all SPAs.
   **Pre-flight reset:** If the first `browser_navigate` fails with "Target page, context or browser has been closed" or another browser-closed error, call `browser_close` once to reset the MCP state, then retry. This error indicates an orphaned browser from a previous session.
2. **WebFetch (fallback):** For static pages or when Playwright is unavailable.
3. **WebSearch (last resort):** Search secondary portals that index the JD.

**Special cases:**
- **LinkedIn**: May require login → mark `[!]` and ask the user to paste the text
- **PDF**: If the URL points to a PDF, read it directly with the Read tool
- **`local:` prefix**: Read the local file. Example: `local:jds/linkedin-pm-ai.md` → read `jds/linkedin-pm-ai.md`

## Automatic Numbering

1. List all files in `reports/`
2. Extract the number from the prefix (e.g., `142-medispend...` → 142)
3. New number = maximum found + 1

## Source Sync

Before processing any URL, verify sync:
```bash
node cv-sync-check.mjs
```
If out of sync, warn the user before continuing.
