# Criterios de negocio — mapa completo

`docs/criterios-datos.md` cubre **una** dimensión: la integridad de las
entidades. Toda la información que maneja esta app necesita otras nueve.

> Origen: mismo hallazgo del 13/08/2026 (categorías fantasma) que motivó
> `criterios-datos.md`. Este documento es el mapa de las nueve dimensiones
> restantes — todavía **no auditado en detalle** (es "una tarde" de trabajo,
> por diseño, no algo para hacer a mitad de un incidente). Lo que sigue es
> el marco de referencia; el estado de cumplimiento real de los reglamentos
> 2 en adelante queda pendiente de revisión.

---

## El mapa

| # | Reglamento | Qué gobierna | Si falla | Estado |
|---|---|---|---|---|
| 1 | **Integridad de datos** | Entidades, ciclo de vida, borrado | Datos anecdóticos, duplicados | ✅ `criterios-datos.md` |
| 2 | **Aislamiento multi-tenant** | Quién ve los datos de quién | **Fin de la empresa** | 🔴 Escribir hoy |
| 3 | **Dinero** | Precisión, composición, impuestos | Descuadre contable, riesgo fiscal | 🔴 Escribir hoy |
| 4 | **Tiempo** | Instantes, fechas, husos, recurrencia | Reservas en el horario equivocado | 🔴 Escribir hoy |
| 5 | **Lenguaje ubicuo** | Un término = un concepto | Confusión permanente en multirubro | 🟠 Esta semana |
| 6 | **Estados y transiciones** | Máquinas de estado | Reglas divergentes back/front | 🟠 Esta semana |
| 7 | **Privacidad / PII** | Datos personales | Multa y pérdida de confianza | 🟠 Esta semana |
| 8 | **Concurrencia** | Escrituras simultáneas | Sobreventa, cobros duplicados | 🟠 Parcial |
| 9 | **Observabilidad** | Qué se registra y se mide | No se puede auditar lo que no se ve | 🟡 Este mes |
| 10 | **Eventos** | Contratos entre módulos | Integraciones frágiles | 🟡 Este mes |

Los reglamentos 2, 3 y 4 comparten una propiedad con el de datos: **si están
mal, la información ya guardada queda mal para siempre**. Los demás se
pueden arreglar sin migrar nada.

---

# 2. Aislamiento multi-tenant 🔴

La única regla de este documento cuyo incumplimiento cierra la empresa. Un
negocio viendo datos de otro no es un bug: es el fin de la confianza en el
producto.

**A2.1 — Ninguna query sin ámbito de tenant.** Toda consulta o escritura
está acotada al negocio del token. Sin excepciones, ni en scripts, ni en
endpoints de admin, ni en jobs.

**A2.2 — El ámbito nunca viene del cliente.** `businessId` sale del token
verificado en el servidor. Un `businessId` en el body o el query string es
un intento de escalada de privilegio, aunque venga del propio frontend.
*Verificar: el frontend decodifica el JWT client-side para leer
`businessId` — asegurarse de que eso sea solo para UI y que el backend
nunca confíe en un valor enviado.*

**A2.3 — Verificación de pertenencia en cada acceso por ID.**
`GET /api/resources/:id` con un ID de otro negocio devuelve **404, no
403**. Un 403 confirma que el recurso existe, que ya es una filtración.

**A2.4 — Los dos dominios de auth no se cruzan.** Staff y clientes finales
son sistemas separados. Un token de cliente jamás alcanza `/api/*` de
staff. *Ya cumplido: `customerApi` con interceptor propio y redirect
distinto.*

**A2.5 — Un cliente pertenece a un negocio.** El portal de un
`businessSlug` no reconoce sesión de otro. *Ya resuelto en el redirect raíz
del portal.*

**A2.6 — Toda referencia cross-DB se valida.** `stays.assigned_by` guarda
un `identity_id` de la BD de plataforma sin FK posible. Antes de confiar en
ese valor hay que verificar que esa identity tenga membership **en este
negocio**. Sin eso, un ID arbitrario pasa.

**A2.7 — Prueba obligatoria.** Test de integración que, con credenciales
del negocio A, intenta leer y escribir cada recurso del negocio B. Se corre
en CI y bloquea el merge. Es el único test que no se negocia.

