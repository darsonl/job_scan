# Modo: apply-104 — Auto-Apply Asistente para 104.com.tw

Workflow automático con Playwright para aplicar a trabajos en 104.com.tw usando los datos del evaluation report generado por el pipeline.

**Siempre delegado a subagente** (igual que `apply` y `pipeline`).

---

## REGLAS ÉTICAS — OBLIGATORIAS (CLAUDE.md)

- **NUNCA hacer clic en Submit/送出應徵 sin confirmación explícita del usuario**
- **Score < 3.5 → bloquear** (requiere override explícito escribiendo `YES`)
- **Score 3.5–3.9 → advertir** y pedir confirmación antes de continuar
- Calidad sobre cantidad — no aplicar si el match no es genuino

---

## Step 0 — Pre-conditions

Cargar Playwright tools via ToolSearch:

```
ToolSearch("select:mcp__plugin_playwright_playwright__browser_navigate,mcp__plugin_playwright_playwright__browser_snapshot,mcp__plugin_playwright_playwright__browser_close,mcp__plugin_playwright_playwright__browser_click,mcp__plugin_playwright_playwright__browser_wait_for,mcp__plugin_playwright_playwright__browser_fill_form,mcp__plugin_playwright_playwright__browser_take_screenshot")
```

Leer credenciales:
- `Read("config/portals-credentials.yml")`
- Extraer `portals.104.email` y `portals.104.password`
- Si el archivo no existe o los campos están vacíos → STOP:
  > "Create `config/portals-credentials.yml` first. Template:
  > ```yaml
  > portals:
  >   104:
  >     email: "your-104-email"
  >     password: "your-104-password"
  >     resume_id: ""   # optional: 104 saved resume ID
  > ```"

---

## Step 1 — Cargar Evaluation Report

Extraer `jobNo` de la URL de input. Patrón: `104\.com\.tw/job/([^/?#\s]+)`.

Buscar en reports/:

```
Grep(pattern="\\*\\*URL:\\*\\*.*104\\.com\\.tw/job/{jobNo}", path="reports/", glob="*.md")
```

**Si hay match:**
- Leer el report completo
- Extraer: Score (línea `**Score:**`), Company + Role (título `# Company — Role`), Legitimacy (línea `**Legitimacy:**`)
- Buscar sección `## H) Draft Application Answers` — cargar si existe

**Si no hay match:**
- Advertir: "No evaluation report found for `104.com.tw/job/{jobNo}`. Run `/career-ops {URL}` first to evaluate, then retry."
- Ofrecer continuar en modo degradado (sin score gate, sin draft answers). Si el usuario rechaza → salir.

---

## Step 2 — Score Gate

Si el report fue cargado:

**Score < 3.5:**

```
STOP. "Score is {X}/5 — below the recommended threshold of 3.5.
CLAUDE.md rules recommend against applying.
Only override if you have a specific reason (referral, unique circumstance, etc.).
Type YES to override, or anything else to cancel."
```

Esperar input. Solo continuar si el usuario escribe exactamente `YES`.

**Score 3.5–3.9:**

```
"Score is {X}/5 — decent but not an ideal match.
Applying is possible but not recommended.
Proceed? (yes/no)"
```

Esperar confirmación.

**Score ≥ 4.0:**
Continuar automáticamente.

---

## Step 3 — Login Check

```
browser_navigate("https://www.104.com.tw/member/login")
browser_snapshot()
```

**Si ya está logueado** (el snapshot muestra menú de usuario, avatar, o ausencia del formulario de login):
→ Saltar al Step 4.

**Si aparece formulario de login:**
- Detectar captcha: si el snapshot contiene texto `請完成驗證` o `滑動解鎖` → STOP: "A CAPTCHA appeared. Complete it manually in the browser window, then type `continue`."
- Rellenar credenciales: `browser_fill_form({"input[name='id']": email, "input[name='passwd']": password})`
  (104 usa `id` y `passwd` como nombres de campo en su login form)
