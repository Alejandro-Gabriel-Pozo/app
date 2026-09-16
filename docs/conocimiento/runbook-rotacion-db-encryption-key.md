# Runbook — rotación de `DB_ENCRYPTION_KEY`

- **Fecha:** 2026-09-08 · **Estado:** procedimiento documentado; **el código
  de dos claves y el script de barrido NO están escritos** (ver §7).
- **Categoría:** Runbook + Seguridad
- **Etiquetas:** `db-encryption-key` `aes-256-gcm` `rotacion` `neon` `render` `afip` `SEC-ROT-001`
- **Alcance:** `app-main` en Render + los dos proyectos Neon (plataforma y
  tenants). Documenta el **procedimiento**, no la clave.
- **Referencias:** `src/platform/tenant-db.setup.ts` (`encryptConnectionString`
  / `decryptConnectionString` / `deriveEncryptionKey`), `src/scripts/migrate-tenants.ts`
  (esqueleto de barrido por tenant), `docs/conocimiento/runbook-deploy-render.md`
  (§Procedimiento 3 rollback, backups Neon), `pendientes` (SEC-ROT-001).

---

## 1. Qué protege esta clave

Una sola clave de 32 bytes hex en `process.env.DB_ENCRYPTION_KEY`
(`render.yaml`, `sync: false`). AES-256-GCM, formato de salida
`iv(hex):authTag(hex):ciphertext(hex)`. `deriveEncryptionKey()` lee
**exactamente una** variable — no hay `_OLD`/`_NEW` ni lista de candidatas.

Cifra **tres familias de columnas**, no solo las connection strings — este es
el error que un rotador apurado comete:

| Columna | Base | Qué es | Escritores | Lectores |
|---|---|---|---|---|
| `businesses.db_url_encrypted` | **plataforma** | connection string del tenant (1 por negocio activo) | `admin.routes.ts` (`set-tenant-url`, `repair-tenant-db`), `business.routes.ts`, `platform.routes.ts` (activate) | `tenant.middleware.ts:~100` (**cada request**), `migrate-tenants.ts`, `company-sync.worker.ts` |
| `business_profile.afip_cert_encrypted` · `afip_key_encrypted` | **cada tenant** | certificado X.509 + clave privada de AFIP/ARCA | `sql.afip-credentials.repository.ts::save()` | `::getDecrypted()` (al facturar) |
| `afip_tickets.ticket_encrypted` | **cada tenant** | Ticket de Acceso WSAA (efímero, ~12 h, se re-emite solo) | `::saveTicket()` | `::getTicket()` |

**Herramienta de operador que también cifra:** `src/scripts/encrypt-database-url.ts`
(CLI, one-shot) llama a `encryptConnectionString` para producir el valor de
`db_url_encrypted` a mano. Se usa justo en el tipo de tarea que rodea una
rotación (cirugía de connection strings). **No correrlo entre Fase 1 y Fase 3**
sin confirmar antes con qué clave liga: en la ventana de dos claves,
`deriveEncryptionKey()` cifra con la **primaria** (`DB_ENCRYPTION_KEY`) — si en
ese momento la primaria todavía es la vieja, la fila que insertes queda
huérfana cuando el barrido ya pasó, y la falla aparece después en
`tenant.middleware.ts` en cada request de ese tenant.

**Fuera de alcance de esta clave** (son env vars de Render `sync: false`, no
cifradas en base): `JWT_SECRET`, `PLATFORM_JWT_SECRET`, `PLATFORM_DATABASE_URL`,
`NEON_API_KEY`, `RESEND_API_KEY`, `PLATFORM_ADMIN_PASSWORD`. Rotarlas es otro
procedimiento (cambiar el valor en Render y redeployar; el JWT invalida
sesiones vivas).

---

## 2. Por qué la rotación no está ensayada

**Este documento es un plan, no una capacidad.** No se puede ejecutar hoy: la
§4 está escrita asumiendo "con el código de dos claves de §7 ya desplegado", y
ese código **no existe**. La secuencia honesta es: construir §7 → ensayar la
Fase 2 contra un branch Neon descartable (el patrón que este proyecto ya usa
para probar migraciones) → **recién ahí** rotar es una capacidad. Que exista
este runbook **no** significa "podemos rotar".