**A2.8 — Pools separados por tenant, no solo filtro por `businessId`.**
Este proyecto usa un pool de conexión distinto por tenant además del
filtrado lógico — un bug acá no es "vio datos de otro negocio", es
"escribió contra la base equivocada". Todo cambio que toque
`src/api/routes/`, `src/container.ts`, `src/platform/` o `src/workers/`
responde tres preguntas antes de mergear:
1. ¿Este código corre contra `req.db` (BD del **tenant**) o contra
   `getPlatformRawPool()` / `PLATFORM_DATABASE_URL` (BD **central**)? ¿Es
   el que corresponde?
2. Si abre una transacción (`TransactionManager.run(...)`), ¿el pool con
   el que se construyó ese `TransactionManager` es el mismo que el de los
   repos que participan en esa transacción?
3. Si emite o consume domain events, ¿el `DomainEventRepository` apunta a
   la misma BD donde se escribió el evento?

*Por qué existe esta regla:* los bugs críticos encontrados en el review de
agosto 2026 fueron, en el fondo, la misma confusión repetida — mezclar el
pool de plataforma con el del tenant.

---

# 3. Dinero 🔴

**A3.1 — Nunca punto flotante.** `NUMERIC(12,2)` en Postgres, enteros en
centavos en la aplicación. Ni un `float` en toda la cadena, incluido el
JSON.

**A3.2 — Toda cifra lleva moneda.** No existe "500". Existe "500 ARS".
Multirubro + multi-tenant + inflación argentina hacen que asumir la moneda
sea una bomba de tiempo.

**A3.3 — Un solo lugar redondea, con política declarada.** Media hacia
arriba, a 2 decimales, al final del cálculo. Nunca redondear intermedios y
volver a sumar.

**A3.4 — El total nunca se recalcula al leer.** Se persiste el que se
calculó al confirmar. *Ya cumplido con `subtotal = quantity * unitPrice`
persistido.*

**A3.5 — El precio se descompone y se guarda descompuesto.** Base,
descuento, impuesto y total como columnas separadas. Guardar solo el total
impide responder "¿por qué me cobraste esto?".

**A3.6 — Toda resolución de precio es auditable.** La cascada (tarifa
cliente+servicio → catálogo → cliente+recurso → base) debe dejar
registrado **cuál de los cuatro escalones ganó**. Sin eso, una disputa de
precio es irresoluble.

**A3.7 — El impuesto se congela con la transacción.** Si el IVA cambia, las
facturas viejas no cambian. Corolario de R9 (criterios-datos).

**A3.8 — Financieras: solo INSERT.** Sin UPDATE ni DELETE, idealmente
revocado a nivel Postgres. Corregir es contra-asentar.

**A3.9 — Todo movimiento tiene contrapartida.** Un cargo sin origen o un
pago sin destino es un descuadre esperando. Todo importe se explica por
otro registro.

**A3.10 — Cobros idempotentes.** *Ya resuelto con `idempotencyKey` del
cliente.*

---

# 4. Tiempo 🔴

Hay **tres tipos distintos** de tiempo y mezclarlos es el bug que aparece
recién cuando hay un cliente en otra provincia.

| Tipo | Qué es | Cómo se guarda | Ejemplo |
|---|---|---|---|
| **Instante** | Un momento absoluto | `TIMESTAMPTZ` en UTC | Inicio de reserva, momento de pago |
| **Hora de pared** | Una hora local sin fecha | `TIME` + timezone del negocio | `business_hours`, `service_schedules` |
| **Fecha de negocio** | Un día calendario, sin hora | `DATE` | Fecha de check-in, `occupancy_records.date` |

**A4.1 — Todo instante en `TIMESTAMPTZ`, guardado en UTC.** La conversión a
local pasa en un solo punto.

**A4.2 — `Business` tiene `timezone` obligatorio.** IANA
(`America/Argentina/Buenos_Aires`), no offset numérico. Los offsets no
sobreviven a un cambio de reglas horarias.

**A4.3 — Las horas de atención son hora de pared, no instantes.** "Abre a
las 9" es 9 local siempre, sin importar la época del año. Guardarlas como
instante rompe con cualquier cambio de huso.

