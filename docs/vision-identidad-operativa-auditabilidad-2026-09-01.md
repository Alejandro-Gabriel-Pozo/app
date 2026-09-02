# Visión — identidad operativa, numeración y auditabilidad de largo plazo

- **Fecha:** 2026-09-01
- **Estado:** **HOLD LEVANTADO (01/09/2026, misma sesión, más tarde).** Decisión explícita del dueño: para un ERP, la identidad operativa completa, la auditoría del ledger y la trazabilidad **son lo fundamental, no una ambición a posponer** — "la sobreingeniería es bienvenida acá; como mínimo viable, esto espera demasiado". El criterio de "no diseñar sin forzante real" que motivó el HOLD original (§0, sin editar más abajo, queda como registro histórico de por qué se frenó) queda reemplazado: el forzante es que el producto se llama y se vende como ERP, y estas capacidades son tabla-stakes de esa categoría, no features condicionadas a un incidente futuro. Ver §5 (nueva) para el alcance real destrabado.
- **Origen:** surgió durante la revisión de diseño del bloque de pantallas de D6 (números de reserva/cliente con prefijos). El dueño planteó que los dos campos de `business_profile` (`reservationNumberPrefix`/`customerNumberPrefix`) son la primera manifestación visible de una necesidad más amplia — identidad, historial y trazabilidad para todo hecho de negocio, no solo reservas y clientes.
- **Alcance:** **transversal a los dos repos** (`app-main` + `appfrontend-main`), igual que `indice-conocimiento.md`. Vive en `app-main/docs/` por convención de dónde se archivan los `diseno-*`/`vision-*`, no porque sea una especificación exclusiva del backend — cualquier decisión futura de identidad operativa toca serialización backend Y presentación frontend por igual.
- **Etiquetas:** `vision` `identidad` `numeracion` `auditoria` `ledger` `hold-levantado` `transversal`

---

## 0. Por qué existió el HOLD — **registro histórico, superado por §5**

*(Sección original, sin editar más que este subtítulo, para que quede constancia del razonamiento que motivó el HOLD antes del 01/09 más tarde. No es el estado actual — ver §5.)*

Este proyecto ya tenía un precedente directo: `diseno-fiscal-profile-resolver-2026-09-01.md` diseñó `FiscalProfile`/`ComprobanteTypeResolver` en detalle y quedó **explícitamente en HOLD** — no porque la idea fuera mala, sino porque construir la abstracción rica antes de tener el certificado ARCA real habría sido diseñar contra un problema hipotético.

Este documento aplicaba el mismo criterio a una superficie mucho más grande: identidad de entidades, numeración operativa multi-ámbito, y un ledger inmutable para cuentas corrientes. **No había una segunda compañía legal, una sucursal, un caso de reasignación de número, ni una disputa de saldo que exigiera reconstrucción histórica.** Diseñar el modelo completo antes de eso — `NumberingPolicy` versionada, cinco tipos de identidad, ledger append-only, segregación de funciones — habría repetido el error que el HOLD fiscal existía para evitar, en una superficie más ambiciosa.

**Lo que este documento hacía mientras estuvo en HOLD:** dejar escritos los principios para que no se perdieran y para que futuras decisiones puntuales (¿agrego este campo así, o dejo lugar para lo que viene?) tuvieran con qué contrastarse. **Lo que no hacía:** autorizar ni bloquear ninguna implementación concreta.

---

## 1. Los principios, tal como se plantearon

**Identidad operativa.** Un número de reserva o cliente no es un string de presentación: es una identidad de negocio gobernada por una política de numeración, independiente de la interfaz, del idioma, del tenant y del formato visual. El prefijo (`RES`, `CLI`) es una representación localizada de esa identidad, no la identidad en sí.

**Cinco tipos de identidad, hoy mezclados en uno:**

| Tipo | Propósito |
|---|---|
| ID técnico (UUID) | Relacionar datos internamente; nunca se modifica; nunca se muestra como identidad humana |
| ID operativo | Identificar humanamente una reserva, cliente, cuenta o movimiento |
| ID documental/legal | Identificar comprobantes con valor legal o fiscal (converge con el HOLD fiscal) |
| ID externo | Vincular la entidad con bancos, ARCA, PMS, POS, marketplaces |
| ID de evento/auditoría | Reconstruir quién hizo qué, cuándo, desde dónde y por qué |

**Regla de oro para hechos de negocio:** nada se elimina silenciosamente, nada se actualiza sin historial, ningún saldo se corrige sin un movimiento compensatorio trazable. Cuentas corrientes en particular debería tender a modelarse como libro de movimientos inmutables con saldo derivado, no como saldo editable — hoy no lo es, y este documento no ordena migrarlo.

**Ejes de gobierno para una política de numeración futura:** ámbito de unicidad (tenant/compañía/sucursal/ejercicio/tipo de documento), formato versionado (prefijo, padding, separador, reinicio), inmutabilidad del número ya asignado incluso si cambia la configuración, localización de la presentación sin alterar la identidad histórica, concurrencia/idempotencia en la asignación, y separación explícita entre numeración fiscal y numeración operativa.

**Regla para el dashboard, ya accionable como principio aunque no como código:** toda entidad visible para una persona debe tener una política explícita de identificación humana; si no existe, la interfaz debe declararlo, nunca inventar una identidad a partir del UUID. Esto es lo que explica —no lo que resuelve— el bug ya encontrado en `dashboard/page.tsx:110` (últimos 4 caracteres de un UUID mostrados como "ID").

---

## 2. Qué NO cambiaba por este documento — **registro histórico, superado por §5**