- Click login: `browser_click("button[type='submit']")` o botón con texto `登入`
- `browser_wait_for(text="登出", timeout=10000)` — "登出" (logout link) confirma login exitoso
- `browser_snapshot()` — confirmar login
- Si sigue en página de login → STOP: "Login failed. Verify credentials in `config/portals-credentials.yml`."

---

## Step 4 — Navegar al Job

```
browser_navigate("https://www.104.com.tw/job/{jobNo}")
browser_wait_for(text="立即應徵", timeout=10000)
browser_snapshot()
```

Verificar que el job está activo:
- La página debe mostrar el botón "立即應徵" o "投遞履歷"
- Si aparece `此職缺已截止`, `已下架`, o `職缺不存在` → STOP: "Job posting is closed or removed."
- Si el título en pantalla difiere significativamente del report → advertir al usuario antes de continuar

---

## Step 5 — STOP #1: Pre-Flight Summary (OBLIGATORIO)

**NUNCA saltar este paso.** Mostrar al usuario antes de tocar el botón de aplicar:

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
apply-104 — Pre-Flight Summary
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Company:       {Company}
Role:          {Role}
URL:           https://www.104.com.tw/job/{jobNo}
Score:         {X}/5
Legitimacy:    {tier}
Report:        {report filename}
Draft answers: {YES — Section H loaded / NO — will generate fresh}
Account:       {email from portals-credentials.yml}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Type APPLY to proceed, or anything else to cancel.
```

Esperar input. Solo continuar si el usuario escribe `APPLY`.

---

## Step 6 — Click Apply y Detectar Tipo de Formulario

```
browser_click(selector para "立即應徵" o "投遞履歷")
browser_wait_for(timeout=3000)
browser_snapshot()
```

**Detectar flow:**

**Quick Apply** — indicadores en el snapshot (cualquiera):
- Radio buttons o cards con nombres de currículum
- Heading "選擇履歷" o "選擇應徵資料"
- Sin `<textarea>` visible en el modal
- Botón "確認應徵" o "送出應徵" visible inmediatamente sin campos de texto

**Questionnaire** — indicadores en el snapshot (cualquiera):
- Elementos `<textarea>` presentes
- Campos para 自我介紹, 求職信, o preguntas custom
- URL cambió a `/apply` o hay indicadores de paso/step

Si no queda claro → tratar como Questionnaire (más seguro).

---

## Step 7A — Quick Apply Flow

Del snapshot, listar los currículums guardados disponibles.

Si `portals.104.resume_id` está definido en credentials:
- Buscar el radio button o card que corresponda a ese ID y seleccionarlo.

Si no está definido:
- Preguntar al usuario: "Which resume should I use? Options: {list from snapshot}"
- O auto-seleccionar el primero (más reciente) si el usuario no responde.

**NO hacer clic en confirmar todavía.** Tomar screenshot:

```
browser_take_screenshot()
```

Mostrar al usuario:

```
"Quick Apply: Selected resume '{resume name}'.
Screenshot above shows the current state.
→ Proceeding to review gate before submitting."
```

→ Ir a Step 8.

---

## Step 7B — Questionnaire Flow

Para cada campo visible en el formulario:

**1. Identificar tipo y label** del campo desde el snapshot.

**2. Generar respuesta:**
- Si existe Section H en el report → buscar respuesta con matching fuzzy por concepto:
  - "自我介紹" / "Tell us about yourself" → usar intro del candidate
  - "為何應徵此職缺" / "Why this role" → usar Block B alignment del report
  - "期望薪資" / Expected salary → usar `compensation.target_range` lower bound de `config/profile.yml`
  - "相關經歷" / Work experience → usar proof points del Block A del report
- Si no existe Section H → generar desde el report (Block A proof points, Block B archetype framing) siguiendo `modes/_writing-rules.md`
- Si el campo está en Mandarin → responder en Mandarin, tono profesional, sin clichés

**3. Rellenar campos con `browser_fill_form`:**

Selectors comunes de 104:
- Cover letter / 求職信: `textarea[name="coverLetter"]` o `#coverLetter`
- Self intro / 自我介紹: `textarea[name="selfIntro"]` o `textarea` en sección 自我介紹
- Expected salary: `input[name="salary"]` o `input[placeholder*="薪資"]`
- Availability / 可上班日: `select[name="available"]`

