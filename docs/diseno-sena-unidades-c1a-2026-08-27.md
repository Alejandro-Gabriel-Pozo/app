# Diseño — Seña en 3 formas (`PERCENTAGE` / `FIXED` / `UNITS`), C1-A

**Fecha:** 27/08/2026. Sesión de diseño, sin código. Extiende
`diseno-sena-deposito-fase-a-2026-08-22.md`, que dejó la seña como un único
`percentage`.

> **Prerequisito bloqueante:** `diseno-precio-servicio-vs-recurso-2026-08-27.md`
> (paso 0). `UNITS` sobre el estado actual no tiene líneas por noche que sumar.

---

## 1. Por qué tres formas (mapeo de negocio, 27/08/2026)

La palabra "seña" tapa cuatro objetos económicos distintos:

| Qué es | Para qué sirve | Qué pasa al final |
|---|---|---|
| **Anticipo** | Cobrar por adelantado parte del precio | Se descuenta del saldo |
| **Garantía anti-no-show** | Que la persona no reserve "por las dudas" | Se descuenta si viene, se pierde si no |
| **Cobertura de costo hundido** | El negocio ya gastó antes de que el cliente llegue | Se descuenta |
| **Depósito en garantía** | Cubrir daños (equipos, vehículos, salón) | **Se devuelve entero** |

Los tres primeros son variantes del mismo mecanismo. **El cuarto queda
explícitamente fuera de alcance** — se devuelve completo, sin relación con el
precio; absorberlo rompería el modelo.

### La regla que decide la forma: dispersión del ticket, no el rubro

- **Dispersión angosta** (la más cara vale 2-3× la más barata) → **monto
  fijo**. Un solo número se percibe justo en todo el rango y es
  **comunicable**: "la seña son $2.000" es una política que se dice por
  teléfono. Un % sobre precios variables da montos que nadie cotiza de memoria.
- **Dispersión ancha** (10× o más) → **porcentaje**.

Los híbridos no son negocios raros: son los que **cruzan las dos
dispersiones** con su catálogo.

### Mapeo por rubro

| Rubro | Forma | Razón |
|---|---|---|
| **Hotelería** | `PERCENTAGE` + `UNITS` | Dispersión altísima. Pero la política real más usada es "la primera noche", que **no es expresable como %** |
| **Barbería / turnos** | `FIXED` | Ticket bajo y parejo. La seña es fricción, no anticipo: su tamaño no depende del valor del servicio. Un % de un ticket chico se come en comisiones |
| **Spa** | Híbrido | Manicura $6.000 y day pass $80.000 en el mismo local: 13× de dispersión puertas adentro |
| **Restaurante — mesa** | `FIXED` | **La reserva no tiene precio.** Un % da cero, y una seña de cero es indistinguible de "no cobra seña". Es el rubro que más necesita el mecanismo y el único donde hoy no puede producir ningún número |
| **Restaurante — evento** | `PERCENTAGE` | Valor alto, costo hundido real (mercadería comprada días antes) |
| **Canchas** | `FIXED` (o 100%) | Ticket parejo, el hueco vacío no se recupera |

### Por qué `UNITS` y no solo `PERCENTAGE`

"Seña = N noches de tarifa" (típicamente 1) es la política estándar de
hotelería y **no se puede expresar ni como % ni como monto fijo**: para una
estadía de 4 noches es 25%, para una de 2 es 50%, y el monto en pesos cambia
con la habitación y la temporada. Es una tercera forma: *N unidades de la
tarifa*.

La misma figura cubre "$X por cubierto" en restaurante-evento y "por persona"
en spa de grupos — monto × cantidad de unidades.

**Nota sobre el fundamento.** El argumento decisivo es que "1 noche" es la
política real y un % no puede expresarla. El argumento secundario que se
manejó en la sesión (que el riesgo de cancelación es proporcionalmente mayor
en estadías cortas, y que `UNITS` lo sigue solo) **es discutible en el otro
sentido**: un hueco de 10 noches que se cae a último momento es más difícil de
recolocar que uno de 1 noche. Queda registrado porque importa si algún día se
quiere un piso/techo por rango de noches: si el decaimiento es *deseado* como
cobertura de riesgo se decide distinto que si es la consecuencia aritmética de
una regla elegida por clara y estándar.

### Alcance de UI (decisión del dueño, 27/08/2026)

Las **tres** formas existen en el dato. La pantalla de hoy (tenant Hotel ZULU,
hotelería) expone **solo `PERCENTAGE` y `UNITS`**. `FIXED` queda en el schema
sin UI, para cuando se sumen verticales de ticket parejo (barbería, canchas).

⚠️ **El resolver tiene que implementar las tres desde el día uno.** Solo la UI
está restringida. Una fila `FIXED` puede entrar por un seed, un script o un
endpoint futuro; si el cálculo no la contempla queda una excepción latente
esperando al primer tenant de ticket parejo.

---

## 2. Dónde se resuelve el cálculo

