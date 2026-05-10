# Modo: scan — Portal Scanner (Descubrimiento de Ofertas)

Escanea portales de empleo configurados, filtra por relevancia de título, y añade nuevas ofertas al pipeline para evaluación posterior.

## Ejecución recomendada

Ejecutar como subagente para no consumir contexto del main:

```
Agent(
    subagent_type="general-purpose",
    prompt="[contenido de este archivo + datos específicos]",
    run_in_background=True
)
```

## Configuración

Leer `portals.yml` que contiene:
- `search_queries`: Lista de queries WebSearch con `site:` filters por portal (descubrimiento amplio)
- `tracked_companies`: Empresas específicas con `careers_url` para navegación directa
- `title_filter`: Keywords positive/negative/seniority_boost para filtrado de títulos

## Estrategia de descubrimiento (3 niveles)

### Nivel 1 — Playwright directo (PRINCIPAL)

**Para cada empresa en `tracked_companies`:** Navegar a su `careers_url` con Playwright (`browser_navigate` + `browser_snapshot`), leer TODOS los job listings visibles, y extraer título + URL de cada uno. Este es el método más fiable porque:
- Ve la página en tiempo real (no resultados cacheados de Google)
- Funciona con SPAs (Ashby, Lever, Workday)
- Detecta ofertas nuevas al instante
- No depende de la indexación de Google

**Cada empresa DEBE tener `careers_url` en portals.yml.** Si no la tiene, buscarla una vez, guardarla, y usar en futuros scans.

### Nivel 2 — ATS APIs / Feeds (COMPLEMENTARIO)

Para empresas con API pública o feed estructurado, usar la respuesta JSON/XML como complemento rápido de Nivel 1. Es más rápido que Playwright y reduce errores de scraping visual.

**Soporte actual (variables entre `{}`):**
- **Greenhouse**: `https://boards-api.greenhouse.io/v1/boards/{company}/jobs`
- **Ashby**: `https://jobs.ashbyhq.com/api/non-user-graphql?op=ApiJobBoardWithTeams`
- **BambooHR**: lista `https://{company}.bamboohr.com/careers/list`; detalle de una oferta `https://{company}.bamboohr.com/careers/{id}/detail`
- **Lever**: `https://api.lever.co/v0/postings/{company}?mode=json`
- **Teamtailor**: `https://{company}.teamtailor.com/jobs.rss`
- **Workday**: `https://{company}.{shard}.myworkdayjobs.com/wday/cxs/{company}/{site}/jobs`

**Convención de parsing por provider:**
- `greenhouse`: `jobs[]` → `title`, `absolute_url`
- `ashby`: GraphQL `ApiJobBoardWithTeams` con `organizationHostedJobsPageName={company}` → `jobBoard.jobPostings[]` (`title`, `id`; construir URL pública si no viene en payload)
- `bamboohr`: lista `result[]` → `jobOpeningName`, `id`; construir URL de detalle `https://{company}.bamboohr.com/careers/{id}/detail`; para leer el JD completo, hacer GET del detalle y usar `result.jobOpening` (`jobOpeningName`, `description`, `datePosted`, `minimumExperience`, `compensation`, `jobOpeningShareUrl`)
- `lever`: array raíz `[]` → `text`, `hostedUrl` (fallback: `applyUrl`)
- `teamtailor`: RSS items → `title`, `link`
- `workday`: `jobPostings[]`/`jobPostings` (según tenant) → `title`, `externalPath` o URL construida desde el host

### Nivel 3 — WebSearch queries (DESCUBRIMIENTO AMPLIO)

Los `search_queries` con `site:` filters cubren portales de forma transversal (todos los Ashby, todos los Greenhouse, etc.). Útil para descubrir empresas NUEVAS que aún no están en `tracked_companies`, pero los resultados pueden estar desfasados.

**Prioridad de ejecución:**
1. Nivel 1: Playwright → todas las `tracked_companies` con `careers_url`
2. Nivel 2: API → todas las `tracked_companies` con `api:`
3. Nivel 3: WebSearch → todos los `search_queries` con `enabled: true`

Los niveles son aditivos — se ejecutan todos, los resultados se mezclan y deduplicar.

## Workflow

1. **Leer configuración**: `portals.yml`
2. **Leer historial**: `data/scan-history.tsv` → URLs ya vistas
3. **Leer dedup sources**: `data/applications.md` + `data/pipeline.md`

