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
   d. **Run full auto-pipeline**: Evaluation A-F → Report .md → PDF (if score ≥ 3.0) → Tracker TSV
   e. **Mark complete (atomic):** Run `node sort-pipeline.mjs --complete "<URL>" --num NNN --score "X.X/5" --pdf PDF_STATUS`
      where `PDF_STATUS` is **`✅`** if the PDF was successfully generated in this step, or **`❌`** if not (score < 3.0 or generation failed).
      Do NOT call this before the PDF step — the PDF status must be known before calling this command.
      This marks the entry as `[x]` and moves it to Procesadas in one operation — no Edit tool call needed.
3. **If 3+ pending URLs**, launch parallel agents (Agent tool with `run_in_background`) to maximize speed.
4. **Close the browser**: Call `browser_close` when done with all URLs.
5. **Show summary table:**

```
| # | Company | Role | Score | PDF | Recommendation |
```

## Formato de pipeline.md

```markdown
## Pendientes
- [ ] https://jobs.example.com/posting/123
- [ ] https://boards.greenhouse.io/company/jobs/456 | Company Inc | Senior PM
- [!] https://private.url/job — Error: login required

## Procesadas
- [x] #143 | https://jobs.example.com/posting/789 | Acme Corp | AI PM | 4.2/5 | PDF ✅
- [x] #144 | https://boards.greenhouse.io/xyz/jobs/012 | BigCo | SA | 2.1/5 | PDF ❌
```

## Detección inteligente de JD desde URL

1. **Playwright (preferido):** `browser_navigate` + `browser_snapshot`. Funciona con todas las SPAs.
   **Pre-flight reset:** Si el primer `browser_navigate` falla con "Target page, context or browser has been closed" u otro error de browser cerrado, llamar `browser_close` una vez para resetear el estado del MCP, luego reintentar. Este error indica un browser huérfano de una sesión anterior.
2. **WebFetch (fallback):** Para páginas estáticas o cuando Playwright no está disponible.
3. **WebSearch (último recurso):** Buscar en portales secundarios que indexan el JD.

**Casos especiales:**
- **LinkedIn**: Puede requerir login → marcar `[!]` y pedir al usuario que pegue el texto
- **PDF**: Si la URL apunta a un PDF, leerlo directamente con Read tool
- **`local:` prefix**: Leer el archivo local. Ejemplo: `local:jds/linkedin-pm-ai.md` → leer `jds/linkedin-pm-ai.md`

## Numeración automática

1. Listar todos los archivos en `reports/`
2. Extraer el número del prefijo (e.g., `142-medispend...` → 142)
3. Nuevo número = máximo encontrado + 1

## Sincronización de fuentes

Antes de procesar cualquier URL, verificar sync:
```bash
node cv-sync-check.mjs
```
Si hay desincronización, advertir al usuario antes de continuar.
