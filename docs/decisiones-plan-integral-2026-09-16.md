# Decisiones del dueño — 25 preguntas del plan integral (16/09/2026)

**Fecha:** 2026-09-16
**Origen:** las 25 preguntas de `docs/plan-integral-sistemico-2026-09-16.md` §4.1 (16, de la auditoría de 16 fases, `P-01`..`P-16` → `D-01`..`D-25`) y §4.2 (9, de `pendientes-2026-09-12.md`), informadas por `docs/grounding-25-preguntas-2026-09-16.md` (research contra Cloudbeds, Odoo, ERPNext, QloApps, Dolibarr, OPERA Cloud, ARCA/AFIP) y las correcciones de su Apéndice A.

**Método:** cada decisión se tomó con `AskUserQuestion`, presentando el grounding disponible sin decidir por el dueño. Este documento **registra** la decisión ya tomada — no la argumenta de nuevo; el razonamiento completo vive en el grounding y en los documentos de fase citados. Formato por decisión: Contexto (una línea, con ancla), Decisión, Alternativas descartadas, Gatillo de revisión (qué haría reabrir esto).

**Convención de asignación de ID:** las 25 preguntas ya tienen ID en sus documentos de origen (`P-XX`/`D-XX` de Fase 15/16, o el ID en mayúsculas de `pendientes`). Este documento no acuña IDs nuevos — cita el ID existente y su documento, siguiendo la regla de desambiguación que `plan-integral-sistemico-2026-09-16.md` §1 ya estableció para el caso `D-14`.

**24 de 25 decididas. `P-05` queda explícitamente sin decidir** — no es una pregunta de opción múltiple, depende de una consulta de diagnóstico de solo lectura contra cada tenant que todavía no se corrió (ver cierre del documento).

---

## Tabla resumen

| ID | Pregunta | Decisión |
|---|---|---|
| P-16 (D-25) | Resolver fiscal desconectado | Desbloquear, dirigido por **perfil del cliente** capturado (Consumidor Final / empresa / monotributista / fundación), no un default ciego |
| P-15 (D-24) | Circuito de Caja sin UI | Completar la UI |
| 4.3 (pendientes) | Reserva por tipo de unidad | Sí, planificar la migración del modelo |
| `locations` vs `companies` (pendientes) | Modelo de sucursal | Mantener `locations` como eje físico separado, no fusionar |
| P-01 (D-03) | Token CUSTOMER en rutas de staff | Rechazar el token en rutas de staff + extender la cerca RBAC por actor |
| P-03 (D-05) | Vínculo a empresa por UUID | Solicitud + aprobación en dos pasos |
| `CANCEL-POLICY-SCOPE-BASE-001` (pendientes) | Política de cancelación en reservas viejas | Snapshot al crear + default/manual para lo anterior al campo |
| `credit_note_request` (pendientes) | NC con emisión ambigua | Investigar `FECompConsultar` primero, diseñar la bandeja después |
| `CANCEL-WITH-NC-UI-001` (pendientes) | Advertencia de deuda en toast de 4s | Banner persistente + modal de confirmación |
| P-02 (D-04) | Tope de vida absoluta de sesión | Solo idle timeout, sin tope absoluto |
| P-07 (D-10) | `idempotencyKey` obligatoria | Estado del documento + aviso de duplicado (no clave obligatoria) |
| P-10 (D-19) | PDF síncrono en camino interactivo | Materializar una vez y servir el archivo |
| Penalidad reembolso parcial (pendientes) | Eje de configuración | Por política/tarifa con escala de antelación (no por rubro directo) |
| P-14 (D-23) | 35 endpoints sin consumidor | Artefacto de consumo primero, priorizar completar después — **cero borrados** hasta entonces |
| `ORDER-CONSOLIDATED-PARTIAL-01` 1d (pendientes) | Consumos parciales de cuenta abierta | Diseñar con trazabilidad línea→documento de origen |
| Hueco doble comprobante (pendientes) | Liberar cargo tras rechazo AFIP | Clasificar el error primero; automático solo si es transitorio |
| P-04 (D-06) | `DATABASE_URL` trampa armada | Retirar el endpoint `repair-tenant-db` |
| P-05 (D-07) | Tarifas convertidas por backfill | **Sin decidir** — requiere la consulta de diagnóstico primero |
| P-06 (D-09) | Atajo de deploy vs. validar fuente real | Validar contra la fuente real (deploy más lento), después de resolver D-08 |
| P-08 (D-12) | Sweep de recuperación del outbox | Implementar el sweep completo ahora (no solo el mitigante) |
| P-09 (D-13) | Build depende de var no declarada | `npm install --include=dev` |
| P-11 (D-15) | 3 literales de config | Ver desglose abajo — 1 por tenant, 1 por plan, 1 constante |
| P-12 (D-18) | Workers en polling fijo, HOLD | Desbloquear la decisión de dirección del bus `wake()` ahora |
| P-13 (D-22) | Tests en PG16, prod en PG17/18 | Unificar plataforma y tenants a una sola versión de PG |
| `CUSTOMER-EMAIL-REQUIRED-001` (pendientes) | Bypass de API para email | Cerrar el bypass |

---

## A. Seguridad

### P-01 (D-03) — Token CUSTOMER alcanza 4 rutas mutantes de staff

- **Contexto:** `CUSTOMER_PERMISSION_GROUPS` satisface `Roles.BOOKING`, alcanzando `reservations.routes.ts:363/676` y `orders.routes.ts:200/386` sin guard de pertenencia. `pendientes-2026-09-12.md` ya reprodujo que hoy las 4 rutas mueren en un 500 accidental (no diseñado), no en una protección real.
- **Decisión:** rechazar tokens CUSTOMER en rutas de staff (opción "a" de Fase 15) **y** extender la cerca por actor (molde `ESCAPE_ROUTES` de `credit-note-escape-containment.test.ts`) — las dos capas, no una sola.
- **Alternativas descartadas:** (b) guard de pertenencia solo en las 4 rutas (más frágil, protege ruta por ruta); (c) partir `BOOKING` en dos grupos (mayor alcance, toca `ROLES-CATALOG-DRIFT-001` y 3 catálogos del frontend).
- **Gatillo de revisión:** si al implementar (a) se descubre que alguna pantalla del portal depende hoy de una de esas 4 rutas (riesgo que Fase 15 ya señaló para esta opción).

### P-03 (D-05) — Vínculo a empresa conociendo su UUID

- **Contexto:** `POST /api/companies/link` solo verifica que la empresa exista; el `CompanyCatalogPropagationWorker` propaga catálogo entero tras vincular, sin consentimiento del lado receptor.
- **Decisión:** solicitud + aprobación en dos pasos (opción B de Fase 15).
- **Alternativas descartadas:** (A) token de un solo uso — más simple pero sigue siendo iniciativa unilateral del lado que se suma, no acto deliberado del receptor (el grounding lo señaló como la forma más débil de las dos).
- **Gatillo de revisión:** ninguno previsto — es la opción de mayor alcance de las dos, decidida con esa consecuencia asumida.
- **Nota abierta, no decidida acá:** el grounding señaló que vincular no debería otorgar visibilidad automática de datos entre sucursales — verificar si hoy el vínculo ya la otorga, es una pregunta aparte.

### P-04 (D-06) — `DATABASE_URL`: trampa armada en `repair-tenant-db`

- **Contexto:** el endpoint está muerto (500 `MISSING_DATABASE_URL`) pero, si alguien completa la variable con la URL de plataforma, aplicaría el schema de tenant sobre la BD central.
- **Decisión:** retirar el endpoint.
- **Alternativas descartadas:** renombrar la variable + guarda contra `PLATFORM_DATABASE_URL` — se descartó porque `set-tenant-url` ya cubre la misma capacidad con la URL explícita en el body, y retirar es de menor radio.
- **Gatillo de revisión:** si algún runbook no inventariado cita este endpoint como herramienta de recuperación — verificar antes de retirar.

---

## B. Integridad de datos y de dinero

### P-05 (D-07) — Backfill de `customer_rates` puede haber convertido tarifas fijas en porcentuales

- **Estado: sin decidir.** No es pregunta de opción múltiple — depende de la consulta de diagnóstico de solo lectura de F10-02 contra cada tenant (cuántas filas candidatas existen). Ese dato define si la severidad real es Crítica o Alta, y qué hacer con las filas ya convertidas es decisión de negocio posterior a tener el número.
- **Bloqueado por:** la consulta todavía no se corrió (el dueño declinó correrla en esta sesión contra `ancient-king-17098519` sin especificar cuál de las consultas pendientes correr).
- **Siguiente paso:** cuando se autorice, correr `SELECT` de diagnóstico de F10-02 contra plataforma y cada tenant, y recién ahí volver a esta decisión.

### P-06 (D-09) — `migrate-tenants` salta tenants por versión cacheada en plataforma

