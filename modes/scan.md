# Mode: scan — Portal Scanner (Offer Discovery)

Scans configured job portals, filters by title relevance, and adds new offers to the pipeline for later evaluation.

## Recommended execution

Run as a subagent to avoid consuming main context:

```
Agent(
    subagent_type="general-purpose",
    prompt="[content of this file + specific data]",
    run_in_background=True
)
```

## Configuration

Read `portals.yml` which contains:
- `search_queries`: List of WebSearch queries with `site:` filters per portal (broad discovery)
- `tracked_companies`: Specific companies with `careers_url` for direct navigation
- `title_filter`: Positive/negative/seniority_boost keywords for title filtering

## Discovery Strategy (3 levels)

### Level 1 — Direct Playwright (PRIMARY)

**For each company in `tracked_companies`:** Navigate to its `careers_url` with Playwright (`browser_navigate` + `browser_snapshot`), read ALL visible job listings, and extract title + URL for each. This is the most reliable method because:
- Sees the page in real time (not cached Google results)
- Works with SPAs (Ashby, Lever, Workday)
- Detects new offers instantly
- Does not depend on Google indexing

**Each company MUST have `careers_url` in portals.yml.** If it doesn't, find it once, save it, and use it in future scans.

### Level 2 — ATS APIs / Feeds (COMPLEMENTARY)

For companies with a public API or structured feed, use the JSON/XML response as a quick complement to Level 1. It's faster than Playwright and reduces visual scraping errors.

**Current support (variables in `{}`):**
- **Greenhouse**: `https://boards-api.greenhouse.io/v1/boards/{company}/jobs`
- **Ashby**: `https://jobs.ashbyhq.com/api/non-user-graphql?op=ApiJobBoardWithTeams`
- **BambooHR**: list `https://{company}.bamboohr.com/careers/list`; job detail `https://{company}.bamboohr.com/careers/{id}/detail`
- **Lever**: `https://api.lever.co/v0/postings/{company}?mode=json`
- **Teamtailor**: `https://{company}.teamtailor.com/jobs.rss`
- **Workday**: `https://{company}.{shard}.myworkdayjobs.com/wday/cxs/{company}/{site}/jobs`

**Parsing convention by provider:**
- `greenhouse`: `jobs[]` → `title`, `absolute_url`
- `ashby`: GraphQL `ApiJobBoardWithTeams` with `organizationHostedJobsPageName={company}` → `jobBoard.jobPostings[]` (`title`, `id`; build public URL if not in payload)
- `bamboohr`: list `result[]` → `jobOpeningName`, `id`; build detail URL `https://{company}.bamboohr.com/careers/{id}/detail`; to read full JD, GET detail and use `result.jobOpening` (`jobOpeningName`, `description`, `datePosted`, `minimumExperience`, `compensation`, `jobOpeningShareUrl`)
- `lever`: root array `[]` → `text`, `hostedUrl` (fallback: `applyUrl`)
- `teamtailor`: RSS items → `title`, `link`
- `workday`: `jobPostings[]`/`jobPostings` (per tenant) → `title`, `externalPath` or URL built from host

### Level 3 — WebSearch queries (BROAD DISCOVERY)

`search_queries` with `site:` filters cover portals cross-sectionally (all Ashby boards, all Greenhouse boards, etc.). Useful for discovering NEW companies not yet in `tracked_companies`, but results may be stale.

**Execution priority:**
1. Level 1: Playwright → all `tracked_companies` with `careers_url`
2. Level 2: API → all `tracked_companies` with `api:`
3. Level 3: WebSearch → all `search_queries` with `enabled: true`

All levels are additive — all run, results are merged and deduplicated.

## Workflow

1. **Read config**: `portals.yml`
2. **Read history**: `data/scan-history.tsv` → already-seen URLs
3. **Read dedup sources**: `data/applications.md` + `data/pipeline.md`

