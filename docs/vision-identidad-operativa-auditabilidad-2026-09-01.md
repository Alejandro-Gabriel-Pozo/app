# Visión — identidad operativa, numeración y auditabilidad de largo plazo

- **Fecha:** 2026-09-01
- **Estado:** **visión de producto. HOLD de implementación — sin forzante real todavía.** No modifica D6, no crea tablas, no cambia contratos, no hay commit de código asociado a este documento.
- **Origen:** surgió durante la revisión de diseño del bloque de pantallas de D6 (números de reserva/cliente con prefijos). El dueño planteó que los dos campos de `business_profile` (`reservationNumberPrefix`/`customerNumberPrefix`) son la primera manifestación visible de una necesidad más amplia — identidad, historial y trazabilidad para todo hecho de negocio, no solo reservas y clientes.
- **Alcance:** **transversal a los dos repos** (`app-main` + `appfrontend-main`), igual que `indice-conocimiento.md`. Vive en `app-main/docs/` por convención de dónde se archivan los `diseno-*`/`vision-*`, no porque sea una especificación exclusiva del backend — cualquier decisión futura de identidad operativa toca serialización backend Y presentación frontend por igual.
- **Etiquetas:** `vision` `identidad` `numeracion` `auditoria` `ledger` `hold` `transversal`

---

## 0. Por qué este documento existe y por qué está en HOLD

Este proyecto ya tiene un precedente directo: `diseno-fiscal-profile-resolver-2026-09-01.md` diseñó `FiscalProfile`/`ComprobanteTypeResolver` en detalle y quedó **explícitamente en HOLD** — no porque la idea fuera mala, sino porque construir la abstracción rica antes de tener el certificado ARCA real habría sido diseñar contra un problema hipotético.

Este documento aplica el mismo criterio a una superficie mucho más grande: identidad de entidades, numeración operativa multi-ámbito, y un ledger inmutable para cuentas corrientes. **No hay hoy una segunda compañía legal, una sucursal, un caso de reasignación de número, ni una disputa de saldo que exija reconstrucción histórica.** Diseñar el modelo completo ahora — `NumberingPolicy` versionada, cinco tipos de identidad, ledger append-only, segregación de funciones — sería repetir el error que el HOLD fiscal existe para evitar, en una superficie más ambiciosa.

**Lo que este documento SÍ hace:** dejar escritos los principios para que no se pierdan y para que futuras decisiones puntuales (¿agrego este campo así, o dejo lugar para lo que viene?) tengan con qué contrastarse. **Lo que NO hace:** autorizar ni bloquear ninguna implementación concreta.

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

## 2. Qué NO cambia por este documento

- **D6 sigue implementándose tal como está diseñado**: `reservationNumberPrefix`/`customerNumberPrefix` como dos columnas `string` en `business_profile`, un helper puro de formateo, sin ámbito organizacional, sin versionado de política. Es la Fase 1 correcta y suficiente para el problema real de hoy (un tenant, un prefijo).
- **Cuentas corrientes sigue siendo saldo editable**, no ledger inmutable. Migrarlo es un cambio de modelo de datos de alto riesgo que no tiene ningún forzante hoy.
- **Los bugs del dashboard** (ID falso vía UUID, shadow-type `resource_id`) siguen como commits separados y acotados — se registran acá como *instancias del mismo principio* ("no inventar identidad desde el UUID"), no se resuelven acá.
- **No se crea `NumberingPolicy`, `OperationalIdentity` ni ningún catálogo nuevo.** Son conceptos para cuando exista el forzante.

## 3. Qué SÍ debería disparar volver a este documento

- Una segunda compañía legal o sucursal dentro del mismo tenant que necesite su propia secuencia.
- Una integración externa (banco, marketplace, PMS de terceros) que exija mapear el ID operativo contra un identificador ajeno de forma estable.
- Un caso real de disputa de saldo que requiera reconstruir el estado de una cuenta corriente en una fecha pasada.
- Una corrección de numeración (renombrar prefijo, resecuenciar) que rompa la lectura de un documento histórico ya emitido.
- Multimoneda operativa real (hoy `currency: string` es un solo valor por negocio en `BusinessContext`) — habilitar más de una moneda operando a la vez reabre la pregunta de ámbito de la secuencia y de conversión histórica.
- Que el subdominio fiscal salga de HOLD (certificado ARCA obtenido) — en ese momento, ID documental/legal y numeración operativa fiscal necesitan diseñarse juntos, no por separado.

Hasta que aparezca alguno de estos, este documento queda como referencia de principios — no como pendiente activo.

---

## 4. Relación con el resto del corpus

- No reemplaza ni contradice `diseno-fiscal-profile-resolver-2026-09-01.md` (HOLD fiscal) — es un HOLD hermano, con el mismo criterio epistémico: no diseñar la abstracción rica antes del forzante real.
- No es parte de `docs/pendientes-*.md` — no es un hallazgo de sesión con ancla verificable, es un principio de producto sin fecha de entrega.
- Si en el futuro se decide encarar alguno de los disparadores de la sección 3, esa sesión debe anotarlo en el `pendientes-<fecha>.md` correspondiente con una referencia a este documento (no copiar el detalle), mismo criterio que ya rige para el roadmap por rubro.