- **Contexto:** `businesses.schema_version` (plataforma) se trata como autoridad cuando la fuente real es `schema_migrations` dentro de cada tenant; un tenant puede quedar sin migrar en silencio (ya ocurrió una variante con `served_at`).
- **Decisión:** dejar de saltar por la versión cacheada y validar contra la fuente real (opción a de Fase 15).
- **Alternativas descartadas:** mantener el salto validándolo contra `schema_migrations` (requiere conexión igual, elimina el ahorro sin ganar nada).
- **Precondición no negociable:** el propio Fase 15/16 fija que esto **no se implementa antes de D-08** (extender el guard `pg_constraint`) — sin eso, cada deploy pasa a costar ~50s × tenant en vez de ~96ms.
- **Gatillo de revisión:** ninguno — la decisión ya asume el costo de deploy más lento a cambio de eliminar la deriva silenciosa.

### P-07 (D-10) — `idempotencyKey` del pago, ¿obligatoria?

- **Contexto:** el grounding partió la respuesta por capa — máquina que reintenta (integración) usa clave; cajero humano que reintenta tras timeout, ningún ERP de referencia usa clave, usan estado del documento + aviso de duplicado.
- **Decisión:** estado del documento + aviso de duplicado (patrón ERP para el caso real hoy: cajero humano). La clave existente sigue ahí, pero no es la protección principal.
- **Alternativas descartadas:** clave obligatoria ya (opción c de Fase 15) — se pospone hasta que exista una integración real que reintente como máquina; hacerla obligatoria hoy rompería cualquier cliente que no la mande sin necesidad.
- **Gatillo de revisión:** el día que se abra una integración de pagos externa (pasarela, app de terceros) que reintente automáticamente — ahí la capa de máquina exige la clave obligatoria.

### P-08 (D-12) — Sweep de recuperación del outbox

- **Contexto:** un crash entre el claim y el fin del handler puede saltear un efecto financiero (ej. un CHARGE que nunca se crea) sin dead-letter ni `warn` visible.
- **Decisión:** implementar el sweep completo ahora, no solo el mitigante de subir el log.
- **Alternativas descartadas:** solo el mitigante (subir el skip a `warn` cuando `retry_count > 0`) como paso intermedio — se descartó como *solución*, aunque puede seguir siendo un paso previo útil de visibilidad mientras se diseña el sweep.
- **Precondición:** la matriz de impacto que puso esto en HOLD estaba incompleta — completarla (distinguir "sin efecto" de "efecto legítimamente nulo") es parte del bloque, no un paso opcional.
- **Gatillo de revisión:** si el sweep mal calibrado empieza a re-ejecutar efectos que sí ocurrieron (el modo de falla opuesto) — recalibrar antes de generalizar.

### `CANCEL-POLICY-SCOPE-BASE-001` Bloque 2 (pendientes) — política de cancelación en reservas anteriores al campo

- **Contexto:** al agregar el campo de política de cancelación, las reservas creadas antes de que existiera quedan sin snapshot.
- **Decisión:** snapshot al crear (para lo nuevo) + resolución manual/default explícito para lo que quedó sin snapshot (la tercera opción, la que usa la industria — ni regla viva ni rechazo).
- **Alternativas descartadas:** regla viva (aplicar la política vigente al cancelar, ningún referente lo hace); rechazar el cálculo siempre que falte snapshot (ningún referente bloquea así).
- **Gatillo de revisión:** ninguno — coincide además con el precedente que el propio repo ya fijó en `CN-ESCAPE-ORPHAN-ADJUSTMENT-001`.

### `credit_note_request` LA TABLA (pendientes) — NC con emisión fiscal ambigua

- **Contexto:** sigue en HOLD; el timeout de WSFEv1 deja ambigüedad real sobre si una NC se emitió o no.
- **Decisión:** investigar cuánta ambigüedad resuelve `FECompConsultar` (consulta directa a AFIP) antes de diseñar la bandeja de reconciliación manual — puede simplificar mucho el diseño si resuelve la mayoría de los casos automáticamente.
- **Alternativas descartadas:** levantar el HOLD ya y diseñar la bandeja completa sin esa investigación previa; mantener en HOLD sin avanzar en nada.
- **Siguiente paso concreto:** investigar el contrato de `FECompConsultar` contra el SDK de AFIP (`@arcasdk/core`) que ya usa este repo, antes de retomar el diseño de la tabla.
- **Gatillo de revisión:** cuando se tenga la medición de cuánto resuelve la consulta automática.

### `ORDER-CONSOLIDATED-PARTIAL-01` bloque 1d (pendientes) — consumos parciales de cuenta abierta

- **Contexto:** F&B a la habitación y casos similares de consolidación necesitan resolver devoluciones/reembolsos parciales sobre una factura consolidada.
- **Decisión:** diseñar con trazabilidad línea→documento de origen como eje central (patrón Cloudbeds — split folio a nivel de línea; lección del bug real que ERPNext tuvo que parchear por no tenerlo).
- **Alternativas descartadas:** mantener el enfoque de diseño previo sin ese eje explícito.
- **Gatillo de revisión:** ninguno — el modelo exacto de consolidación sigue siendo diseño propio, esto solo fija el eje.

### Hueco doble comprobante (pendientes) — ¿liberar cargo tras rechazo AFIP?

- **Contexto:** si AFIP rechaza la emisión, hoy no está definido si el cargo original se libera automáticamente para re-facturar.
- **Decisión:** clasificar el tipo de error primero (transitorio vs. validación); automático solo para el transitorio, manual siempre para rechazo por validación.
- **Alternativas descartadas:** liberar siempre manual sin clasificar (más simple pero pierde la mejora para el caso transitorio).
- **Precondición:** confirmar si el código hoy puede distinguir esas dos clases de error — si no puede, ese es el primer bloque, antes de tocar la política de liberación.
- **Gatillo de revisión:** ninguno — la política queda fijada, condicionada a que exista la clasificación de error.

---

## C. Arquitectura y configuración

### P-06 — ver sección B (agrupado con D-09 por ser la misma decisión).

### P-09 (D-13) — Build depende de que `NODE_ENV=production` no llegue a `npm install`

- **Contexto:** dos pasos del build (`patch-package`, `migrate:tenants` vía `tsx`) dependen de devDependencies que `npm install` con `NODE_ENV=production` borraría.
- **Decisión:** `npm install --include=dev` en el `buildCommand`.
- **Alternativas descartadas:** mover `tsx`/`patch-package` a `dependencies` (honesto pero aumenta el tamaño de runtime); correr `migrate:tenants` compilado desde `dist/` (mayor alcance, reordena el build).
- **Gatillo de revisión:** ninguno — es la opción correcta en las dos ramas posibles según la propia auditoría (F11-01).

### P-11 (D-15) — 3 literales de configuración, ¿por tenant o constantes de producto?

Tres sub-decisiones, cada una con su propio criterio:

- **`PASSWORD_RESET_EXPIRES_HOURS` → constante fija de producto, ventana corta.** Alinea con el estándar de seguridad (vida corta, no configurable por tenant — ningún referente de seguridad recomienda hacerlo configurable).
- **Tope de paginación → ligado a `PLAN_LIMITS` (por plan, no por tenant suelto).** Mismo patrón que el repo ya resolvió el 18/08/2026 para otros límites — no crea un mecanismo nuevo.
- **`OUTBOX_RETENTION_DAYS` → constante fija de producto.** Decisión operativa (costo de storage vs. necesidad de auditoría/replay), sin precedente externo que la empuje a ser por tenant.
- **Gatillo de revisión:** si en el futuro un tenant específico necesita una retención de outbox distinta por requisito de auditoría propio — reabrir esa única sub-decisión, no las tres.

### P-12 (D-18) — Workers en polling fijo, HOLD sobre la dirección del bus `wake()`

- **Contexto:** `OutboxWorker` y `reservation-hold-expiry.worker` no se apagan por inactividad; ya causaron un incidente real de consumo de compute en Neon (10/09/2026, plan free).
- **Decisión:** desbloquear la decisión de dirección del bus `wake()` ahora (§3.3 de `docs/diseno-polling-adaptativo-neon-2026-09-10.md`), en vez de mantenerlo en HOLD.
- **Alternativas descartadas:** mantener en HOLD (el incidente visible ya se mitigó con billing activado, pero la causa sigue sin resolver — se decidió no dejarlo así).
- **Siguiente paso concreto:** releer `docs/diseno-polling-adaptativo-neon-2026-09-10.md` §3.2/§3.3 completo (las opciones ya están enumeradas ahí, no hay que diseñar de cero) y tomar la decisión puntual de dirección del bus.
- **Gatillo de revisión:** no aplica — esto es el siguiente bloque de trabajo, no una decisión final todavía.

### P-13 (D-22) — Tests en PG16, producción en PG17 (tenants) / PG18 (plataforma)

- **Contexto:** la única versión de Postgres que se ejercita automáticamente en CI no corre en ningún entorno real.
- **Decisión:** unificar plataforma y tenants a una sola versión de PostgreSQL (el cambio de mayor alcance de las tres opciones).
- **Alternativas descartadas:** solo alinear el CI a la versión real de los tenants sin unificar plataforma/tenants entre sí; adoptar únicamente el runbook de pre-chequeo sin tocar versiones.
- **Nota:** el runbook de pre-chequeo (`SELECT upper(btrim(name)), count(*) FROM resources ... HAVING count(*) > 1` y similares, antes de cualquier constraint nueva) sigue siendo válido como práctica independiente de esta decisión — no quedó descartado, quedó fuera del alcance de esta pregunta puntual.
- **Gatillo de revisión:** al planificar el bloque, confirmar costo/tiempo de migrar el entorno de CI y cualquier entorno de desarrollo a la versión unificada.