*(Sección original, sin editar, para que quede constancia de qué se pensaba antes del 01/09 más tarde. No es el estado actual — ver §5.)*

- **D6 sigue implementándose tal como está diseñado**: `reservationNumberPrefix`/`customerNumberPrefix` como dos columnas `string` en `business_profile`, un helper puro de formateo, sin ámbito organizacional, sin versionado de política. Es la Fase 1 correcta y suficiente para el problema real de hoy (un tenant, un prefijo).
- **Cuentas corrientes sigue siendo saldo editable**, no ledger inmutable. Migrarlo es un cambio de modelo de datos de alto riesgo que no tiene ningún forzante hoy.
- **Los bugs del dashboard** (ID falso vía UUID, shadow-type `resource_id`) siguen como commits separados y acotados — se registran acá como *instancias del mismo principio* ("no inventar identidad desde el UUID"), no se resuelven acá.
- **No se crea `NumberingPolicy`, `OperationalIdentity` ni ningún catálogo nuevo.** Son conceptos para cuando exista el forzante.

## 3. Qué SÍ debería disparar volver a este documento — **registro histórico, superado por §5**

*(Igual que §2: la lista de forzantes hipotéticos ya no es el criterio de entrada. Se deja para que quede trazado el razonamiento original.)*

- Una segunda compañía legal o sucursal dentro del mismo tenant que necesite su propia secuencia.
- Una integración externa (banco, marketplace, PMS de terceros) que exija mapear el ID operativo contra un identificador ajeno de forma estable.
- Un caso real de disputa de saldo que requiera reconstruir el estado de una cuenta corriente en una fecha pasada.
- Una corrección de numeración (renombrar prefijo, resecuenciar) que rompa la lectura de un documento histórico ya emitido.
- Multimoneda operativa real (hoy `currency: string` es un solo valor por negocio en `BusinessContext`) — habilitar más de una moneda operando a la vez reabre la pregunta de ámbito de la secuencia y de conversión histórica.
- Que el subdominio fiscal salga de HOLD (certificado ARCA obtenido) — en ese momento, ID documental/legal y numeración operativa fiscal necesitan diseñarse juntos, no por separado.

---

## 4. Relación con el resto del corpus

- Ya no es un "HOLD hermano" de `diseno-fiscal-profile-resolver-2026-09-01.md` — ese documento también salió de HOLD el mismo día (ver su propio encabezado). Siguen relacionados: la identidad documental/legal (§1, tabla de 5 tipos) converge con el resolver fiscal cuando ese lado se diseñe en detalle.
- Si se encara alguno de los bloques de §5, esa sesión debe anotarlo en el `pendientes-<fecha>.md` correspondiente con una referencia a este documento (no copiar el detalle), mismo criterio que ya rige para el roadmap por rubro.

---

## 5. Estado real después de levantar el HOLD (01/09/2026)

**Decisión del dueño, con su propio razonamiento:** "la sobreingeniería es bienvenida -> es un ERP -> y como mínimo viable eso espera mucho -> hay cosas que son lo fundamental y no están". Después, al preguntarle explícitamente si esto también sacaba del HOLD a este documento y al fiscal: **"Los dos HOLD también salen, con forzante ya identificado"**.

**Lo que esto destraba, concretamente:**
- Diseñar `NumberingPolicy` y `OperationalIdentity` como modelo real — ámbito de unicidad, versionado, los 5 tipos de identidad de §1 — ya no está prohibido por "sin forzante". El forzante es la categoría de producto (ERP) en sí.
- Migrar cuentas corrientes de saldo-implícito a ledger con auditoría completa — `[P]` en diseño activo como Bloques D (reversión gobernada) + A (atribución y auditoría), a partir de un hallazgo de una auditoría de pagos en curso (no hay forma de corregir un pago mal cargado). El detalle de schema (nombres de columna, severidad relativa) vive en material de auditoría todavía no versionado (`docs/erp-auditoria-v2/`) — no se cita acá como hecho cerrado.
- El resto de §3 (multiempresa real, multimoneda, ID externo) deja de necesitar un incidente disparador — se diseñan cuando les toque el orden de prioridad, no cuando "pase algo".

**Lo que NO cambia, porque no es una cuestión de ambición sino de hecho externo:**
- La hipótesis abierta sobre `getIvaReceptorTypes()` (ver `diseno-fiscal-profile-resolver-2026-09-01.md` §0) sigue sin poder confirmarse sin un certificado ARCA real o validación profesional. Se puede diseñar el resolver para funcionar sin esa hipótesis y mejorar si se confirma — eso ya estaba en el diseño original — pero la hipótesis en sí no se resuelve por decisión de producto.
- Todo lo que siga dependiendo de un dato de producción no medido (ej. cuántos tenants reales existen más allá de `biz-demo-01`) sigue necesitando esa medición, ambición aparte.

**Próximo paso:** un programa de auditoría de completitud end-to-end (por módulo y flujo, con disciplina `[V]`/`[P]`/`[H]`) que reemplaza el enfoque archivo-por-archivo para el resto del ERP. Su documento de método concreto todavía está en revisión y sin versionar — no se cita acá por nombre de archivo ni número de versión para no atarse a un estado que puede cambiar antes de commitearse.

**Este levantamiento retira una prohibición de diseño; no autoriza ningún commit, migración ni cambio de schema.** Cada bloque —`NumberingPolicy`, `OperationalIdentity`, la migración del ledger, o cualquier otro— sigue necesitando su propia revisión y su propia autorización explícita antes de tocar código.