**A4.4 — La fecha de negocio no es la fecha del sistema.** Una reserva
creada 23:50 del lunes puede pertenecer al martes operativo. Definir
explícitamente el corte de día por negocio.

**A4.5 — Una duración no es un rango.** Un servicio dura 45 minutos; la
reserva ocupa de 14:00 a 14:45. La duración vive en el maestro, el rango en
la transacción. *Ya se distingue bien en el wizard del portal.*

**A4.6 — Días de semana con convención única y escrita.** ISO-8601 (lunes =
1). Un mismo entero significando cosas distintas entre `business_hours` y
`service_schedules` es un bug silencioso.

**A4.7 — Regla de cierre para el cambio de hora.** Argentina hoy no aplica
DST, pero Chile, Brasil y Paraguay sí. Definir desde ahora qué pasa con una
hora que no existe o que ocurre dos veces.

---

# 5. Lenguaje ubicuo 🟠

Crítico específicamente porque la app es multirubro. Cuando
`PhysicalResource` es a la vez una habitación, un barbero y una cancha, el
vocabulario deja de ser cosmético.

**A5.1 — Un término, un concepto, en todo el stack.** El nombre en el
código, en la BD, en la API y en la conversación con la IA es el mismo.
Nada de `resource` en el código y `unidad` en la charla.

**A5.2 — Glosario versionado en el repo.** `docs/glosario.md` con la
definición canónica de `Resource`, `Service`, `Reservation`, `Stay`,
`Booking`, `Order`, `Account`. La distinción `Reservation` (intención) vs
`Stay` (ocupación real) tiene que estar escrita, no vivir en la cabeza de
alguien.

**A5.3 — El vocabulario del código es genérico; la UI se traduce por
rubro.** El core no sabe qué es un hotel. `PhysicalResource` se muestra
como "Habitación", "Profesional" o "Cancha" según el vertical. **La
traducción vive solo en la capa de presentación.**

**A5.4 — Un renombre es una migración, no un find-and-replace.** Toca BD,
API, tipos y documentación en el mismo commit.

**A5.5 — Instrucción permanente a la IA.** *"Usá los nombres que ya existen
en el código. Si una entidad se llama `Turno`, no la renombres a
`BookingLine`."* Sin esto se termina con dos vocabularios conviviendo, que
es la peor forma de deuda técnica en un dominio complejo.

---

# 6. Estados y transiciones 🟠

**A6.1 — Una máquina de estados se declara una sola vez.** Como dato, no
como `if`. Tabla o constante con `{estadoActual: [transicionesPermitidas]}`.

**A6.2 — El backend expone `allowedTransitions[]` en el DTO.** Hoy el
frontend duplica a mano las máquinas de `Reservation`, `HousekeepingTask` y
`Order`. Funciona, pero cada cambio de regla son dos lugares y algún día
divergen. Que el servidor diga qué se puede hacer elimina la clase entera
de bug.

**A6.3 — Toda transición inválida lanza error tipado.** Nunca se ignora en
silencio.

**A6.4 — Los estados terminales no se reabren.** *Ya cumplido en `Stay`.*

**A6.5 — Toda transición deja rastro:** quién, cuándo, desde qué estado.

**A6.6 — El rol condiciona la transición en el servidor.** Que el botón
esté oculto en la UI no es control de acceso. *Verificar: en housekeeping,
`isManagement` filtra botones en el front — asegurarse de que el backend
rechace lo mismo.*

---

# 7. Privacidad y datos personales 🟠

La app maneja email, teléfono, CUIT, domicilio y datos fiscales. En
Argentina aplica la Ley 25.326 y hay un proyecto de reforma en curso — esto
es cumplimiento legal, no higiene. **Consultar con un profesional antes de
definir la política; lo de abajo es el piso técnico.**

**A7.1 — Nunca PII en los logs.** Ni email, ni teléfono, ni documento. Se
loguean IDs. Este es el que más se incumple sin darse cuenta.

**A7.2 — PII nunca en URLs ni query strings.** Quedan en historiales de
navegador, proxies y logs de acceso.

**A7.3 — Minimización.** No pedir ni guardar lo que no se usa. Cada campo
de más es superficie de riesgo.

**A7.4 — Anonimizar, no borrar.** *Ya cumplido en `DELETE /api/customer/me`,
y es idempotente.*