4. **Nivel 1 — Playwright scan** (paralelo en batches de 3-5):
   **Antes del primer `browser_navigate`:** Si falla con "Target page, context or browser has been closed" u otro error de browser cerrado, llamar `browser_close` una vez para resetear el estado del MCP, luego reintentar. Este error indica un browser huérfano de una sesión anterior.
   Para cada empresa en `tracked_companies` con `enabled: true` y `careers_url` definida:
   a. `browser_navigate` a la `careers_url`
   b. `browser_snapshot` para leer todos los job listings
   c. Si la página tiene filtros/departamentos, navegar las secciones relevantes
   d. Para cada job listing extraer: `{title, url, company}`
   e. Si la página pagina resultados, navegar páginas adicionales
   f. Acumular en lista de candidatos
   g. Si `careers_url` falla (404, redirect, error de navegación) → ejecutar **Auto-heal** (ver sección abajo)

4b. **Nivel 1b — Playwright board search** (secuencial — no en paralelo con Nivel 1):
   Para cada entrada en `search_boards` con `enabled: true` y `method: playwright`:
   a. `browser_navigate` a la `url` del board
   a2. **SPAs (104.com.tw, 1111.com.tw, Yourator, CakeResume):** llamar `browser_wait_for` con texto `找到` (104/1111), `jobs` (CakeResume), o `工作` (Yourator) para confirmar que los resultados renderizaron antes del snapshot. Si da timeout, proceder igualmente — parcial es mejor que nada.
   b. `browser_snapshot` para leer todos los job listings visibles
   b2. **Si la snapshot tiene < 5 resultados y no hay señal de "no results":** hacer un segundo `browser_wait_for` breve + `browser_snapshot`. Si sigue vacío → auto-heal.
   c. Para cada listing extraer: `{title, url, company}` — buscar enlaces con patrones como `/job/`, `/jobs/`, `?jobNo=` en el snapshot
   d. Para 104.com.tw: las URLs de ofertas son `https://www.104.com.tw/job/{jobNo}` — extraer el `jobNo` del href y construir la URL completa si está parcial. **Normalizar siempre a `/job/{jobNo}` — strip cualquier `?jobno=` u otros query params antes de comparar con scan-history.tsv.**
   e. Si hay paginación y la primera página trae ≥20 resultados, navegar la segunda página (`&page=2`) y acumular
   f. Acumular en lista de candidatos (dedup con Nivel 1)
   g. Si la URL falla (error de navegación) o la snapshot no contiene job listings → ejecutar **Auto-heal** (ver sección abajo)
   h. **Entre boards del mismo dominio** (ej: 9 entradas consecutivas de 104.com.tw): usar `browser_evaluate("() => new Promise(r => setTimeout(r, 800))")` entre navegaciones para evitar rate limiting.

   **Parsing de 104.com.tw:**
   - Cada job card en la snapshot tiene el título del puesto y el nombre de empresa
   - Los hrefs tienen el patrón `/job/{jobNo}` — construir `https://www.104.com.tw/job/{jobNo}` como URL canónica
   - El campo `company` se extrae del nombre del empleador en la card (`custName` o texto del elemento de empresa)
   - **Una keyword por board:** cada entrada en portals.yml usa exactamente una keyword — las queries multi-keyword con espacio no disparan el buscador del SPA al navegar directamente.
   - **Filtro de ubicación pre-aplicado:** las URLs incluyen `area=6001001000%2C6001002000` (台北市 + 新北市). Los resultados ya vienen filtrados por Taipei y New Taipei — no se necesita filtrado adicional por ciudad.

5. **Nivel 2 — ATS APIs / feeds** (paralelo):
   Para cada empresa en `tracked_companies` con `api:` definida y `enabled: true`:
   a. WebFetch de la URL de API/feed
   b. Si `api_provider` está definido, usar su parser; si no está definido, inferir por dominio (`boards-api.greenhouse.io`, `jobs.ashbyhq.com`, `api.lever.co`, `*.bamboohr.com`, `*.teamtailor.com`, `*.myworkdayjobs.com`)
   c. Para **Ashby**, enviar POST con:
      - `operationName: ApiJobBoardWithTeams`
      - `variables.organizationHostedJobsPageName: {company}`
      - query GraphQL de `jobBoardWithTeams` + `jobPostings { id title locationName employmentType compensationTierSummary }`
   d. Para **BambooHR**, la lista solo trae metadatos básicos. Para cada item relevante, leer `id`, hacer GET a `https://{company}.bamboohr.com/careers/{id}/detail`, y extraer el JD completo desde `result.jobOpening`. Usar `jobOpeningShareUrl` como URL pública si viene; si no, usar la URL de detalle.
   e. Para **Workday**, enviar POST JSON con al menos `{"appliedFacets":{},"limit":20,"offset":0,"searchText":""}` y paginar por `offset` hasta agotar resultados
   f. Para cada job extraer y normalizar: `{title, url, company}`
   g. Acumular en lista de candidatos (dedup con Nivel 1)