**En `ReservationPricingService.resolveDepositAmount()`, alimentado con las
`lines` que `resolvePrice()` ya produjo.** La cascada de tarifa no se toca.

El encaje ya existe: en `ReservationService.createReservation()`,
`resolveDepositAmount()` se llama ~18 líneas después de `resolvePrice()`, en
el mismo bloque, y ya recibe `totalPrice` de esa misma salida
(`reservation.service.ts` ~línea 233). Sumar `lines` a ese mismo pase es la
misma forma de cambio que ya está.

**Qué garantiza que no se duplique lógica:** el cálculo de seña **nunca
resuelve una tarifa**. No toca `resolveUnitPrice()`, ni
`customerRateRepository`, ni `ratePlanId`, ni la cascada de 5 escalones. Solo
lee una salida ya resuelta. Hay exactamente un lugar que decide cuánto vale
una noche; la seña es consumidora de ese resultado.

### La definición del monto: suma de las primeras N líneas

**`UNITS` = suma de las primeras N líneas.** NO `N × (totalPrice / noches)`.

Hoy los dos dan idéntico, porque todas las líneas llevan el mismo precio
unitario. Pero el docblock de `resolvePrice()` dice que `buildLines()` es *"la
estructura que lo permitiría el día que exista un motor de tarifas por
temporada, no ese motor en sí"*. El día que ese motor exista:

- **"Suma de las primeras N"** sigue significando *"la primera noche"* — lo
  que el hotel dice por teléfono y lo que el huésped ve.
- **"N × promedio"** empieza a significar algo que nadie pidió, y cambiaría en
  silencio la seña de todas las políticas ya configuradas.

Elegirla ahora **cuesta cero** (mismo resultado) y es la única definición que
sobrevive a tarifas por temporada. Beneficio lateral: la seña queda
**explicable** ("tu seña es la noche del 12/01: $45.000") a partir de una fila
de `reservation_lines` que ya existe.

### Dónde NO va

- **No en `resolveUnitPrice()`** — su única razón de cambio es cómo se cotiza
  una unidad.
- **No en el handler del outbox** (`handleReservationConfirmed`) — la seña se
  congela al crear (R9); el handler solo parte el CHARGE.
- **No en el repositorio** — `deposit_policies` devuelve la política, no plata.

---

## 3. `unit_count` mayor a las noches reales → tope, y es estructural

**No hay más líneas que sumar.** Como `totalPrice` es la suma de todas las
líneas, "no tomar más líneas de las que hay" **es** el tope al 100%. La regla
se cae sola de la definición de arriba; no hace falta una regla de dinero
aparte.

Las otras dos opciones no son elegibles:

- **Permitir y listo:** `Reservation.restore()` **ya lanza
  `InvalidReservationError`** si `depositAmount > totalPrice`
  (`Reservation.ts` ~línea 275). No es una mala idea: es una excepción en
  runtime. Y aunque no existiera ese guard, dejaría el saldo en negativo (la
  seña se asienta `SETTLED` y el resto se crea `PENDING` por la diferencia).
- **Error de validación al reservar:** castiga a la parte equivocada. El
  huésped que reserva 1 noche no podría reservar porque el hotel configuró una
  política pensada para estadías largas. Una config del negocio nunca debería
  hacer irreservable un caso legítimo.

**El tope es silencioso, no un warning.** "La seña es 2 noches, o toda la
estadía si es más corta" es exactamente lo que un hotel quiere decir.

**Al escribir la política:** validar `unit_count >= 1` y entero. **Sin techo**
(30 noches puede ser legítimo en un alquiler temporario largo); el tope de
runtime cubre el absurdo. Alcanza con un aviso en la UI tipo *"en estadías de
menos de N noches se cobra la estadía completa"*.

**Consecuencia a decidir a propósito:** cuando el tope actúa, `deposit_amount`
queda igual a `totalPrice` y es **indistinguible de una política del 100%**.
Hoy la reserva congela el monto pero no qué política lo produjo — a diferencia
de las tarifas, donde D7 agregó `applied_customer_rate_id` a `reservations`
exactamente para responder "qué regla ganó". La seña tiene la misma pregunta y
no tiene respuesta, y con tres formas se vuelve más difícil de reconstruir a
mano. **Opción de alcance, no requisito.**

---

## 4. `amount_type` frente al scope de 4 vías

**Un campo más de la misma fila.** No una tabla aparte, no un scope nuevo.

El scope contesta *"¿a qué reservas aplica esta política?"*; el `amount_type`
contesta *"¿cómo se calcula el monto?"*. Son ejes ortogonales de una sola
regla; separarlos obligaría a volver a unirlos en cada resolución y permitiría
estados imposibles (un scope con cero o dos definiciones de monto).

La cascada **no cambia**: `findActiveForResource()` ya elige la fila activa más
específica (ítem > categoría > bucket) y devuelve una fila; ahora esa fila trae
"cuánto" y "cómo". La resolución nunca necesita conocer el tipo.

