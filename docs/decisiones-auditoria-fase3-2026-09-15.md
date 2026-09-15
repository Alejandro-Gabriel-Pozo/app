# Decisiones del dueño — Fase 3 de la auditoría (15/09/2026)

Mismo patrón que `docs/decisiones-auditoria-fase2-2026-09-15.md`: registro
vivo de las preguntas que `docs/auditoria-integral-fase3-2026-09-15.md` y
`docs/auditoria-integral-fase3-duplicacion-2026-09-15.md` dejaron abiertas
para el dueño, con la decisión tomada, el razonamiento, y el bloque de
implementación (hash de commit) que la cierra. Se crea recién ahora porque
Fase 3 no tenía su propio companion doc todavía (señalado por el gate
`architecture-governor` al revisar el bloque RATE-LIMIT-DUP-001).

---

## 1 — F3-02: doble rate-limiter de login (RATE-LIMIT-DUP-001)

**Pregunta original** (`auditoria-integral-fase3-duplicacion-2026-09-15.md`
§"Preguntas para el dueño", ítem 1): ¿cuál de los dos mecanismos
(`authLimiter` vs. `loginRateLimiter`) se conserva?

**Grounding previo** (`auditoria-integral-fase3-grounding-2026-09-15.md`,
Tema 3): ninguno de los 3 sistemas de referencia investigados (ERPNext,
Odoo, Dolibarr) usa dos mecanismos app-level simultáneos — cada uno tiene
un solo punto de verdad, en capas distintas (nativo centralizado, módulo
opcional, o delegado a infraestructura externa tipo `fail2ban`).

**✅ RESUELTO (15/09/2026, dueño, "elegí la opción A"):** eliminar
`loginRateLimiter` (el mecanismo hecho a mano) y conservar únicamente
`authLimiter` (`express-rate-limit`, ya montado por `app.ts` delante de
las 3 rutas del router de auth). Razones dadas por el dueño, todas
verificadas contra el código antes de implementar:
- Ambos protegen exactamente las mismas 3 rutas (`/`, `/select-business`,
  `/google`) — 100% redundantes, no complementarios.
- `authLimiter` es más correcto: ignora logins exitosos
  (`skipSuccessfulRequests: true`, `loginRateLimiter` no lo hacía), usa
  headers RFC 6585 estándar, y ya vive en la arquitectura de 4 capas
  documentada de `rate-limit.middleware.ts`.
- Retirarlo no requiere agregar infraestructura nueva (Render free tier
  no permite `fail2ban`; Cloudflare queda registrado como mejora futura
  separada, fuera de este bloque).
- Umbral y comportamiento de `authLimiter` NO se tocan — solo se retira
  el duplicado.

**No implementado a propósito** (fuera de alcance, por instrucción
explícita): endurecer el umbral de `authLimiter`, agregar backoff
progresivo, o sumar Cloudflare/WAF — quedan como mejoras futuras
independientes si el crecimiento lo justifica, no parte de este bloque.

**Implementación:** `src/api/routes/auth.routes.ts` (retiro de
`loginRateLimiter`/`loginAttempts`/`MAX_ATTEMPTS`/`WINDOW_MS` y sus 3
usos como middleware), `src/api/routes/auth.routes.test.ts` (retiro del
test que ejercitaba el mecanismo retirado), `src/api/middleware/rate-limit.middleware.test.ts`
(nuevo — primera cobertura real de `authLimiter`, que antes tenía cero
tests directos: bajo el límite, 429 con `Retry-After` al superarlo,
bloqueo compartido entre las 3 rutas, `skipSuccessfulRequests` real).

Gate `architecture-governor`: APPROVED WITH CONDITIONS — condición 1
(este documento) aplicada acá; condición 2 (comentario sobre la carrera
teórica de `skipSuccessfulRequests`) aplicada en el test mismo.

---

## 2 — F3-03: email obligatorio en el alta de cliente (CUSTOMER-EMAIL-REQUIRED-001)

**Pregunta original** (`auditoria-integral-fase3-duplicacion-2026-09-15.md`
§"Preguntas para el dueño", ítem 2): ¿el negocio realmente quiere exigir
email siempre al dar de alta un cliente desde el dashboard, o el modal
debería alinearse con lo que el backend ya permitía (alta con solo
nombre + un contacto de cualquier canal)?

**Detalle encontrado al implementar, no estaba en la pregunta original:**
`customers.routes.ts` documentaba explícitamente un caso de uso soportado
que la pregunta no mencionaba — alta de "walk-in con solo nombre y
teléfono", con una rama de código dedicada. Hacer el email estrictamente
obligatorio elimina esa rama. Se confirmó esto con el dueño aparte
(`AskUserQuestion`, 15/09/2026) antes de implementar, en vez de asumir
que la respuesta a la pregunta general cubría este caso — mismo criterio
que ya aplica este repo (ver "Preguntas de alcance pueden esconder una
decisión de negocio" en `CLAUDE.md`).

**✅ RESUELTO (15/09/2026, dueño):** email pasa a ser obligatorio, sin
excepción — se elimina el soporte de alta solo-teléfono desde
`POST /customers`.

**Nota sobre alcance NO resuelta acá, registrada para el futuro:** el
grounding (`auditoria-integral-fase3-grounding-2026-09-15.md`, Tema 4)
mostró que esto es una divergencia real de "personalidad" de producto
(ERP/CRM generalistas lo tratan opcional; sistemas de reservas tipo
e-commerce lo exigen) — y el propio informe de duplicación ya señalaba
que podría ser candidato a "configurable por tenant" (un negocio que
opera por WhatsApp podría querer la regla distinta de uno que factura
por email). El dueño decidió la regla GLOBAL por ahora, sin
configurabilidad por tenant — si en el futuro aparece un tenant real que
necesite alta sin email, evaluar la configurabilidad como bloque aparte,
no reabrir esto.

**Implementación:** `src/clientes-finanzas/customers.routes.ts`
(`CreateCustomerSchema.email` de `.optional()` a obligatorio; simplificado
el handler porque la rama "sin contactMethods y sin email" queda
inalcanzable), `src/clientes-finanzas/customers.routes.test.ts` (2 tests
nuevos: sin email → 400 vía `next()`; `contactMethods` explícito sin
email tampoco alcanza, porque el requisito es a nivel de schema, no un
atajo). Frontend sin cambios — `appfrontend/src/lib/clientes/api.ts` ya
tipaba `email: string` (obligatorio) en su función `create()`, la
divergencia era solo del lado backend.