4. **Level 1 — Playwright scan** (parallel in batches of 3-5):
   **Before the first `browser_navigate`:** If it fails with "Target page, context or browser has been closed" or another closed-browser error, call `browser_close` once to reset MCP state, then retry. This error indicates an orphaned browser from a previous session.
   For each company in `tracked_companies` with `enabled: true` and `careers_url` defined:
   a. `browser_navigate` to the `careers_url`
   b. `browser_snapshot` to read all job listings
   c. If the page has filters/departments, navigate relevant sections
   d. For each job listing extract: `{title, url, company}`
   e. If the page paginates results, navigate additional pages
   f. Accumulate in candidate list
   g. If `careers_url` fails (404, redirect, navigation error) → run **Auto-heal** (see section below)

4b. **Level 1b — Playwright board search** (sequential — not in parallel with Level 1):
   For each entry in `search_boards` with `enabled: true` and `method: playwright`:
   a. `browser_navigate` to the board `url`
   a2. **SPAs (104.com.tw, 1111.com.tw, Yourator, CakeResume):** call `browser_wait_for` with text `找到` (104/1111), `jobs` (CakeResume), or `工作` (Yourator) to confirm results rendered before snapshot. If timeout, proceed anyway — partial is better than nothing.
   b. `browser_snapshot` to read all visible job listings
   b2. **If snapshot has < 5 results and no "no results" signal:** do a second brief `browser_wait_for` + `browser_snapshot`. If still empty → auto-heal.
   c. For each listing extract: `{title, url, company}` — look for links with patterns like `/job/`, `/jobs/`, `?jobNo=` in the snapshot
   d. For 104.com.tw: offer URLs are `https://www.104.com.tw/job/{jobNo}` — extract `jobNo` from the href and build the full URL if partial. **Always normalize to `/job/{jobNo}` — strip any `?jobno=` or other query params before comparing with scan-history.tsv.**
   e. If pagination exists and first page returns ≥20 results, navigate second page (`&page=2`) and accumulate
   f. Accumulate in candidate list (dedup with Level 1)
   g. If URL fails (navigation error) or snapshot contains no job listings → run **Auto-heal** (see section below)
   h. **Between boards on the same domain** (e.g., 9 consecutive 104.com.tw entries): use `browser_evaluate("() => new Promise(r => setTimeout(r, 800))")` between navigations to avoid rate limiting.

   **Parsing 104.com.tw:**
   - Each job card in the snapshot has the job title and company name
   - Hrefs have the pattern `/job/{jobNo}` — build `https://www.104.com.tw/job/{jobNo}` as canonical URL
   - The `company` field is extracted from the employer name in the card (`custName` or company element text)
   - **One keyword per board:** each entry in portals.yml uses exactly one keyword — multi-keyword queries with spaces do not trigger the SPA search when navigating directly.
   - **Pre-applied location filter:** URLs include `area=6001001000%2C6001002000` (台北市 + 新北市). Results are already filtered by Taipei and New Taipei — no additional city filtering needed.

5. **Level 2 — ATS APIs / feeds** (parallel):
   For each company in `tracked_companies` with `api:` defined and `enabled: true`:
   a. WebFetch the API/feed URL
   b. If `api_provider` is defined, use its parser; if not defined, infer from domain (`boards-api.greenhouse.io`, `jobs.ashbyhq.com`, `api.lever.co`, `*.bamboohr.com`, `*.teamtailor.com`, `*.myworkdayjobs.com`)
   c. For **Ashby**, send POST with:
      - `operationName: ApiJobBoardWithTeams`
      - `variables.organizationHostedJobsPageName: {company}`
      - GraphQL query for `jobBoardWithTeams` + `jobPostings { id title locationName employmentType compensationTierSummary }`
   d. For **BambooHR**, the list only returns basic metadata. For each relevant item, read `id`, GET `https://{company}.bamboohr.com/careers/{id}/detail`, and extract the full JD from `result.jobOpening`. Use `jobOpeningShareUrl` as public URL if available; otherwise use the detail URL.
   e. For **Workday**, send POST JSON with at least `{"appliedFacets":{},"limit":20,"offset":0,"searchText":""}` and paginate by `offset` until results are exhausted
   f. For each job extract and normalize: `{title, url, company}`
   g. Accumulate in candidate list (dedup with Level 1)