**Precedente exacto en el repo:** `customer_rates` es `fixed_price` XOR
`discount_percentage` (`chk_customer_rate_pricing_mode`), resuelto en
`resolveRateAmount()` con esta misma estructura — una fila, un modo, una
bifurcación al calcular plata. Tres modos es el mismo patrón con una rama más,
con el CHECK "exactamente uno de N" que el repo ya usó 4 veces (patrón
CASE-based, nunca `scope_type`/`scope_id`).

### La interacción real NO es con los niveles de scope: es con `booking_mode`

`booking_mode` vive en el **BookableService**. El scope de `deposit_policies`
apunta a recurso, categoría, bucket o servicio. **Tres de esos cuatro no
pueden garantizar el modo de reserva:**

| Scope | ¿Garantiza `block`? |
|---|---|
| `service_id` | **Sí** — el servicio lleva el modo, verificable al escribir |
| `resource_id` | No — la misma habitación se reserva con servicio o sin |
| `category_id` | No — mismo motivo, para todos sus recursos |
| `bucket = 'ALOJAMIENTO'` | No — sale de `resource_categories.is_lodging`, que habla de la categoría, no del servicio |

La regla vive en dos lugares:

**Al escribir la política (parcial, barato):**
- `UNITS` + scope `service_id` cuyo servicio no es `block` → rechazar.
- `UNITS` + `bucket IN ('TURNOS','SERVICIOS')` → rechazar **siempre**. Los dos
  son `slot`/`event` por construcción, así que ahí `UNITS` nunca puede
  significar nada.

**Al resolver (autoritativo):** si la política que ganó es `UNITS` pero la
reserva salió con una sola línea, hace falta un comportamiento definido:

| Opción | Qué pasa |
|---|---|
| **a. Caer al default del negocio** ✅ recomendada | Se trata la política como no aplicable y la cascada sigue como si no existiera — el camino ya implementado para "sin política" |
| **b. Tratarlo como 100%** | Con una sola línea, N≥1 toma toda la estadía. Cobra prepago total **en silencio** — el peor resultado |
| **c. Error** | Misma objeción que en la sección 3: una reserva legítima se cae por una config |

Sin esta definición, la primera reserva de habitación cargada sin servicio bajo
una política `UNITS` le cobra el 100% al huésped por adelantado.

---

## 5. `deposit_policies` como MAESTRO — reglas que hoy incumple

Recién al darle UI de alta/edición importa. Clasificación: **MAESTRO** (ente
de configuración que existe con independencia de lo que pase).

| Regla | Estado | Qué hacer |
|---|---|---|
| R1 código de negocio | ❌ sin `code` | **Declarar que no aplica** y por qué: el scope *es* la identidad, y los 4 índices únicos parciales ya impiden el duplicado. Mismo criterio que `afip_tickets` |
| R3 borrado ≠ pausado | ⚠️ tiene `active`, no `deleted_at` | **Decisión pendiente.** Con UI de alta, "pausé la seña de temporada baja" y "cargué mal el %" se vuelven indistinguibles para siempre |
| R4 vigencia | ❌ | Backlog explícito. Un % por temporada lo va a pedir, pero no ahora |
| R8 auditoría | ❌ no pasa por `recordFieldChanges()` | **Sí, con la CRUD.** Cambiar el % de seña es el caso "un cliente discute un cobro". `updateWithAudit()` ya existe (RBAC paso 1) |
| R9 snapshot | ✅ `reservations.deposit_amount` congela | — |

**Hallazgo operativo:** `POST /customers/:id/payments` está gateado por
`ModuleKey.CUENTAS_CORRIENTES`. Un negocio que configure una seña sin ese
módulo se autobloquea: el gate `DepositNotPaidError` impide confirmar y no hay
endpoint para cobrar. La pantalla de configuración necesita ese guard.

---

## 6. Confirmación de negocio (27/08/2026, con el dueño)

Pregunta hecha en los términos del negocio, sin nombrar el modelo: *"si un
cliente te llama y pregunta cuánto tiene que dejar de seña, ¿qué le
contestás?"*

**Respuesta: "una noche".**

Confirma `UNITS` con `unit_count = 1` como el caso real y primario de este
tenant — exactamente el que motivó todo el diseño y el que un `PERCENTAGE` no
puede expresar. Se ratifica el recorte de UI: la pantalla expone `PERCENTAGE`
y `UNITS`; `FIXED` queda en el dato sin pantalla.

---

## 7. Qué falta decidir antes de tocar el schema

1. **Paso 0 completo** (`diseno-precio-servicio-vs-recurso-2026-08-27.md`) —
   bloqueante. Incluye el hilo abierto de su sección 5 (cuántas reservas
   tienen `service_id IS NULL`).
2. El fallback de la tabla de la sección 4 (recomendado: **a**).
3. `deleted_at` en `deposit_policies` (R3) — sí/no.
4. Snapshot de "qué política ganó" (`applied_deposit_policy_id`) — sí/no.