---

## D. Rendimiento

### P-10 (D-19) — PDF de comprobantes síncrono en el camino interactivo

- **Contexto:** cada PDF lanza un Chromium entero (~21s en frío); el usuario espera en el camino interactivo.
- **Decisión:** materializar el PDF una vez tras generarlo y servir el archivo en pedidos posteriores (el comprobante es inmutable tras el CAE, así que no hay razón para re-renderizar).
- **Alternativas descartadas:** sacar la generación completa del camino interactivo (generar al emitir o vía outbox) — de mayor alcance, se pospone; dejarlo como está — descartado, el punto de mayor retorno según el grounding es justamente materializar y servir.
- **No opcional, independiente de esta decisión:** poner un timeout a la generación (D-19 ya lo marca como no negociable — hoy una `generate()` colgada cuelga la request para siempre).
- **Gatillo de revisión:** si el volumen de comprobantes concurrentes sigue generando presión de memoria pese a la materialización — ahí se revisita sacarlo del camino interactivo.

---

## E. Código muerto y superficie sin consumidor

### P-14 (D-23) — 35 endpoints sin consumidor conocido (15 familias)

- **Contexto:** el grounding (corregido por el gate) encontró que 11 de 15 familias son módulos que la industria no entrega sin pantalla, 1 es zona gris (`audit-log`), 3 son legítimamente backend-only. Pero Fase 16 ya fijó **cero borrados** hasta tener el artefacto de consumo verde en las dos direcciones — esta decisión no lo levanta.
- **Decisión:** construir primero el artefacto de consumo (test de arquitectura "inventario × consumidores", molde `CLOSURE_MOUNTS`/`PUBLIC_ROUTES`), y recién con eso verde, priorizar qué familias completar.
- **Alternativas descartadas:** priorizar completar ya las familias más urgentes sin esperar el artefacto — descartado porque sin el artefacto no se puede confirmar "sin consumidor en absoluto" (D-23 mide "sin consumidor en estos dos repos", con certeza media-baja para el caso general).
- **Excepción ya resuelta aparte:** Caja (P-15) ya se decidió completar, independientemente de este orden — no espera al artefacto de consumo porque no es una pregunta de "¿tiene consumidor?" sino de "¿existe la UI?".
- **Gatillo de revisión:** cuando el artefacto de consumo esté verde, volver familia por familia (13 restantes tras excluir Caja) y decidir completar/retirar cada una — con `locations` ya decidido aparte también.

---

## F. Producto — decisiones de mayor alcance

### P-16 (D-25) — Resolver fiscal desconectado, toda factura a Consumidor Final

- **Contexto:** ninguna factura llega hoy con CUIT/condición de IVA real del comprador, incluidas las de empresa (que sin CUIT no sirven como crédito fiscal). Posible fecha límite regulatoria (RG 5616/2024, fuente secundaria sin confirmar) desde 01/12/2026.
- **Decisión:** desbloquear el resolver fiscal, con diseño dirigido por el **perfil del cliente** — capturar si el cliente es Consumidor Final, empresa, monotributista, fundación, etc. (ya existe `/api/customers/:id/tax-profile` sin usar), y que el sistema derive automáticamente la condición de IVA / tipo de documento fiscal desde ese perfil, en vez de aplicar un default ciego a Consumidor Final.
- **Alternativas descartadas:** mantener en HOLD indefinido; desbloquear sin diseño de perfil (solo capturar CUIT ad-hoc en el momento de facturar, sin persistir la condición del cliente).
- **Independiente de la fecha regulatoria:** el caso de empresas sin CUIT ya justifica este trabajo por sí solo (Hecho 3 del grounding), sin depender de si la RG 5616 se confirma.
- **Siguiente paso concreto:** diseñar el modelo de "perfil fiscal del cliente" (qué campos, cómo se relaciona con `resolveDocTipo()` ya construido en `afip-catalog.constants.ts`) antes de tocar `invoice.service.ts`.
- **Gatillo de revisión:** confirmación (o descarte) de la fecha de la RG 5616/2024 con el contador — no cambia la decisión de desbloquear, pero sí la urgencia relativa dentro del plan de trabajo.

### P-15 (D-24) — Circuito de Caja sin UI

- **Contexto:** backend completo (router, servicio, 3 errores de dominio, tabla, `requireModule`), cero consumidores en frontend, sin fila propia en el roadmap.
- **Decisión:** completar — construir la UI faltante.
- **Alternativas descartadas:** retirar el circuito con un ADR — descartado, sin precedente de industria que lo respalde (4 de 4 referentes lo tienen, uno lo hace bloqueante).
- **No opcional, parte del mismo bloque:** crear la fila en `docs/roadmap-pms-multirubro.md` primero (decisión ya fijada en Fase 15, D-24) — sin eso la feature se pierde del radar otra vez.
- **Antes de cualquier movimiento:** `SELECT count(*) FROM cash_register_shifts` en cada tenant productivo — si hay filas, alguien ya lo usó por API.
- **Gatillo de revisión:** ninguno — decisión tomada con el precedente unánime del grounding.

### 4.3 (pendientes) — Reserva por tipo de unidad con asignación diferida

- **Contexto:** hoy solo se reserva una unidad física concreta; la industria hotelera vende por tipo y asigna la unidad después.
- **Decisión:** sí, planificar la migración del modelo de datos.
- **Alternativas descartadas:** no encarar por ahora (aceptar el costo creciente); esperar un análisis de costo de migración antes de comprometerse — se avanza directo a planificar.
- **Siguiente paso concreto:** este es un cambio que toca el núcleo de disponibilidad — antes de tocar código, corresponde un diseño propio (no solo una implementación), dado que afecta reservas, canales/OTAs futuros, y el cálculo de disponibilidad existente.
- **Gatillo de revisión:** ninguno — es la decisión con el respaldo más fuerte de las 25 preguntas; lo que queda abierto es el orden de trabajo, no el "si".

### `locations` vs `companies` (pendientes, Área 3.2) — modelo de sucursal

- **Contexto:** `locations` está estructuralmente inalcanzable en producción (sin `PUT`/`DELETE`, 0 en frontend, `afip_sales_point` único por negocio bloquea multi-sucursal real); el roadmap declara "Transferencia entre depósitos ✅ Resuelto" siendo inalcanzable en la práctica.
- **Decisión:** mantener `locations` como eje físico separado — no fusionar con `companies`. El par `companies` (organización matriz) + negocio/sucursal ya es el modelo de 2 niveles que usan los referentes; `locations` pertenece al eje físico/inventario (habitación, almacén), no al organizativo.
- **Alternativas descartadas:** fusionar `locations` con `companies` — descartado, iría contra el precedente unánime de los 3 referentes (Cloudbeds, OPERA, Odoo), que mantienen el eje organizativo y el eje físico separados a propósito.
- **Nota del grounding a tener presente al diseñar:** en Odoo la configuración no se hereda del padre (salvo contabilidad) — el nivel matriz agrupa y consolida, no configura por las sucursales. Aplicar el mismo criterio acá si corresponde.
- **Gatillo de revisión:** ninguno — decisión tomada alineada con el precedente unánime; lo que sigue es el diseño concreto de cómo `locations` se corrige (no si se fusiona).

### Penalidad retenida en reembolso parcial (pendientes)

- **Contexto:** el dueño había dicho "depende del rubro"; el grounding encontró que los referentes hoteleros la modelan por política/tarifa con escala de antelación, fijada al crear la reserva — un eje que contiene "por rubro" como caso particular.
- **Decisión:** modelar por política/tarifa con escala de antelación, no directamente por rubro.
- **Alternativas descartadas:** modelar directamente por rubro (eje original, más simple pero menos flexible — un spa y un hotel con políticas distintas ya resuelve el caso "por rubro" sin necesitar ese eje explícito).
- **Gatillo de revisión:** al diseñar la pantalla de políticas — si el eje por política/tarifa resulta insuficiente para algún caso real de este negocio, reabrir.

### `CANCEL-WITH-NC-UI-001` (pendientes) — advertencia de deuda en toast de 4 segundos

- **Contexto:** la advertencia de deuda de cuenta corriente de empresa antes de cancelar se muestra en un toast efímero; ningún referente comunica dinero así.
- **Decisión:** banner persistente + modal de confirmación — las dos cosas juntas.
- **Alternativas descartadas:** solo banner; solo modal; dejarlo como toast (ninguna tiene respaldo del grounding para el caso completo).
- **Gatillo de revisión:** ninguno.

### `CUSTOMER-EMAIL-REQUIRED-001` (pendientes) — bypass de API para email obligatorio