6. **Level 3 — WebSearch queries** (parallel if possible):
   For each query in `search_queries` with `enabled: true`:
   a. Execute WebSearch with the defined `query`
   b. From each result extract: `{title, url, company}`
      - **title**: from result title (before " @ " or " | ")
      - **url**: result URL
      - **company**: after " @ " in the title, or extract from domain/path
   c. Accumulate in candidate list (dedup with Levels 1+2)

6. **Filter by title** using `title_filter` from `portals.yml`:
   - At least 1 keyword from `positive` must appear in the title (case-insensitive)
   - 0 keywords from `negative` must appear
   - `seniority_boost` keywords give priority but are not required

7. **Deduplicate** against 3 sources:
   - `scan-history.tsv` → exact URL already seen
   - `applications.md` → company + normalized role already evaluated
   - `pipeline.md` → exact URL already in pending or processed

7.5. **Verify liveness of WebSearch results (Level 3)** — BEFORE adding to pipeline:

   WebSearch results can be stale (Google caches results for weeks or months). To avoid evaluating expired offers, verify with Playwright each new URL from Level 3. Levels 1 and 2 are inherently real-time and do not require this verification.

   For each new Level 3 URL (sequential — NEVER Playwright in parallel):
   a. `browser_navigate` to the URL
   b. `browser_snapshot` to read content
   c. Classify:
      - **Active**: job title visible + role description + visible Apply/Submit control within main content. Do not count generic header/navbar/footer text.
      - **Expired** (any of these signals):
        - Final URL contains `?error=true` (Greenhouse redirects this way when the offer is closed)
        - Page contains: "job no longer available" / "no longer open" / "position has been filled" / "this job has expired" / "page not found"
        - Only navbar and footer visible, no JD content (content < ~300 chars)
   d. If expired: record in `scan-history.tsv` with status `skipped_expired` and discard
   e. If active: continue to step 8

   **Do not abort the entire scan if one URL fails.** If `browser_navigate` errors (timeout, 403, etc.), mark as `skipped_expired` and continue with the next.

8. **For each new verified offer that passes filters**:
   a. For **104.com.tw jobs** verified active in step 7.5: check the Playwright snapshot for the 語文條件 (language conditions) section. If 英文 appears at 精通 level, append `| 英文精通` to the pipeline entry.
   b. Add to `pipeline.md` under "## Pending": `- [ ] {url} | {company} | {title}` (or `- [ ] {url} | {company} | {title} | 英文精通` if English 精通 detected in step a)
   c. Record in `scan-history.tsv`: `{url}\t{date}\t{query_name}\t{title}\t{company}\tadded`

9. **Offers filtered by title**: record in `scan-history.tsv` with status `skipped_title`
10. **Duplicate offers**: record with status `skipped_dup`
11. **Expired offers (Level 3)**: record with status `skipped_expired`
12. **Close the browser**: Call `browser_close` when the scan is done. This cleanly releases the browser instance and prevents the MCP from being left in an invalid state for the next session.

## Extracting title and company from WebSearch results

WebSearch results come in format: `"Job Title @ Company"` or `"Job Title | Company"` or `"Job Title — Company"`.

Extraction patterns by portal:
- **Ashby**: `"Senior AI PM (Remote) @ EverAI"` → title: `Senior AI PM`, company: `EverAI`
- **Greenhouse**: `"AI Engineer at Anthropic"` → title: `AI Engineer`, company: `Anthropic`
- **Lever**: `"Product Manager - AI @ Temporal"` → title: `Product Manager - AI`, company: `Temporal`

Generic regex: `(.+?)(?:\s*[@|—–-]\s*|\s+at\s+)(.+?)$`

## Private URLs

If a non-publicly-accessible URL is found:
1. Save the JD in `jds/{company}-{role-slug}.md`
2. Add to pipeline.md as: `- [ ] local:jds/{company}-{role-slug}.md | {company} | {title}`

## Scan History

`data/scan-history.tsv` tracks ALL seen URLs:

```
url	first_seen	portal	title	company	status
https://...	2026-02-10	Ashby — AI PM	PM AI	Acme	added
https://...	2026-02-10	Greenhouse — SA	Junior Dev	BigCo	skipped_title
https://...	2026-02-10	Ashby — AI PM	SA AI	OldCo	skipped_dup
https://...	2026-02-10	WebSearch — AI PM	PM AI	ClosedCo	skipped_expired
```

## Output Summary

```
Portal Scan — {YYYY-MM-DD}
━━━━━━━━━━━━━━━━━━━━━━━━━━
Boards scanned: N  (Level 1: N companies | Level 1b: N boards | Level 2: N APIs | Level 3: N queries)
Offers found: N total
Filtered by title: N relevant
Duplicates: N (already evaluated or in pipeline)
Expired discarded: N (dead links, Level 3)
New added to pipeline.md: N

  + {company} | {title} | {source}
  ...

Auto-fixed URLs: N  (omit section if N=0)
  ✓ {board/company} → {new_url}
  ✗ {board/company} → no valid URL found (broken, requires manual review)

→ Run /career-ops pipeline to evaluate new offers.
```

## careers_url Management

Each company in `tracked_companies` must have `careers_url` — the direct URL to their job listings page. This avoids searching for it every time.

**Known patterns by platform:**
- **Ashby:** `https://jobs.ashbyhq.com/{slug}`
- **Greenhouse:** `https://job-boards.greenhouse.io/{slug}` or `https://job-boards.eu.greenhouse.io/{slug}`
- **Lever:** `https://jobs.lever.co/{slug}`
- **BambooHR:** list `https://{company}.bamboohr.com/careers/list`; detail `https://{company}.bamboohr.com/careers/{id}/detail`
- **Teamtailor:** `https://{company}.teamtailor.com/jobs`
- **Workday:** `https://{company}.{shard}.myworkdayjobs.com/{site}`
- **Custom:** Company's own URL (e.g., `https://openai.com/careers`)

**API/feed patterns by platform:**
- **Ashby API:** `https://jobs.ashbyhq.com/api/non-user-graphql?op=ApiJobBoardWithTeams`
- **BambooHR API:** list `https://{company}.bamboohr.com/careers/list`; detail `https://{company}.bamboohr.com/careers/{id}/detail` (`result.jobOpening`)
- **Lever API:** `https://api.lever.co/v0/postings/{company}?mode=json`
- **Teamtailor RSS:** `https://{company}.teamtailor.com/jobs.rss`
- **Workday API:** `https://{company}.{shard}.myworkdayjobs.com/wday/cxs/{company}/{site}/jobs`

**If `careers_url` does not exist** for a company:
1. Try the pattern for its known platform
2. If that fails, do a quick WebSearch: `"{company}" careers jobs`
3. Navigate with Playwright to confirm it works
4. **Save the found URL in portals.yml** for future scans

**If `careers_url` returns 404 or redirect:**
→ Run the **Auto-healing** protocol (see section below)

## Auto-healing of broken URLs

When a `careers_url` (Level 1) or a `url` from `search_boards` (Level 1b) fails, run this protocol before giving up on the entry. Maximum **1 auto-heal attempt per entry per scan** to avoid loops.

### Failure detection

Two types of failure:

**Hard failure** — the navigation itself fails:
- `browser_navigate` throws an error (timeout, network, DNS)
- HTTP 404, 410, or redirect to home/error page
- Snapshot is empty or contains < 200 characters

**Soft failure** — page loads but no listings found:
- Snapshot contains no links with job patterns (`/job/`, `/jobs/`, `/careers/`, `jobNo=`, `gh_jid=`)
- Page looks like a generic homepage (no table or list of positions)
- Page contains "no results", "no jobs found", "no openings" or equivalent in Chinese/Japanese

### Repair protocol

#### For `search_boards` (board-level search URLs)

1. **Identify the board** by domain in the broken URL (e.g., `1111.com.tw`, `yes123.com.tw`, `cakeresume.com`, etc.)

