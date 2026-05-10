# Mode: filter — Pipeline Cleaner

Bulk-removes pending 104.com.tw entries from `data/pipeline.md` that fail a salary threshold or location filter, using the 104 API directly — zero LLM cost, no Playwright needed.

## When to use

Trigger when the user asks to clean/filter/prune the pipeline by salary or location, e.g.:
- "remove jobs below 50k from pipeline"
- "filter out non-Taipei jobs"
- "clean up the pipeline, keep only Taipei/New Taipei above 50k"
- "remove [city] jobs from pipeline"

## Parse user intent

Extract from the user's message:
- **salary_threshold** — monthly NTD minimum. Default: `50000`. Examples: "40k" → 40000, "55,000" → 55000.
- **allowed_regions** — list of region prefixes to keep. Default: `["台北市", "新北市"]`. The user may specify other cities; map to their Traditional Chinese names (e.g., "Taichung" → "台中市").
- **source** — which job board to filter. Default: `104` (104.com.tw). Only 104 is supported by the API method; others require Playwright.

Confirm the parsed parameters before running if they differ from defaults.

## Execution

Write and run a Node.js script inline. Do NOT use Playwright — the 104 API is faster and zero-cost for this purpose.

### Step 1: Extract pending 104 job IDs

```js
const pipeline = fs.readFileSync('data/pipeline.md', 'utf8');
const pendingLines = pipeline.split('\n')
  .filter(l => l.trim().startsWith('- [ ]') && l.includes('104.com.tw'));

const jobMap = {};
pendingLines.forEach(l => {
  const m = l.match(/104\.com\.tw\/job\/([a-z0-9]+)/);
  if (m) jobMap[m[1]] = l;
});
```

### Step 2: Batch-fetch from 104 API

Endpoint: `https://www.104.com.tw/job/ajax/content/{jobId}`

Required headers:
```
Referer: https://www.104.com.tw/
Accept: application/json
User-Agent: Mozilla/5.0 ...
```

Run with concurrency 15. For each result, read `data.jobDetail`:
- `addressRegion` — city+district string, e.g. "台北市內湖區", "新竹縣竹北市"
- `salaryType` — `50` = monthly (月薪), `10` = negotiable (面議)
- `salaryMin`, `salaryMax` — NTD integers; `9999999` means "以上" (unbounded upper range — treat as unknown, not as a real cap)

### Step 3: Apply filter logic

**Remove a job if EITHER condition is true:**

1. **Location mismatch**: `addressRegion` does not start with any string in `allowed_regions`.  
   Jobs with empty `addressRegion` (API failed or unlisted) are kept by default — give benefit of doubt.

2. **Salary confirmed below threshold**: `salaryType === 50` (monthly) AND `salaryMax > 0` AND `salaryMax !== 9999999` AND `salaryMax < salary_threshold`.  
   Negotiable salaries (`salaryType === 10`), open-ended ranges (`salaryMax === 9999999`), and yearly salaries are all kept — can't confirm they're below threshold.

Jobs where the API returns no data (network error, expired listing) are kept.

### Step 4: Remove from pipeline.md

Filter out only the lines whose job IDs are in the remove set. Write the file back. Do not touch checked lines (`- [x]`), non-104 lines, section headers, or blank lines.

## Output

Report a summary after running:

```
Filtered data/pipeline.md

Removed: {N} jobs
  • {N} location mismatch (not in {allowed_regions})
  • {N} salary below {salary_threshold} NTD/month (disclosed max)
  • {N} both

Remaining pending (104.com.tw): {N}
Total pending (all sources): {N}
```

If any jobs could not be fetched and were therefore kept, note the count: "Kept {N} with fetch errors (benefit of doubt)."

## Edge cases

- **Yearly salary**: To filter yearly, convert: `salary_threshold * 12`. Only apply if the user explicitly asks to filter yearly roles.
- **Partial-time jobs**: `salaryType === 50` with part-time label in `salary` string — apply same rule; if max < threshold, remove.
- **Non-104 pending entries**: Skip entirely — the API method only works for 104.com.tw URLs.
- **Already-checked entries (`[x]`)**: Never touch these regardless of filter results.