6. **Nivel 3 — WebSearch queries** (paralelo si posible):
   Para cada query en `search_queries` con `enabled: true`:
   a. Ejecutar WebSearch con el `query` definido
   b. De cada resultado extraer: `{title, url, company}`
      - **title**: del título del resultado (antes del " @ " o " | ")
      - **url**: URL del resultado
      - **company**: después del " @ " en el título, o extraer del dominio/path
   c. Acumular en lista de candidatos (dedup con Nivel 1+2)

6. **Filtrar por título** usando `title_filter` de `portals.yml`:
   - Al menos 1 keyword de `positive` debe aparecer en el título (case-insensitive)
   - 0 keywords de `negative` deben aparecer
   - `seniority_boost` keywords dan prioridad pero no son obligatorios

7. **Deduplicar** contra 3 fuentes:
   - `scan-history.tsv` → URL exacta ya vista
   - `applications.md` → empresa + rol normalizado ya evaluado
   - `pipeline.md` → URL exacta ya en pendientes o procesadas

7.5. **Verificar liveness de resultados de WebSearch (Nivel 3)** — ANTES de añadir a pipeline:

   Los resultados de WebSearch pueden estar desactualizados (Google cachea resultados durante semanas o meses). Para evitar evaluar ofertas expiradas, verificar con Playwright cada URL nueva que provenga del Nivel 3. Los Niveles 1 y 2 son inherentemente en tiempo real y no requieren esta verificación.

   Para cada URL nueva de Nivel 3 (secuencial — NUNCA Playwright en paralelo):
   a. `browser_navigate` a la URL
   b. `browser_snapshot` para leer el contenido
   c. Clasificar:
      - **Activa**: título del puesto visible + descripción del rol + control visible de Apply/Submit/Solicitar dentro del contenido principal. No contar texto genérico de header/navbar/footer.
      - **Expirada** (cualquiera de estas señales):
        - URL final contiene `?error=true` (Greenhouse redirige así cuando la oferta está cerrada)
        - Página contiene: "job no longer available" / "no longer open" / "position has been filled" / "this job has expired" / "page not found"
        - Solo navbar y footer visibles, sin contenido JD (contenido < ~300 chars)
   d. Si expirada: registrar en `scan-history.tsv` con status `skipped_expired` y descartar
   e. Si activa: continuar al paso 8

   **No interrumpir el scan entero si una URL falla.** Si `browser_navigate` da error (timeout, 403, etc.), marcar como `skipped_expired` y continuar con la siguiente.

8. **Para cada oferta nueva verificada que pase filtros**:
   a. Añadir a `pipeline.md` sección "Pendientes": `- [ ] {url} | {company} | {title}`
   b. Registrar en `scan-history.tsv`: `{url}\t{date}\t{query_name}\t{title}\t{company}\tadded`

9. **Ofertas filtradas por título**: registrar en `scan-history.tsv` con status `skipped_title`
10. **Ofertas duplicadas**: registrar con status `skipped_dup`
11. **Ofertas expiradas (Nivel 3)**: registrar con status `skipped_expired`
12. **Cerrar el navegador**: Llamar `browser_close` al finalizar el scan. Esto libera la instancia del browser limpiamente y evita que el MCP quede en estado inválido para la siguiente sesión.

## Extracción de título y empresa de WebSearch results

Los resultados de WebSearch vienen en formato: `"Job Title @ Company"` o `"Job Title | Company"` o `"Job Title — Company"`.

Patrones de extracción por portal:
- **Ashby**: `"Senior AI PM (Remote) @ EverAI"` → title: `Senior AI PM`, company: `EverAI`
- **Greenhouse**: `"AI Engineer at Anthropic"` → title: `AI Engineer`, company: `Anthropic`
- **Lever**: `"Product Manager - AI @ Temporal"` → title: `Product Manager - AI`, company: `Temporal`

Regex genérico: `(.+?)(?:\s*[@|—–-]\s*|\s+at\s+)(.+?)$`

## URLs privadas

Si se encuentra una URL no accesible públicamente:
1. Guardar el JD en `jds/{company}-{role-slug}.md`
2. Añadir a pipeline.md como: `- [ ] local:jds/{company}-{role-slug}.md | {company} | {title}`

## Scan History

`data/scan-history.tsv` trackea TODAS las URLs vistas:

```
url	first_seen	portal	title	company	status
https://...	2026-02-10	Ashby — AI PM	PM AI	Acme	added
https://...	2026-02-10	Greenhouse — SA	Junior Dev	BigCo	skipped_title
https://...	2026-02-10	Ashby — AI PM	SA AI	OldCo	skipped_dup
https://...	2026-02-10	WebSearch — AI PM	PM AI	ClosedCo	skipped_expired
```

## Resumen de salida

```
Portal Scan — {YYYY-MM-DD}
━━━━━━━━━━━━━━━━━━━━━━━━━━
Boards escaneados: N  (Nivel 1: N empresas | Nivel 1b: N boards | Nivel 2: N APIs | Nivel 3: N queries)
Ofertas encontradas: N total
Filtradas por título: N relevantes
Duplicadas: N (ya evaluadas o en pipeline)
Expiradas descartadas: N (links muertos, Nivel 3)
Nuevas añadidas a pipeline.md: N

  + {company} | {title} | {source}
  ...

URLs auto-corregidas: N  (omitir sección si N=0)
  ✓ {board/company} → {nueva_url}
  ✗ {board/company} → no se encontró URL válida (broken, requiere revisión manual)

→ Ejecuta /career-ops pipeline para evaluar las nuevas ofertas.
```

## Gestión de careers_url

Cada empresa en `tracked_companies` debe tener `careers_url` — la URL directa a su página de ofertas. Esto evita buscarlo cada vez.

**Patrones conocidos por plataforma:**
- **Ashby:** `https://jobs.ashbyhq.com/{slug}`
- **Greenhouse:** `https://job-boards.greenhouse.io/{slug}` o `https://job-boards.eu.greenhouse.io/{slug}`
- **Lever:** `https://jobs.lever.co/{slug}`
- **BambooHR:** lista `https://{company}.bamboohr.com/careers/list`; detalle `https://{company}.bamboohr.com/careers/{id}/detail`
- **Teamtailor:** `https://{company}.teamtailor.com/jobs`
- **Workday:** `https://{company}.{shard}.myworkdayjobs.com/{site}`
- **Custom:** La URL propia de la empresa (ej: `https://openai.com/careers`)

**Patrones de API/feed por plataforma:**
- **Ashby API:** `https://jobs.ashbyhq.com/api/non-user-graphql?op=ApiJobBoardWithTeams`
- **BambooHR API:** lista `https://{company}.bamboohr.com/careers/list`; detalle `https://{company}.bamboohr.com/careers/{id}/detail` (`result.jobOpening`)
- **Lever API:** `https://api.lever.co/v0/postings/{company}?mode=json`
- **Teamtailor RSS:** `https://{company}.teamtailor.com/jobs.rss`
- **Workday API:** `https://{company}.{shard}.myworkdayjobs.com/wday/cxs/{company}/{site}/jobs`

**Si `careers_url` no existe** para una empresa:
1. Intentar el patrón de su plataforma conocida
2. Si falla, hacer un WebSearch rápido: `"{company}" careers jobs`
3. Navegar con Playwright para confirmar que funciona
4. **Guardar la URL encontrada en portals.yml** para futuros scans

**Si `careers_url` devuelve 404 o redirect:**
→ Ejecutar el protocolo de **Auto-healing** (ver sección abajo)

## Auto-healing de URLs rotas

Cuando un `careers_url` (Nivel 1) o una `url` de `search_boards` (Nivel 1b) falla, ejecutar este protocolo antes de abandonar la entrada. Máximo **1 intento de auto-heal por entrada por scan** para evitar bucles.

### Detección de fallo

Dos tipos de fallo:

**Fallo duro** — la navegación en sí falla:
- `browser_navigate` lanza error (timeout, red, DNS)
- HTTP 404, 410, o redirect a página de inicio/error
- La snapshot está vacía o contiene < 200 caracteres

**Fallo suave** — la página carga pero no hay listings:
- La snapshot no contiene enlaces con patrones de oferta (`/job/`, `/jobs/`, `/careers/`, `jobNo=`, `gh_jid=`)
- La página parece un homepage genérico (sin tabla ni lista de puestos)
- Página contiene "no results", "no jobs found", "no openings" o equivalente en chino/japonés

### Protocolo de reparación

#### Para `search_boards` (board-level search URLs)

1. **Identificar el board** por dominio en la URL rota (ej: `1111.com.tw`, `yes123.com.tw`, `cakeresume.com`, etc.)