Si un selector nombrado falla → usar heurística posicional (`nth-of-type`) y notificar al usuario.

**4. Scroll check:** Hacer scroll al fondo y tomar otro snapshot. Si hay más campos visibles → repetir el proceso.

Tomar screenshot final del formulario relleno:

```
browser_take_screenshot()
```

→ Ir a Step 8.

---

## Step 8 — STOP #2: Submission Confirmation (OBLIGATORIO — NUNCA SALTAR)

Mostrar screenshot del formulario relleno + resumen de campos:

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
apply-104 — Ready to Submit
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
[screenshot shown above]

Fields filled:
  {field label}: {value preview — first 80 chars}
  ...

⚠️  I will NOT click Submit until you confirm.

Type SUBMIT to send, EDIT to change a field, or anything else to cancel.
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

**Si el usuario escribe `EDIT`:**
- Preguntar: "Which field do you want to change, and what should the new value be?"
- Actualizar el campo con `browser_fill_form`
- Tomar nuevo screenshot
- Volver al inicio de Step 8

**Si el usuario escribe `SUBMIT`:**
→ Ir a Step 9.

**Cualquier otra cosa:**
- Abortar limpiamente: "Application cancelled. No submission made."
- `browser_close()`
- Salir.

---

## Step 9 — Submit

```
browser_click(botón con texto "確認應徵" o "送出應徵" o "送出")
browser_wait_for(text="已成功應徵" OR "應徵成功" OR "感謝您的應徵", timeout=10000)
browser_snapshot()
```

Verificar éxito:
- Si la página muestra mensaje de confirmación (成功/感謝/confirmation banner) → éxito
- Si sigue en el formulario → advertir: "Submission may have failed — page did not show a confirmation. Please check manually." No marcar como Applied.

```
browser_take_screenshot()
```

---

## Step 10 — Update Tracker

**En caso de éxito confirmado:**

1. Buscar en `data/applications.md` la fila que coincide con company+role.
   - Si la fila existe → cambiar status de `Evaluated` a `Applied`.
   - Si no existe → crear entry TSV en `batch/tracker-additions/{num}-{company-slug}.tsv` con status `Applied`.

2. Confirmar al usuario:

```
"✓ Applied successfully to {Company} — {Role}.
  Status updated to Applied in applications.md.

  Suggested next step:
  → /career-ops contacto {Company} to find LinkedIn contacts and draft an outreach message."
```

---

## Step 11 — Cleanup

```
browser_close()
```

---

## Notas de Implementación

**Captcha en login:** 104 usa slider CAPTCHA en dispositivos nuevos o tras inactividad prolongada. Detectar por texto `請完成驗證` o `滑動解鎖` en el snapshot → hacer PAUSE hasta que el usuario lo complete manualmente.

**Session persistence:** Las sesiones Playwright MCP no persisten cookies entre sesiones de Claude Code. El login es necesario en cada invocación fresca — Step 3 siempre verifica.

**Selector fallback:** Si los selectores nombrados fallan (104 rediseña el formulario), usar heurística posicional (`nth-of-type`) en el orden de aparición en el snapshot. Notificar al usuario si se usó fallback.

**Quick Apply + questionnaire hybrid:** Algunos postings muestran primero el selector de CV y luego un cuestionario corto. Tratar como Questionnaire flow — los campos de CV se procesan antes de los campos de texto.

**Browser reset:** Si `browser_navigate` falla con "Target page, context or browser has been closed" → llamar `browser_close()` una vez para resetear el estado MCP, luego reintentar.