2. **Try known URL variants** per board (in order, test with `browser_navigate`):

   | Board | Variants to try |
   |-------|----------------|
   | `1111.com.tw` | `https://www.1111.com.tw/search/job/?ks={keyword}` → `https://www.1111.com.tw/job-bank/search?k={keyword}` |
   | `yes123.com.tw` | `https://www.yes123.com.tw/admin/joboffer/searchresult.asp?k={keyword}` → `https://www.yes123.com.tw/job?k={keyword}` |
   | `cakeresume.com` | `https://www.cakeresume.com/jobs?q={keyword}&refinementList%5Blocation_list%5D%5B0%5D=Taiwan` → `https://www.cakeresume.com/en/jobs?q={keyword}` |
   | `yourator.co` | `https://www.yourator.co/jobs?term={keyword}` → `https://www.yourator.co/companies/jobs?term={keyword}` |
   | `jobs.cheers.com.tw` | `https://jobs.cheers.com.tw/job/search?q={keyword}` → `https://cheers.com.tw/jobs/search?q={keyword}` |
   | `tw.indeed.com` | `https://tw.indeed.com/jobs?q={keyword}&l={location}` → `https://tw.indeed.com/jobs?q={keyword}` |
   | `sg.indeed.com` | `https://sg.indeed.com/jobs?q={keyword}&l=Singapore` → `https://sg.indeed.com/jobs?q={keyword}` |
   | `indeed.com` | `https://www.indeed.com/jobs?q={keyword}&l=Remote` → `https://www.indeed.com/jobs?q={keyword}&remotejob=032b3046-06a3-4876-8dfd-474eb5e7ed11` |
   | `jobstreet.com.sg` | `https://www.jobstreet.com.sg/jobs/{keyword}-jobs/?sortmode=ListedDate` → `https://www.jobstreet.com.sg/en/job-search/{keyword}-jobs/` |
   | `104.com.tw` | Rebuild with same params but verify `keyword` encoding |

3. **If no variant works** → WebSearch: `"{board name}" job search URL {year}` to find the current URL, then try with Playwright.

4. **If a working URL is found**:
   - Edit `portals.yml`: replace the broken `url:` with the new correct URL
   - Continue the scan with the new URL
   - Record the change in the output summary

5. **If no variant or WebSearch resolves the failure** → mark as `broken` in the summary and continue with the next board. Do not block the scan.

#### For `tracked_companies` (careers_url)

1. **Try `scan_query`** as fallback if defined in the entry — run WebSearch with that query and extract job listing URLs directly.

2. **If no `scan_query`** → WebSearch: `"{company name}" careers jobs site:{known_ats_domain}` where `known_ats_domain` can be `greenhouse.io`, `ashbyhq.com`, `lever.co`, etc.

3. **Navigate with Playwright** to confirm the found URL works and has job listings.

4. **If a working URL is found**:
   - Edit `portals.yml`: replace the broken `careers_url:` with the new correct URL
   - Continue the scan with the new URL
   - Record the change in the output summary

5. **If no strategy works** → mark as `broken` in the summary and continue.

### Editing portals.yml

When applying an auto-fix, edit **only the exact line** of `url:` or `careers_url:` in `portals.yml`. Do not modify other properties of the entry.

Example of correct edit:
```
# Before:
    url: "https://www.yes123.com.tw/admin/joboffer/searchresult.asp?k=IT%E5%B7%A5%E7%A8%8B%E5%B8%AB"

# After:
    url: "https://www.yes123.com.tw/job?k=IT%E5%B7%A5%E7%A8%8B%E5%B8%AB"
```

### Format in output summary

Add section to summary if there were auto-fixes:

```
Auto-fixed URLs: N
  ✓ {board/company} → new URL: {url}
  ✗ {board/company} → no valid URL found (marked as broken)
```

## portals.yml Maintenance

- **ALWAYS save `careers_url`** when adding a new company
- Add new queries as new portals or interesting roles are discovered
- Disable queries with `enabled: false` if they generate too much noise
- Adjust filter keywords as target roles evolve
- Add companies to `tracked_companies` when you want to follow them closely
- Periodically verify `careers_url` — companies change ATS platforms