- **Contexto:** el dueño ya había decidido (sesión previa, `decisiones-auditoria-fase3-2026-09-15.md` §2) que el email es obligatorio sin excepción. Un bypass de API (`customers.routes.ts:625-637`) sigue permitiendo crear un cliente sin email real vía `contactMethods` explícito sin canal EMAIL. Sin caller conocido hoy.
- **Decisión:** cerrar el bypass — consistente con la decisión ya tomada, no la reabre.
- **Alternativas descartadas:** aceptarlo por ahora dado que no hay caller conocido — descartado, prevalece la decisión de fondo ya cerrada.
- **Gatillo de revisión:** ninguno.

---

## Cierre

De las 25 preguntas originales, **24 quedaron decididas** en esta sesión. La única sin decidir es **P-05 (D-07)**, que no es una decisión de opción múltiple: depende de correr la consulta de diagnóstico de solo lectura de F10-02 contra cada tenant para saber cuántas filas de `customer_rates` fueron candidatas del backfill sin guard de versión. Esa consulta todavía no se autorizó a correr en esta sesión (se identificó el proyecto real de Neon, `ancient-king-17098519` / DB-APP-PPMS, pero el dueño no confirmó qué consulta correr contra él).

**Siguientes pasos concretos que este documento deja planteados, sin decidir el orden de ejecución** (eso sigue siendo el §3 de `plan-integral-sistemico-2026-09-16.md`, no re-derivado acá):
1. Correr la consulta de diagnóstico de P-05/D-07 (y, si se autoriza en la misma sesión, las de D-09/D-22/D-24 que también están pendientes de dato real).
2. Diseñar el "perfil fiscal del cliente" para P-16/D-25.
3. Investigar `FECompConsultar` antes de retocar el diseño de `credit_note_request`.
4. Releer `docs/diseno-polling-adaptativo-neon-2026-09-10.md` §3.2/§3.3 para cerrar P-12/D-18.
5. Construir el artefacto de consumo (inventario × consumidores) antes de tocar cualquiera de las 15 familias de P-14/D-23 salvo Caja, ya decidida aparte.

Ninguna de estas decisiones autoriza commits, migraciones ni deploys por sí misma — cada bloque de implementación sigue el mismo proceso de gate (`architecture-governor`) y autorización explícita de push que el resto de esta sesión.

---

## Apéndice A — Correcciones del gate (`architecture-governor`, 16/09/2026)

Verificación independiente previa al commit, contra los archivos fuente
reales (`plan-integral-sistemico-2026-09-16.md` §4.1/§4.2 y su Apéndice A,
`grounding-25-preguntas-2026-09-16.md` y su Apéndice A,
`auditoria-integral-fase15-2026-09-16.md`,
`decisiones-auditoria-fase2-2026-09-15.md`,
`decisiones-auditoria-fase3-2026-09-15.md`,
`roadmap-pms-multirubro.md`) y contra el árbol de código de los dos repos.
El cuerpo del documento (líneas 1-267) **no se edita** — misma convención
que las Fases 12 a 16, que el plan integral y que el grounding. **Este
apéndice no cambia ninguna decisión del dueño:** corrige cómo están
citadas, agrega la que faltaba documentar y retira dos afirmaciones que no
resisten la verificación.