**A7.5 — La anonimización preserva la integridad financiera.** Las
transacciones del cliente anonimizado siguen existiendo y cuadrando; se va
el dato identificatorio, no el asiento.

**A7.6 — Política de retención escrita.** Cuánto tiempo se guarda cada
cosa, y qué pasa cuando un negocio se da de baja.

**A7.7 — Portabilidad.** El cliente puede pedir sus datos. Tiene que
existir la forma de dárselos.

---

# 8. Concurrencia 🟠

**A8.1 — Toda operación con recurso escaso se serializa en la base.** *Ya
resuelto en solapamiento de reservas con `FOR UPDATE`.*

**A8.2 — Los invariantes se expresan como constraint, no como validación.**
Un chequeo en la capa de servicio es read-then-write: dos requests
concurrentes lo pasan los dos. En Postgres, `EXCLUDE USING gist` con
`tstzrange` para solapamiento, índices únicos parciales para duplicados.

**A8.3 — Verificar límite y escribir, en la misma transacción.**
`SELECT COUNT` seguido de `INSERT` sin serializar deja pasar dos altas
simultáneas por encima del tope del plan.

**A8.4 — Bloqueo optimista en edición.** Columna `version`; si cambió entre
el GET y el PUT, se rechaza. Sin esto, dos recepcionistas editando el mismo
cliente: el último pisa al primero y nadie se entera.

**A8.5 — Toda mutación acepta clave de idempotencia.**

**A8.6 — Nunca reintentar automáticamente una mutación.** *Ya cumplido:
retry solo en GET/HEAD.*

---

# 9. Observabilidad 🟡

**A9.1 — Logs estructurados en JSON**, nunca strings concatenados.

**A9.2 — `correlationId` en todo request**, propagado a los eventos que
dispare. Sin esto no se puede reconstruir qué pasó.

**A9.3 — Todo log lleva `businessId`.** En multi-tenant, un log sin tenant
es inútil.

**A9.4 — Un audit log separado del outbox.** `domain_events` se despacha y
se marca; un audit log es append-only y nadie lo consume en tiempo real.
Son dos cosas. *Mismo hallazgo que R8 de `criterios-datos.md` — confirmado
de nuevo el 14/08/2026 sin tabla equivalente en `schema.sql`, con validación
externa contra Tango (`Gap analysis - Tango ERP vs modelo actual.md`).*

**A9.5 — Alertas sobre lo que rompe plata o confianza:** outbox con eventos
sin despachar hace más de X minutos, transacciones financieras que no
cuadran, picos de 402/403.

**A9.6 — Health check que verifique la versión de esquema del tenant**, no
solo que la BD responda.

---

# 10. Eventos 🟡

**A10.1 — Nombre en pasado, con versión:** `reservation.confirmed.v1`. El
evento describe algo que ya ocurrió.

**A10.2 — Payload autocontenido.** El handler no debería tener que ir a
buscar el estado actual: para cuando corre, ya cambió.

**A10.3 — Handlers idempotentes.** *Ya cumplido.*

**A10.4 — Versión desconocida se rechaza ruidosamente**, nunca se asume
compatible.

**A10.5 — Un evento no es un comando.** `reservation.confirmed` (hecho, N
consumidores) ≠ `send_email` (orden, un ejecutor).

**A10.6 — El despacho no depende del tráfico.** ⚠️ *Parcialmente
incumplido: el `OutboxWorker` se instancia por tenant desde
`tenantMiddleware` (ya no por-request, corregido en sesión anterior), pero
un tenant sin visitas todavía no arranca su worker hasta el primer
request.*

---

## Cómo usar esto

**Como auditoría:** recorrer los diez reglamentos marcando cumple / no
cumple / verificar. Es una tarde y da el mapa real. **No hecho todavía** —
pendiente como iniciativa separada.

**Como control permanente:** ver `CLAUDE.md` de este repo.

**Como checklist de PR:** aislamiento de tenant, dinero, tiempo y estados
son los cuatro que se revisan en cada cambio. Los demás, cuando el cambio
los toca.

**Lo que se hace cumplir solo:** el test de aislamiento cross-tenant en CI,
los constraints en Postgres, y el test de arquitectura sobre `findById`
(ver `criterios-datos.md`). Las reglas escritas se olvidan; estas tres no.