- **El código lee una sola clave.** Descifrar probando dos claves (la nueva y
  la vieja) no está implementado en `deriveEncryptionKey()`.
- **No hay script de re-cifrado.** `migrate-tenants.ts` es el esqueleto más
  cercano (itera todos los negocios con BD, abre cada tenant DB) pero
  re-aplica schema, no re-cifra.
- Consecuencia: hoy una rotación real es **downtime + un script de una sola
  vez escrito bajo presión**, justo cuando importa (clave filtrada). Este
  runbook existe para que ese script y esa ventana estén pensados **antes**.

---

## 3. Cuándo rotar

- **Incidente:** la clave se expuso (commit, log, backup filtrado, ex-empleado
  con acceso). Rotación inmediata, con la app en mantenimiento si hace falta.
- **Programada:** no hay política escrita. Si se define una, va en `render.yaml`
  como comentario fechado al lado de `DB_ENCRYPTION_KEY` y acá.

---

## 4. Procedimiento (con el código de dos claves de §7 ya desplegado)

### Fase 0 — preparación

1. **Clave nueva:**
   `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`
   Guardarla en el gestor de secretos, todavía **no** en Render.
2. **Backups durables Neon** — plataforma + **cada** branch de tenant. Listar
   los tenants: la salida de `migrate:tenants` enumera los negocios con BD, o
   la consola Neon del proyecto `ancient-king-17098519`. Anotar los branch ids
   (mismo criterio que `runbook-deploy-render.md` §Procedimiento 3).
3. **Freeze de escrituras a columnas cifradas** durante toda la ventana
   (Fase 1 a Fase 3): sin activación de negocios, sin
   `set-tenant-url`/`repair-tenant-db`, sin carga de certificado AFIP, **y sin
   correr `src/scripts/encrypt-database-url.ts`** (ver §1 — cifraría con la
   primaria, que en la ventana puede no ser la que ya barriste). Las
   escrituras de `afip_tickets` da igual — son descartables.
4. **Inventario:**
   - plataforma: `SELECT count(*) FROM businesses WHERE db_url_encrypted IS NOT NULL;`
   - por tenant: `SELECT (afip_cert_encrypted IS NOT NULL) FROM business_profile WHERE id = 'default';`

### Fase 1 — desplegar el modo dos claves

Con el código de §7: `DB_ENCRYPTION_KEY` = clave **nueva**,
`DB_ENCRYPTION_KEY_OLD` = clave **vieja**. Deploy. Desde acá la app **cifra con
la nueva** y **descifra con la nueva, y si falla el authTag, reintenta con la
vieja**. Todo lo viejo en base sigue legible; todo lo nuevo nace con la clave
nueva.

Verificar en runtime (sesión real, sin mutar): un request a cualquier ruta
`/api/*` de un tenant existente responde (usa `db_url_encrypted` viejo,
descifrado con fallback); facturar en homologación descifra el certificado.

**Actualización 16/09/2026 (D-09, Wave 6 del plan de ejecución integral,
commit `aa8e369`).** Hasta este bloque, `npm run migrate:tenants` (cada
deploy de Render) NO era una prueba de descifrado real para los tenants
que ya tenían `schema_version` al día (la mayoría, casi siempre) — un
atajo por versión cacheada los saltaba sin conectarse. Desde `aa8e369`,
`migrateBusiness()` conecta y descifra la connection string de **todo**
tenant en **cada** deploy, sin excepción — la prueba de descifrado
implícita que esta sección parecía asumir ahora existe de verdad.
**Contracara, nueva a partir de este mismo cambio:** si durante una
ventana de rotación (Fase 1, `DB_ENCRYPTION_KEY_OLD` recién cargada o mal
cargada) el descifrado de un solo tenant falla, ese fallo ahora **tumba
el build entero** (`exit(1)` en `migrate-tenants.ts` → Render no
promueve) en vez de fallar solo para ese tenant en silencio. Correcto
(fail-loud), pero cambia el radio de la ventana de rotación: probar la
Fase 1 en un tenant de prueba antes del deploy real a producción importa
más que antes de este cambio.