Lo que se verificó y quedó confirmado sin cambios: las **25 filas** de la
tabla resumen contra `plan-integral-sistemico-2026-09-16.md` §4.1/§4.2 (16
+ 9, ninguna perdida, ninguna de más, todos los pares `P-XX (D-XX)`
coincidentes con el mapeo de §4.1); la fidelidad de las 25 decisiones a su
pregunta original; las fichas de Fase 15 que el documento cita —`D-09`
(`fase15:268-297`, incluida la precondición textual *"con D-08 resuelta
primero"* y el contraste ~50 s × tenant vs. ~96 ms), `D-12`
(`fase15:353-385`, *"HOLD por matriz de impacto incompleta"* y el riesgo
*"distinguir 'sin efecto' de 'efecto legítimamente nulo'"*), `D-19`
(`fase15:570`, el timeout *"no opcional"*), `D-23` (`fase15:667`, certeza
**Alta** para "en estos dos repos" / **Media-baja** para "en absoluto"),
`D-24` (`fase15:703`, la fila de roadmap primero y el `SELECT count(*) FROM
cash_register_shifts`), `D-15` (`fase15:457`, los tres literales exactos y
el precedente `PLAN_LIMITS` del 18/08/2026)—; el ancla de
`CUSTOMER-EMAIL-REQUIRED-001` (`decisiones-auditoria-fase3-2026-09-15.md`
§2 dice, textual, *"email pasa a ser obligatorio, sin excepción — se
elimina el soporte de alta solo-teléfono desde `POST /customers`"*) y el
bypass todavía vivo en `customers.routes.ts:623-639`; la fila
`roadmap-pms-multirubro.md:237` (*"Transferencia entre depósitos ✅
Resuelto (17/08/2026)"*); y las anclas de código `resolveDocTipo()`
(`afip-catalog.constants.ts:106`), la tabla `cash_register_shifts`
(`schema.sql:2622`) y `repair-tenant-db`. De las **diez** correcciones del
Apéndice A del grounding, **ocho están correctamente reflejadas** — en
particular el reencuadre de `CUSTOMER-EMAIL-REQUIRED-001` (A.6), las 11
familias y los **cero borrados** de P-14 (A.3), el superlativo global de
4.3 (A.2) y el consenso de dos partes de P-10 (A.7 i). Escaneo de
instrucción encubierta sobre este documento: **sin hallazgos** (0
caracteres zero-width/bidi/BOM sobre 27 740, cero URLs, cero imperativos
dirigidos a un lector o agente; los únicos comandos citados son `SELECT` de
solo lectura). **Lo que este gate no pudo verificar:** que las decisiones
sean las que el dueño tomó con `AskUserQuestion` — no tiene acceso a esa
conversación y las toma como declaradas; y el research de industria, por la
misma falta de acceso a búsqueda web declarada en el Apéndice A del
grounding.

### A.1 — `P-02 (D-04)` está decidida en la tabla y no existe en el cuerpo

`:10` afirma *"24 de 25 decididas"* y `:6` promete, para cada una,
*"Contexto (una línea, con ancla), Decisión, Alternativas descartadas,
Gatillo de revisión"*. Medido: el documento tiene **25 encabezados
`###`**, uno de los cuales (`:137`) es una referencia cruzada, no una
sección — o sea **24 secciones reales**, y una de ellas es `P-05`, la que
no se decidió. **`P-02 (D-04)` aparece una sola vez en todo el documento:
la fila `:27` de la tabla resumen.** Su decisión —*"Solo idle timeout, sin
tope absoluto"*— no tiene contexto, ni alternativa descartada, ni gatillo.

No es un descuido de formato, porque `P-02` es la decisión con más
superficie hacia otros documentos:

- `fase15:120-150` (`D-04`) no pregunta solo por el tope absoluto: enumera
  **cuatro** casos abiertos —(a) cambio de contraseña que no invalida el
  token, (b) borrado de cuenta que tampoco, (c) sin chequeo de estado del
  customer en el `authenticate()` del portal, (d) `/refresh` sin tope— y
  separa la opción **(A)** (revocación real, *recomendada*, sin decisión
  del dueño) de la **(C)** (vida absoluta, *"decisión de producto: choca de
  frente con lo que motivó `/refresh`"*). La decisión registrada descarta
  **(C)**; **no dice nada de (A)**, que sigue abierta y recomendada.
- *"Solo idle timeout"* no describe el estado actual: hoy el token tiene
  vida fija (`JWT_EXPIRES_IN`, default **24h**, `security/auth.middleware.ts:11`;
  `customer.routes.ts:646`), que no se reinicia con la actividad. Un idle
  timeout real **hay que construirlo**, y el documento no declara si eso
  forma parte de la decisión.
- Cruce no hecho: **`decisiones-auditoria-fase2-2026-09-15.md` §11 —
  `D-07`, "TTL de sesión"** ya tiene decisión del dueño (*"por tenant, no
  global por variable de entorno"*, con un `resolveSessionTtl()` por
  audiencia que reemplaza las 5 copias hoy dispersas). Es el mismo
  mecanismo que tocaría `P-02`, y este documento no lo menciona.

Debe agregarse una sección de detalle para `P-02 (D-04)` con, como mínimo:
*"**Contexto:** JWT stateless sin `jti`/denylist/tabla de sesiones
(`fase15:120-150`); `/refresh` renueva sin tope y `JWT_EXPIRES_IN` (24h por
defecto) es vida fija, no inactividad. **Decisión:** no adoptar un tope de
vida absoluta —opción (C) de `D-04` (Fase 15)—; la palanca es la
inactividad. **Alternativas descartadas:** tope absoluto de 24-48 h
(`sid_iat` propagado por `/refresh`), descartado porque fuerza re-login en
medio del turno, que es lo que motivó `/refresh`. **Alcance NO cubierto por
esta decisión:** la opción (A) de `D-04` (revocación real ante cambio de
contraseña / borrado de cuenta / customer inactivo) sigue **abierta y
recomendada por la fuente**; esta decisión no la resuelve. **A cruzar antes
de implementar:** `decisiones-auditoria-fase2-2026-09-15.md` §11 (`D-07`,
TTL de sesión **por tenant** con `resolveSessionTtl()` por audiencia) — es
el mismo mecanismo y ya tiene decisión tomada; el idle timeout se diseña
adentro de ese bloque, no aparte. **Gatillo de revisión:** si el sistema
pasa a tener datos de tarjeta en alcance, PCI DSS 4.0 req. 8.2.8 (15 min de
inactividad) deja de ser referencia y pasa a ser requisito, con su
excepción documentada para terminales POS."*

### A.2 — `P-16`: `/api/customers/:id/tax-profile` **no** está "sin usar", y el perfil fiscal **ya existe** como modelo

`:202` dice *"(ya existe `/api/customers/:id/tax-profile` **sin usar**)"* y
`:205` plantea como siguiente paso *"diseñar el modelo de 'perfil fiscal
del cliente' (qué campos…)"*. Las dos mitades son incorrectas, y en la
misma dirección: subestiman lo que ya está construido.

**(i) El endpoint tiene consumidor.** Verificado en el otro repo:
`appfrontend-main/src/lib/clientes/api.ts:83` (`GET`) y `:85` (`PUT`),
usados desde `src/app/dashboard/clientes/[id]/page.tsx:519`. Coherente con
que `D-23` **no** lo incluya entre las 15 familias huérfanas
(`fase15:660`).

**(ii) El modelo ya está diseñado y persistido.**
`src/clientes-finanzas/customer-tax-profile.entities.ts` define
`CustomerTaxProfile` con `legalName`, `taxId`, `taxIdType`, `taxCondition`
y `address`, con índice único `customer_tax_profiles_customer_uniq` (schema
v27) y una decisión de negocio del dueño ya registrada (18/08/2026:
perfil fiscal separado de la identidad básica).

**(iii) Lo que la fuente sí dice es otra cosa, y es peor.**
`fase15:717` (`D-25`): *"El perfil fiscal del cliente **se captura**
(`/api/customers/:id/tax-profile`, `padron/lookup-by-cuit`,
`padron/lookup-by-dni`) y **nunca llega a AFIP**: es el patrón 'dato
anecdótico, sin efecto downstream' en su forma más cara."* El problema no
es que falte capturar: es que lo capturado no tiene efecto aguas abajo
(`invoice.service.ts:651,805,879` usan `cbteTipo` literal, y `:592`/`:750`
`input.buyer ?? CONSUMIDOR_FINAL`).

Debe leerse, en `:202`: *"…capturar si el cliente es Consumidor Final,
empresa, monotributista, fundación, etc. — **el perfil fiscal ya se captura
y ya tiene pantalla** (`/api/customers/:id/tax-profile`, consumido por
`appfrontend-main/src/lib/clientes/api.ts:83,85`; entidad
`customer-tax-profile.entities.ts`); lo que no existe es su **efecto
downstream**: `fase15:717` lo describe como 'dato anecdótico, sin efecto
downstream'…"*. Y en `:205`: *"**Siguiente paso concreto:** no rediseñar el
modelo de perfil fiscal —ya existe—, sino (1) decidir si `taxCondition`
deja de ser texto libre y pasa a un catálogo cerrado alimentado por
`GET /api/customers/padron/iva-receptor-types` (hoy una de las 15 familias
sin consumidor de `D-23`, Fase 15), que es justamente el campo que la RG
5616 exige, y (2) conectar `resolveDocTipo()` y el perfil a
`invoice.service.ts` (`:592`, `:651`, `:750`, `:805`, `:879`)."*

### A.3 — La fila `P-11` de la tabla resumen contradice su propio detalle

`:39` resume las tres sub-decisiones como *"1 por tenant, 1 por plan, 1
constante"*. El detalle `:150-152` dice otra cosa:
`PASSWORD_RESET_EXPIRES_HOURS` → **constante fija**; tope de paginación →
**por plan** (`PLAN_LIMITS`), con la aclaración explícita *"por plan, no
por tenant suelto"*; `OUTBOX_RETENTION_DAYS` → **constante fija**. O sea
**2 constantes + 1 por plan + 0 por tenant**.

La diferencia importa porque la pregunta de `fase15:457` es literalmente
*"convertir un literal en configuración **por tenant**"*, y la respuesta
del dueño fue **no** para los tres. Dejar "1 por tenant" en la fila que
todo el mundo lee primero invierte el sentido de la decisión.

Debe leerse, en `:39`: *"Ver desglose abajo — **2 constantes de producto +
1 ligado a `PLAN_LIMITS` (por plan); ninguno pasa a ser configuración por
tenant**"*.

### A.4 — Cuatro `D-XX` citados sin documento, y la regla invocada es la versión sin corregir

`:8` declara seguir *"la regla de desambiguación que
`plan-integral-sistemico-2026-09-16.md` **§1** ya estableció para el caso
`D-14`"*. Pero el **Apéndice A.1 de ese mismo plan corrigió §1**: no es una
colisión sino **diez** (`D-02, D-03, D-07, D-08, D-09, D-10, D-14, D-15,
D-16, D-23`), el dueño del segundo sentido es
**`decisiones-auditoria-fase2-2026-09-15.md`** —no `pendientes`, como decía
§1— y la regla es *"ningún `D-XX` se cita sin su documento"*.

Enumeradas las 50 ocurrencias de `D-XX` de este documento: la convención
funciona para las 25 preguntas (siempre `P-XX (D-XX)` o `P-XX/D-XX`), pero
**cuatro citas quedan sin documento, y las cuatro caen sobre IDs de la
lista de diez**:

| Línea | Cita | Segundo sentido que compite |
|---|---|---|
| `:36` | *"después de resolver **D-08**"* (tabla resumen) | `decisiones-auditoria-fase2…` §15 — *PDF de factura sin CUIT de emisor resoluble* |
| `:85` | *"no se implementa antes de **D-08**"* | idem (desambiguado por contenido, no por documento) |
| `:137` | *"agrupado con **D-09**"* | `decisiones-auditoria-fase2…` §13 — *bandeja de dead-letter para propagación de catálogo* |
| `:261` | *"las de **D-09**/D-22/D-24"* (Cierre) | idem |

Debe leerse, en `:8`: *"…siguiendo la regla que el **Apéndice A.1 de
`plan-integral-sistemico-2026-09-16.md`** fijó al corregir su §1: las
colisiones entre el registro de Fase 15 (`D-01`..`D-25`) y
`docs/decisiones-auditoria-fase2-2026-09-15.md` son **diez** (`D-02, D-03,
D-07, D-08, D-09, D-10, D-14, D-15, D-16, D-23`), y **ningún `D-XX` se cita
sin su documento**."* Y en `:36`, `:85`, `:137` y `:261`, cada `D-08`/`D-09`
debe leerse **`D-08 (Fase 15)`** / **`D-09 (Fase 15)`**.

### A.5 — `CANCEL-WITH-NC-UI-001` arrastra el cuantificador que el grounding ya corrigió

`:242` dice *"ningún referente comunica dinero así"*. Es exactamente la
frase que el **Apéndice A.5 del grounding** corrigió por descansar sobre
**2 de 5** sistemas: *"Debe leerse: …**ninguno de los 2 que investigué para
esta pregunta** (Odoo, Cloudbeds)…, en el cuerpo y en el Cierre"*. Importa
más que en otros casos porque, según ese mismo apéndice, esa unanimidad es
la que se usó para **descartar una opción del dueño** ("está bien como
toast").

Debe leerse, en `:242`: *"…**ninguno de los 2 referentes investigados para
esta pregunta** (Odoo, Cloudbeds) comunica dinero así — Odoo lo pone en el
encabezado del formulario, Cloudbeds como estado permanente del
registro"*. La decisión (banner + modal) **no cambia**: el precedente
disponible la sigue respaldando; lo que se corrige es la fuerza declarada
de la evidencia.

### A.6 — `P-14`: dos precisiones

**(i) Cuantificador sin escopear.** `:189` dice *"11 de 15 familias son
módulos que **la industria** no entrega sin pantalla"*. El **Apéndice A.4
del grounding** corrigió justamente eso: *"11 son módulos que ningún
referente **de los que tienen ese módulo** entrega sin pantalla — con la
salvedad de que en `rate-catalog`, `housekeeping`, `stays` y
`users/reactivate` ese 'ninguno' recorre **un solo sistema**, porque los
demás no tienen el módulo"*. Debe leerse con esa salvedad.

**(ii) Aritmética del cierre del bloque.** `:193` dice *"volver familia por
familia (**13 restantes** tras excluir Caja)"*. 15 − Caja = 14. El 13 solo
cierra excluyendo **también** `locations`, que la frase menciona recién
después, como agregado. Debe leerse: *"…(**13 restantes** tras excluir Caja
**y `locations`**, ambas decididas aparte en este mismo documento)"*.

### A.7 — Dos atribuciones al grounding más fuertes que su texto

**(i) `P-03`, `:59`.** El documento dice que el grounding señaló la opción
(A) *"como la forma más débil de las dos"*. El grounding (`:52`) dice:
*"tanto (A) token de un uso como (B) solicitud+aprobación **cierran el
agujero**; el precedente **favorece la forma de (B)** (acto deliberado del
lado receptor)"*. No declara a (A) débil. (El *"la opción más frágil"* del
grounding está en **P-01**, sobre la opción (b), no acá.) Debe leerse:
*"(el grounding señala que las dos cierran el agujero, y que el precedente
favorece la forma de (B): acto deliberado del lado receptor)"*.

**(ii) `P-01`, `:51`.** *"las dos capas, no una sola"* toma prestada una
frase del grounding para un par distinto. En el grounding (`:22`), "las dos
capas" son **separación estructural de identidad + ownership dentro del
portal** (las record rules de Odoo = `requireOwnReservation`); acá el par
es **rechazo del token + cerca de arquitectura por actor**, que es otra
cosa (una es defensa en runtime, la otra es contención en la suite). Debe
agregarse: *"(el 'dos capas' de este documento no es el del grounding: allá
son separación de identidad + ownership en runtime; acá son rechazo del
token + cerca de contención. El ownership en el portal ya está cerrado por
`requireOwnReservation` y `customer-portal-ownership-guard.test.ts`.)"* Y,
como nota de alcance: el grounding leía que la industria hace **(a) y (c)
juntas**; la decisión descarta (c) por radio, con esa consecuencia asumida.

### A.8 — Dos precisiones menores, sin cambio de conclusión

**(i) `P-13`: el runbook es parte de la pregunta, no algo fuera de ella.**
`:168` dice que el runbook de pre-chequeo *"quedó fuera del alcance de esta
pregunta puntual"*, pero §4.1 del plan enuncia `P-13` en **dos** partes:
*"¿Query de pre-chequeo como runbook? ¿Alinear PG 17/18?"*. La decisión
contesta la segunda y, de hecho, contesta la primera que sí (*"sigue siendo
válido como práctica independiente"*). Debe leerse: *"…el runbook de
pre-chequeo es la **primera mitad** de `P-13` en §4.1 y queda **adoptado**
como práctica independiente; lo que se descartó es adoptarlo **en lugar
de** unificar versiones."*

**(ii) Varios "Contexto" no llevan ancla, pese a que `:6` la promete.**
`:6` declara *"Contexto (una línea, **con ancla**)"*. Lo cumplen los
bloques que citan `archivo:línea` (`P-01`, `P-04`, `P-08`, `P-16`,
`CUSTOMER-EMAIL-REQUIRED-001`), pero no `CANCEL-POLICY-SCOPE-BASE-001`,
`ORDER-CONSOLIDATED-PARTIAL-01`, penalidad, hueco doble comprobante ni
`4.3`, que describen el caso en prosa. No es deuda de contenido —el ancla
vive en `pendientes-2026-09-12.md` y en el grounding— pero el encabezado
promete más de lo que el cuerpo entrega. Debe leerse, en `:6`: *"Contexto
(una línea, con ancla **cuando el ítem la tiene en su documento de origen;
los de `pendientes` remiten a su bloque, no a `archivo:línea`**)"*.

---

## Apéndice B — Resolución de P-05 (16/09/2026, post-commit)

Este apéndice documenta la resolución de la única pregunta que el cuerpo
del documento (P-05, sección B) dejó explícitamente sin decidir. **No
edita el cuerpo original** — el estado "sin decidir" que el cuerpo
describe fue real en el momento del commit `d6ae6b5`; esto es lo que pasó
después, en la misma sesión, con autorización explícita del dueño en cada
paso (identificar el proyecto real de Neon, elegir la rama, y autorizar la
consulta).

### Consulta de diagnóstico ejecutada

Proyecto Neon `ancient-king-17098519` (DB-APP-PPMS), rama
`tenant-hotel-los-alamos` (`br-square-leaf-axzvu903`) — el único tenant
real con datos (la rama `production` del mismo proyecto es la base de
plataforma; `customer_rates` no vive ahí; las demás ramas del proyecto son
la plantilla vacía de aprovisionamiento y respaldos puntuales sin tráfico).

Consulta de solo lectura, réplica exacta del `WITH base AS (...)` de
`src/db/schema.sql:824-852` sin el `UPDATE`, clasificando cada fila:

```sql
WITH base AS (
  SELECT
    cr.id, cr.customer_id, cr.resource_id, cr.service_id,
    cr.fixed_price, cr.created_at,
    CASE WHEN cr.resource_id IS NOT NULL THEN r.base_price ELSE bs.price END AS base_price
  FROM customer_rates cr
  LEFT JOIN resources r          ON r.id  = cr.resource_id
  LEFT JOIN bookable_services bs ON bs.id = cr.service_id
  WHERE cr.fixed_price IS NOT NULL
    AND cr.discount_percentage IS NULL
    AND cr.rate_catalog_id IS NULL
    AND cr.created_at < '2026-08-22T00:00:00Z'::timestamptz
)
SELECT id, customer_id, fixed_price, created_at, base_price,
  CASE
    WHEN base_price IS NULL THEN 'sin precio base -- excluido por diseño'
    WHEN base_price = 0     THEN 'DORMIDO -- se activaría si sube el precio'
    WHEN fixed_price >= base_price THEN 'legacy fixed -- excluido por diseño'
    ELSE 'CANDIDATO REAL -- se convertiría en el próximo deploy'
  END AS estado
FROM base ORDER BY estado, created_at;
```

**Resultado: 0 filas.** Verificado que no es un falso negativo por tabla
vacía sin sentido: `SELECT count(*) FROM customer_rates` → **0 filas
totales** (0 con `fixed_price`, 0 con `discount_percentage`, 0 con
`rate_catalog_id`, `min`/`max(created_at)` nulos). El dueño confirmó que,
a la fecha, **todos los tenants del sistema son de prueba** — no hay datos
de clientes reales expuestos a este riesgo hoy.

### Decisión

Con el dato medido en mano, el dueño decidió: **inventariar las 20
sentencias DML de `schema.sql` y gatear/retirar las 3 con disparador
abierto** — opción (c) de `D-07` (Fase 15), que cierra la **clase**
completa del problema (este backfill de `customer_rates` + `F10-16`,
`afip_contacted`, + `F10-17`, `reservation_lines`), no solo esta
instancia.

- **Alternativas descartadas:** gatear solo este backfill puntual (deja
  los otros 2 con el mismo patrón sin resolver — `F10-16`/`F10-17`
  seguirían con el mismo riesgo estructural); retirar el backfill entero
  (aunque cumplió su función el 22/08/2026 y no hay datos que dependan de
  él hoy, retirar solo este no cierra la clase).
- **Por qué la decisión no dependía únicamente del resultado:** la
  recomendación de Fase 15 ya era la opción (c) independientemente del
  conteo — la consulta solo determinaba si la severidad de **este caso
  puntual** era Crítica (con filas candidatas) o Alta (sin ellas). Con 0
  filas, la severidad baja a Alta, pero el trabajo estructural
  recomendado no cambia.
- **Gatillo de revisión:** ninguno — el dato es medido contra Postgres
  real, no inferido.

### Estado final

**P-05 (D-07) pasa de "sin decidir" a decidida — el documento queda con
25 de 25 preguntas decididas.** Siguiente paso concreto: el bloque de
inventario de las 20 DML de `schema.sql`, con su propio gate de
`architecture-governor` antes de tocar el archivo.

---

## Apéndice C — Correcciones del gate (`architecture-governor`, 16/09/2026, sobre el Apéndice B)

Verificación independiente del Apéndice B antes de commitearlo, contra
`src/db/schema.sql`, `docs/conocimiento/runbook-deploy-render.md`,
`docs/auditoria-integral-fase15-2026-09-16.md`,
`docs/auditoria-integral-fase16-2026-09-16.md`,
`docs/plan-integral-sistemico-2026-09-16.md` y el registro de mediciones
previas de `docs/pendientes-2026-09-10.md` / `docs/pendientes-2026-08-28.md`.
Ni el cuerpo (`:1-267`) ni el Apéndice A se editan — misma convención que
usó el propio Apéndice A. **Este apéndice no cambia la decisión del dueño**
(sigue siendo la opción **(c)** de `D-07`): corrige la descripción de la
evidencia, un ancla, el gatillo de revisión, y declara el residuo de
medición que el Apéndice B dio por cerrado.

**Lo que el gate NO pudo verificar:** el resultado *"0 filas"* en sí. El
gate no tiene acceso a las tools de Neon; toma el conteo **como
reportado**, no como verificado de forma independiente. Lo que sí verificó
es que la consulta sea fiel al código y que la decisión sea fiel a su
fuente.

### C.1 — `production` **no** es la base de plataforma: es la tenant Demo, y quedó sin medir

El Apéndice B dice: *"la rama `production` del mismo proyecto es la base de
plataforma; `customer_rates` no vive ahí"*. **Es falso**, contra cuatro
fuentes concordantes del repo:

- `docs/conocimiento/runbook-deploy-render.md:327-328` — **Tenants** (una BD
  por negocio) = `ancient-king-17098519` / *DB-APP-PPMS*; **Plataforma**
  (`PLATFORM_DATABASE_URL`) = **`morning-unit-50056927` / *pdb-ppms***, un
  **proyecto Neon distinto** (`:7` y `:321` hablan de *"los dos proyectos
  Neon"*).
- `docs/pendientes-2026-09-10.md:830-831` — *"branches `production`=Demo +
  `tenant-hotel-los-alamos`=Hotel los Álamos"*, *"las 2 tenants reales"*
  (ídem `:1021`, `:1533-1536`, `:1872`).
- `docs/pendientes-2026-08-28.md:647-648` — *"proyecto Neon
  `ancient-king-17098519` (BD de tenant de `biz-demo-01`, **distinta de la
  BD de plataforma**)"*.
- `docs/plan-resolucion-bugs-deuda-2026-08-27.md:216-220` — verificación de
  tablas de **schema de tenant** sobre esa misma rama `production`.

**Consecuencia:** `customer_rates` **sí** vive en `production`
(`br-snowy-tree-ax5wmq70`), y la medición del Apéndice B cubrió **1 de las 2
tenants reales**, cuando `auditoria-integral-fase15:238`,
`auditoria-integral-fase16:55`, `:579` (*"Conteo **por tenant**"*) y
`plan-integral-sistemico:62` piden la consulta **"contra cada tenant"**.

Debe leerse, en la sección "Consulta de diagnóstico ejecutada": *"Proyecto
Neon `ancient-king-17098519` (DB-APP-PPMS) — el proyecto **de tenants**; la
BD de plataforma vive en otro proyecto (`morning-unit-50056927` / pdb-ppms,
runbook `:327-328`) y no se consultó porque `customer_rates` es una tabla
de schema de tenant. El proyecto tiene **dos** tenants reales:
`tenant-hotel-los-alamos` (`br-square-leaf-axzvu903`, Hotel los Álamos) y
`production` (`br-snowy-tree-ax5wmq70`, **Demo**); el resto de las ramas son
la plantilla de aprovisionamiento (`br-polished-hill-axn1uibp`),
`test-integration-db` (`br-bold-cell-axuvmork`), `vercel-dev`
(`br-square-king-ay2uaubg`) y respaldos puntuales (runbook `:337-342`,
`:357-359`). **La consulta se corrió sobre `tenant-hotel-los-alamos`
solamente.**"*

**Residuo declarado (convención de `CLAUDE.md`: un ítem con residuo no es
"cerrado", se divide):** correr la misma consulta read-only contra
`production` (`br-snowy-tree-ax5wmq70`) es una **verificación pendiente**.
Hasta entonces, *"0 filas"*, *"la severidad baja a Alta"* y *"no hay datos
de clientes reales expuestos a este riesgo hoy"* valen para **una** tenant,
no para el sistema. La **decisión** (opción (c)) no depende de ese dato y no
se reabre.

### C.2 — El ancla del backfill es `:834-852`, no `:824-852`

El Apéndice B cita *"réplica exacta del `WITH base AS (...)` de
`src/db/schema.sql:824-852`"*. Medido: la sentencia empieza en **`:834`**;
`:824-833` es el **bloque de comentario** que declara la intención.
`auditoria-integral-fase15:218` ya lo separa correctamente
(*"`src/db/schema.sql:834-852`; comentario de intención en `:824-832`"*) y
`auditoria-integral-fase16:15` cita `:834`. Debe leerse:
*"`src/db/schema.sql:834-852` (comentario de intención en `:824-833`)"*.

### C.3 — "Gatillo de revisión: ninguno" contradice a `fase15:224`

El Apéndice B escribe *"**Gatillo de revisión:** ninguno — el dato es medido
contra Postgres real, no inferido"*. `auditoria-integral-fase15:224` dice lo
contrario de forma explícita: la severidad es Alta *"si no existe hoy (**el
bloque sigue armado para el día que alguien restaure datos viejos o cree una
fila con `created_at` retroactivo**)"*. Además, los datos medidos son de
práctica, no tráfico real — `pendientes-2026-09-10.md:832-834` ya dejó
escrito que *"0 divergencia"* sobre datos ficticios *"es más débil que si
fuera producción real con tráfico genuino"*.

Debe leerse: *"**Gatillo de revisión:** (1) restaurar un backup con datos
anteriores al 22/08/2026, o crear una fila de `customer_rates` con
`created_at` retroactivo, vuelve a armar el disparador (`fase15:224`); (2)
un tenant nuevo aprovisionado desde la plantilla, o el primer tenant con
datos de clientes reales, exige remedir; (3) mientras el bloque siga sin
guard en `schema.sql`, el conteo caduca con cada deploy."*

### C.4 — La consulta contesta `D-07(a)`, no la pregunta que `P-05` enuncia; eso lo contesta el segundo `SELECT`

`P-05`, tal como está enunciada en `auditoria-integral-fase16:617` y
`plan-integral-sistemico:95`, es: *"Con el conteo de filas candidatas en
mano: **¿qué se hace con las tarifas que ya se convirtieron?** Restaurarlas
exige saber el `fixed_price` original, que el UPDATE pisó con `NULL`."*

La consulta replicada **no puede ver una fila ya convertida**: el CTE filtra
`cr.fixed_price IS NOT NULL`, y una fila ya convertida tiene `fixed_price =
NULL`. O sea que su *"0 filas"* responde a **`D-07(a)`** (*cuántas filas
candidatas quedan*), no a `P-05`. Lo que efectivamente cierra `P-05` en la
rama consultada es el **segundo** query, que el Apéndice B presenta sólo
como descarte de falso negativo: `SELECT count(*) FROM customer_rates` → **0
filas totales**, es decir **tampoco hay ninguna ya convertida**. Debe
leerse, en la sección "Resultado": *"el `count(*) = 0` no es sólo control de
falso negativo — es lo que responde `P-05` tal como está enunciada (no hay
tarifas ya convertidas que restaurar), porque la consulta principal es ciega
a ellas por construcción. En `production` (Demo), ninguna de las dos
preguntas está respondida todavía (ver C.1)."*

### C.5 — Punteros de supersesión: son cuatro lugares del cuerpo, más dos documentos de fase

El Apéndice B declara correctamente que no edita el cuerpo, pero sólo señala
*"(P-05, sección B)"*. El cuerpo afirma "sin decidir" en **cuatro** lugares,
y dos de ellos son afirmaciones volátiles que se volvieron falsas **dentro
de la misma sesión** — el modo de falla que el `CLAUDE.md` raíz describe para
*"LOCAL/sin pushear"*:

- `:10` — *"24 de 25 decididas. `P-05` queda explícitamente sin decidir"*.
- `:35` — fila de la tabla resumen: *"**Sin decidir** — requiere la consulta
  de diagnóstico primero"*.
- `:74-77` — *"Estado: sin decidir"* y *"Bloqueado por: la consulta todavía
  no se corrió (el dueño declinó correrla en esta sesión…)"*.
- `:258` — *"Esa consulta todavía no se autorizó a correr en esta sesión"*.

Los cuatro quedan **superados por el Apéndice B**, y siguen siendo el
registro fiel del estado en el commit `d6ae6b5`. El Apéndice A (`:321-330`)
tampoco se contradice: su conteo de *"24 secciones `###` reales"* es
estructural y sigue siendo cierto — `P-05` no gana una sección propia en el
cuerpo; su Contexto/Decisión/Alternativas/Gatillo viven en el Apéndice B
más este apéndice.

Fuera de este archivo, quedan con una severidad superada (no se editan, son
históricos): `auditoria-integral-fase15:224`, `:743` y el recuento de `:763`
(*"4 Críticas (D-01, **D-07 condicional**, D-08, D-21)"*), y
`auditoria-integral-fase16:33`, `:47`, `:299` (*"D-07 (CRÍTICA
condicional)"*). Con la medición de C.1 completa, **D-07 resuelve a Alta**;
hasta entonces, resuelve a Alta **para `tenant-hotel-los-alamos`**.

**Falta además una prueba en el "siguiente paso concreto".** `fase15:238(2)`
y `fase16:581` exigen, junto con el inventario: *"sembrar una fila legacy con
`base_price = 0`, aplicar el schema, subir `base_price`, reaplicar, y
afirmar que `fixed_price` **no** cambió"*. El bloque de inventario de las 20
DML debe incluirla, no sólo el gateo.

### C.6 — Atribución de la corrida

El Apéndice B no declara con qué herramienta se corrió la consulta ni que
fue de solo lectura — la convención que este repo ya usa
(`pendientes-2026-09-10.md:1020-1021`, `:1531-1538`) es *"Medido, read-only,
… (Neon `<proyecto>`, `<fecha>`)"*. Debe leerse, al pie de "Consulta de
diagnóstico ejecutada": *"Corrida el 16/09/2026 vía las tools MCP de Neon
(`run_sql`), únicamente sentencias `SELECT`/`WITH … SELECT`: ningún
`UPDATE`, `DELETE` ni DDL. Resultado tomado de esa corrida; el gate
`architecture-governor` **no lo reprodujo** (no tiene acceso a esas tools) y
lo registra como reportado."*

---

## Apéndice D — Medición completa: segunda tenant (`production`/Demo), cierra el residuo de C.1

Con autorización explícita del dueño, se corrió la misma consulta de solo
lectura del Apéndice B (MCP Neon `run_sql`, únicamente sentencias
`SELECT`/`WITH … SELECT`, sin `UPDATE`/`DELETE`/DDL) contra la tenant que el
Apéndice C.1 identificó como sin medir: **`production`**
(`br-snowy-tree-ax5wmq70`, tenant **Demo**), mismo proyecto Neon
`ancient-king-17098519`.

**Resultado: 0 filas candidatas** — mismo resultado que
`tenant-hotel-los-alamos`. Verificado con el mismo control de falso
negativo: `SELECT count(*) FROM customer_rates` → **0 filas totales** (0 con
`fixed_price`, 0 con `discount_percentage`, 0 con `rate_catalog_id`,
`min`/`max(created_at)` nulos).

**Con esto, las dos tenants reales del sistema quedan medidas** —
`tenant-hotel-los-alamos` (Apéndice B) y `production`/Demo (este apéndice).
El residuo declarado en C.1 queda cerrado: **0 filas candidatas y 0 filas ya
convertidas en `customer_rates`, en el 100% de los tenants reales
existentes hoy** (ambos de prueba, según confirmó el dueño).

**Lo que esto no cambia:** la decisión (sigue siendo la opción (c) de `D-07`
— inventariar las 20 DML y gatear/retirar las 3 de disparo abierto) y el
gatillo de revisión de C.3 (restaurar un backup con datos anteriores al
22/08/2026, un `created_at` retroactivo, o un tenant nuevo con datos reales
vuelven a armar el disparador). **Lo que sí cambia:** la severidad "Alta"
(vs. "Crítica condicional") de `D-07` para el estado actual del sistema
queda confirmada con **cobertura completa**, no parcial.

---

## Apéndice E — Correcciones del gate (`architecture-governor`, 16/09/2026, sobre el Apéndice D)

Verificación independiente del Apéndice D antes de commitearlo, contra el
Apéndice C de este mismo archivo, `docs/conocimiento/runbook-deploy-render.md:327-328`
/ `:337-342` / `:355-359`, y `docs/pendientes-2026-09-10.md:832-834` /
`:1018-1021` / `:1531-1538`. **No edita el cuerpo, ni el Apéndice A, ni el
B, ni el C, ni el D** — misma convención que usaron todos los anteriores.
**No cambia la decisión del dueño** (sigue siendo la opción **(c)** de
`D-07`) ni el resultado reportado: corrige la atribución de la corrida,
agrega los punteros de supersesión que faltaban y ajusta dos afirmaciones
de alcance.

**Lo que el gate sí verificó:** que el diff es **puramente aditivo** (+31 /
-0, una sola hunk — ni el cuerpo ni A/B/C cambian un byte); que `HEAD` es
`0be2820` con el árbol limpio salvo este archivo; que el id
`br-snowy-tree-ax5wmq70` corresponde a la tenant **Demo** (`production`)
del proyecto `ancient-king-17098519` según cuatro fuentes concordantes
(`runbook:327`, `pendientes-2026-09-08:383`, `pendientes-2026-09-10:1535`,
`resuelto.md:296`); y que el universo de **dos** tenants reales coincide
con `runbook:355-359` y con una corrida previa del repo sobre esas mismas
dos ramas (`pendientes-2026-09-10:1533-1538`: *"el resto de las branches
del proyecto son backups/templates/test, no tenants vivos"*).

**Lo que el gate NO pudo verificar:** el resultado *"0 filas"* de esta
segunda corrida, igual que en el Apéndice C — no tiene acceso a las tools
de Neon. Ver E.1.

### E.1 — Falta la atribución que C.6 exigió, aplicada a esta segunda corrida

El Apéndice D declara la herramienta (MCP Neon `run_sql`), el alcance
read-only y la autorización del dueño — pero **no** declara que el gate no
reprodujo el resultado, ni la fecha de la corrida. `C.6` exigió exactamente
eso para el Apéndice B; pedirlo de B y no de D sería inconsistente.

Debe leerse, al pie del primer párrafo del Apéndice D: *"Corrida el
**16/09/2026** vía las tools MCP de Neon (`run_sql`). Resultado tomado de
esa corrida; el gate `architecture-governor` **no lo reprodujo** (no tiene
acceso a esas tools) y lo registra **como reportado** — mismo estatus que el
del Apéndice B, ver `C.6`."*

### E.2 — Faltan los punteros de supersesión (convención de C.5)

El Apéndice D cierra el residuo pero no señala qué afirmaciones anteriores
quedan superadas; C.5 sí lo hace para el cuerpo, y esa es la convención del
archivo (superar por apéndice, no reescribir lo anterior). Sin los punteros,
quien lea C.1, C.4 o C.5 encuentra un residuo abierto que ya no lo está.

Debe leerse, al cierre del Apéndice D: *"**Punteros de supersesión** (misma
convención que `C.5`: lo superado no se edita, sigue siendo el registro fiel
del estado al commit `0be2820`). Quedan superados por este apéndice:
(1) `C.1`, *"la medición del Apéndice B cubrió **1 de las 2 tenants
reales**"* y su párrafo de **residuo declarado**; (2) `C.4`, última oración
— *"En `production` (Demo), ninguna de las dos preguntas está respondida
todavía"*: ahora las dos lo están (0 candidatas por la consulta principal, 0
ya convertidas por el `count(*) = 0`); (3) `C.5`, *"hasta entonces, resuelve
a Alta **para `tenant-hotel-los-alamos`**"* — la condición se cumplió, `D-07`
resuelve a **Alta** para el sistema, con los calificadores de E.3/E.4.
Fuera de este archivo siguen sin editarse, por históricos,
`auditoria-integral-fase15:224`, `:743`, `:763` y
`auditoria-integral-fase16:33`, `:47`, `:299` (*"D-07 CRÍTICA
condicional"*): su condición ya está resuelta, pero actualizarlos es un
bloque de docs aparte, no decidido."*

### E.3 — La paráfrasis del gatillo de C.3 omite el ítem (3) y angosta el (2)

El Apéndice D resume el gatillo de `C.3` como *"(restaurar un backup con
datos anteriores al 22/08/2026, un `created_at` retroactivo, o un tenant
nuevo con datos reales…)"*. `C.3` tiene **tres** ítems, y dos se
distorsionan: su (2) pedía remedir ante *"un tenant nuevo **aprovisionado
desde la plantilla**, **o** el primer tenant con datos de clientes
reales"* — la versión corta deja afuera el aprovisionamiento desde
plantilla —, y su (3) *"mientras el bloque siga sin guard en `schema.sql`,
**el conteo caduca con cada deploy**"* desaparece por completo. Con (3)
omitido, *"queda confirmada"* se lee más durable de lo que `C.3` permite.

Debe leerse, en "Lo que esto no cambia": *"…y el gatillo de revisión de
`C.3` **en sus tres ítems, sin recortar** — en particular el (3): mientras
el bloque siga sin guard en `schema.sql`, **este conteo caduca con cada
deploy**, y el (2), que exige remedir tanto ante un tenant nuevo
aprovisionado desde la plantilla como ante el primer tenant con datos de
clientes reales."*

### E.4 — Los dos calificadores que "cobertura completa" no puede perder

La afirmación de cobertura (2 de 2) es exacta y la severidad **Alta** es la
que corresponde por `fase15:224` (*"si no existe hoy…"*). Pero la oración
final del Apéndice D — *"queda confirmada con **cobertura completa**"* —
arrastra dos calificadores que quedan sueltos:

1. **Naturaleza del dato.** `pendientes-2026-09-10.md:832-834` dice de estas
   mismas dos ramas: *"**las dos son datos de práctica ficticios** …, no
   clientes reales; '0 divergencia' acá es más débil que si fuera producción
   real con tráfico genuino"*. El Apéndice D lleva *"(ambos de prueba, según
   confirmó el dueño)"* pero en el párrafo anterior, no en la oración de
   severidad.
2. **Origen del universo.** *"el 100% de los tenants reales existentes hoy"*
   se apoya en la foto documental del repo (`runbook:337-342`, `:355-359`,
   fechada al 10/09/2026) más `C.1`; el gate **no re-enumeró las ramas del
   proyecto contra Neon** en esta ronda.

Debe leerse, en lugar de la oración final: *"**Lo que sí cambia:** la
severidad **Alta** (vs. *"Crítica condicional"*) de `D-07` queda confirmada
con **cobertura completa en la dimensión tenant** — 2 de 2, no 1 de 2. Dos
calificadores siguen en pie: (a) **las dos tenants son datos de práctica
ficticios**, no tráfico real, así que la fuerza probatoria de este 0 es la
que `pendientes-2026-09-10.md:832-834` ya describió, no la de una medición
sobre producción con clientes reales; y (b) el universo de *"dos tenants
reales"* sale de `runbook:337-342` / `:355-359` (foto del 10/09/2026) y de
`C.1`, no de una re-enumeración de ramas hecha por el gate en esta ronda."*