2. **Intentar variantes de URL conocidas** por board (en orden, probar con `browser_navigate`):

   | Board | Variantes a probar |
   |-------|--------------------|
   | `1111.com.tw` | `https://www.1111.com.tw/search/job/?ks={keyword}` → `https://www.1111.com.tw/job-bank/search?k={keyword}` |
   | `yes123.com.tw` | `https://www.yes123.com.tw/admin/joboffer/searchresult.asp?k={keyword}` → `https://www.yes123.com.tw/job?k={keyword}` |
   | `cakeresume.com` | `https://www.cakeresume.com/jobs?q={keyword}&refinementList%5Blocation_list%5D%5B0%5D=Taiwan` → `https://www.cakeresume.com/en/jobs?q={keyword}` |
   | `yourator.co` | `https://www.yourator.co/jobs?term={keyword}` → `https://www.yourator.co/companies/jobs?term={keyword}` |
   | `jobs.cheers.com.tw` | `https://jobs.cheers.com.tw/job/search?q={keyword}` → `https://cheers.com.tw/jobs/search?q={keyword}` |
   | `tw.indeed.com` | `https://tw.indeed.com/jobs?q={keyword}&l={location}` → `https://tw.indeed.com/jobs?q={keyword}` |
   | `sg.indeed.com` | `https://sg.indeed.com/jobs?q={keyword}&l=Singapore` → `https://sg.indeed.com/jobs?q={keyword}` |
   | `indeed.com` | `https://www.indeed.com/jobs?q={keyword}&l=Remote` → `https://www.indeed.com/jobs?q={keyword}&remotejob=032b3046-06a3-4876-8dfd-474eb5e7ed11` |
   | `jobstreet.com.sg` | `https://www.jobstreet.com.sg/jobs/{keyword}-jobs/?sortmode=ListedDate` → `https://www.jobstreet.com.sg/en/job-search/{keyword}-jobs/` |
   | `104.com.tw` | Reconstruir con los mismos params pero verificar encoding del `keyword` |

3. **Si ninguna variante funciona** → WebSearch: `"{board name}" job search URL {year}` para encontrar la URL actual, luego probar con Playwright.

4. **Si se encuentra una URL que funciona**:
   - Editar `portals.yml`: reemplazar la `url:` rota con la nueva URL correcta
   - Continuar el scan con la nueva URL
   - Registrar el cambio en el resumen de salida

5. **Si ninguna variante ni WebSearch resuelve el fallo** → marcar como `broken` en el resumen y continuar con el siguiente board. No bloquear el scan.

#### Para `tracked_companies` (careers_url)

1. **Intentar `scan_query`** como fallback si está definido en la entrada — ejecutar WebSearch con esa query y extraer URLs de job listings directamente.

2. **Si no hay `scan_query`** → WebSearch: `"{company name}" careers jobs site:{known_ats_domain}` donde `known_ats_domain` puede ser `greenhouse.io`, `ashbyhq.com`, `lever.co`, etc.

3. **Navegar con Playwright** para confirmar que la URL encontrada funciona y tiene job listings.

4. **Si se encuentra una URL que funciona**:
   - Editar `portals.yml`: reemplazar la `careers_url:` rota con la nueva URL correcta
   - Continuar el scan con la nueva URL
   - Registrar el cambio en el resumen de salida

5. **Si ninguna estrategia funciona** → marcar como `broken` en el resumen y continuar.

### Edición de portals.yml

Al aplicar un auto-fix, editar **solo la línea exacta** de `url:` o `careers_url:` en `portals.yml`. No modificar otras propiedades de la entrada.

Ejemplo de edición correcta:
```
# Antes:
    url: "https://www.yes123.com.tw/admin/joboffer/searchresult.asp?k=IT%E5%B7%A5%E7%A8%8B%E5%B8%AB"

# Después:
    url: "https://www.yes123.com.tw/job?k=IT%E5%B7%A5%E7%A8%8B%E5%B8%AB"
```

### Formato en el resumen de salida

Agregar sección al resumen si hubo auto-fixes:

```
URLs auto-corregidas: N
  ✓ {board/company} → nueva URL: {url}
  ✗ {board/company} → no se encontró URL válida (marcada como broken)
```

## Mantenimiento del portals.yml

- **SIEMPRE guardar `careers_url`** cuando se añade una empresa nueva
- Añadir nuevos queries según se descubran portales o roles interesantes
- Desactivar queries con `enabled: false` si generan demasiado ruido
- Ajustar keywords de filtrado según evolucionen los roles target
- Añadir empresas a `tracked_companies` cuando interese seguirlas de cerca
- Verificar `careers_url` periódicamente — las empresas cambian de plataforma ATS