### Fase 2 — barrido de re-cifrado (script de §7, una sola vez)

Por cada fila, en transacción propia, idempotente y reanudable (mismo patrón
que `migrate-tenants.ts`: un try/catch por unidad, resumen al final,
`exit(1)` si hubo algún fallo):

1. **Plataforma** — cada `businesses` con `db_url_encrypted`:
   descifrar (fallback vieja) → cifrar (nueva) → `UPDATE`.
2. **Cada tenant DB** — `business_profile` fila `'default'`:
   `afip_cert_encrypted` y `afip_key_encrypted` no nulos →
   descifrar → cifrar (nueva) → `UPDATE`.
3. **Cada tenant DB** — `afip_tickets`: **`DELETE FROM afip_tickets`**. No se
   re-cifran: WSAA re-emite en el próximo uso (es lo que ya hace
   `AfipCredentialsRepository.save()` al cambiar el certificado).

**Verificación del barrido:** volver a leer cada fila re-cifrada y descifrarla
**solo con la clave nueva** (sin fallback) — tiene que funcionar en el 100%.

### Fase 3 — retirar la clave vieja

1. Sacar `DB_ENCRYPTION_KEY_OLD` de las env vars de Render.
2. Revertir `deriveEncryptionKey()` al modo una clave (o dejar el fallback
   tolerante a `undefined`).
3. Deploy. Levantar el freeze.

---

## 5. Rollback

- **Falla el barrido (Fase 2) a mitad:** no es una emergencia. El código de
  dos claves (Fase 1) sigue vivo, la app lee viejo-o-nuevo. Arreglar el
  script y re-correrlo (idempotente: una fila ya re-cifrada se descifra con la
  nueva y se re-cifra igual, sin daño).
- **Una fila quedó con ciphertext corrupto** (se escribió mal): restaurar esa
  base desde el branch de backup de Fase 0. No hay fix manual fila por fila
  que valga el riesgo.
- **Nunca** quitar `DB_ENCRYPTION_KEY_OLD` antes de que la verificación de
  Fase 2 dé 100% — sin ella, cualquier fila no barrida queda ilegible y el
  tenant deja de responder (`tenant.middleware.ts` no puede resolver `req.db`).

---

## 6. IV de 16 bytes (deuda menor, no bloquea la rotación)

`encryptConnectionString` usa `randomBytes(16)`; el canónico para GCM es 12.
No es explotable a este volumen (Node acepta IV de 16 en GCM; el costo es el
límite de cumpleaños, irrelevante acá). **Si se abre `tenant-db.setup.ts` para
el código de dos claves**, cambiar a `randomBytes(12)` **solo para escrituras
nuevas** — `decryptConnectionString` ya toma el largo del IV del `ivHex`
guardado, así que los ciphertext viejos con IV de 16 siguen descifrando. El
barrido de Fase 2 migra todo a IV de 12 de paso.

---

## 7. Lo que falta construir (decisión de prioridad del dueño — no hay incidente)

1. **Modo dos claves en `deriveEncryptionKey()`** — `decryptConnectionString`
   prueba `DB_ENCRYPTION_KEY` y, si el `authTag` no valida, `DB_ENCRYPTION_KEY_OLD`.
   `encryptConnectionString` siempre usa la primaria. Cambio de código, con su
   propio gate (`architecture-governor`). Tocar también `tenant-db.setup.test.ts`.
2. **Script `src/scripts/reencrypt-secrets.ts`** — el barrido de Fase 2, con la
   forma de `migrate-tenants.ts` (itera `platformRepo.listAll()` filtrado por
   `dbUrlEncrypted`, abre cada tenant DB, resumen + `exit(1)`).
3. (Opcional, de paso con 1) IV 16→12 para escrituras nuevas.

Mientras 1 y 2 no existan, una rotación de emergencia es: app en
mantenimiento, script one-shot escrito en el momento que hace Fase 2 con las
dos claves pasadas por env explícitas, verificación, y recién ahí levantar. El
resto de este runbook (familias de columnas, orden de fases, verificación,
rollback) aplica igual.
