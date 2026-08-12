# Conocimiento del negocio y la operación diaria

> Documento vivo. No es una spec técnica — es el contexto de negocio real que
> venimos estableciendo sesión a sesión, para que diseñar features nuevas parta
> de cómo opera el negocio de verdad, no de suposiciones. Cuando aparezca una
> regla, un caso límite o una corrección del dueño en una conversación, se
> agrega acá. Ver también `docs/roadmap-pms-multirubro.md` (qué falta construir)
> y `docs/logica-recursos-categorias-reservas.md` (diseño técnico del core).

## Cómo leer esto

Cada regla nueva debería poder rastrearse a una conversación real (no inventar
"para completar"). Si algo quedó ambiguo, se anota como pregunta abierta en vez
de asumir.

---

## 1. Rubros que atiende el mismo sistema

El core (`resources`, `bookable_services`, `resource_locks`, `reservations`,
`customers`) es el mismo para cualquier rubro — lo que cambia es cómo se
interpreta cada pieza:

| Concepto | Hotelería | Barbería / spa |
|---|---|---|
| `resource` (recurso físico) | Una habitación | Una silla, un box, **o un empleado** (el barbero es un recurso) |
| `bookable_service` | "Noche de hotel" — `bookingMode: 'block'`, se cobra × noche | "Corte", "Barba" — `bookingMode: 'slot'`, duración fija en minutos |
| Horario | No aplica — una habitación no "abre y cierra", solo se ocupa por fechas | Sí aplica — hay horario de atención y turnos dentro de esas horas |
| `resource_locks` | Poco frecuente (una habitación no suele compartir recurso con otra) | Frecuente: "Corte" puede bloquear la silla elegida + el barbero, si ambos son recursos separados |

Un recurso puede representar tanto un espacio físico (silla, habitación) como
una **persona** (el barbero, la estilista) — esto es clave para el diseño de
horarios (sección 3): el horario "propio" de un recurso normalmente es el
horario de ESA PERSONA, no de un mueble.

---

## 2. Reglas de negocio confirmadas

- **La duración de un servicio no se edita al reservar.** Si un cliente
  necesita una duración distinta a la configurada, se crea un servicio nuevo
  ("Corte largo" aparte de "Corte"), no se permite pisar la duración en la
  reserva. Mantiene los datos estructurados y la disponibilidad calculable.
- **El horario de atención cascadea: negocio → recurso.** El negocio tiene un
  horario por defecto ("Mi Negocio"). Un recurso puntual (típicamente una
  persona: un barbero) puede tener horario propio, que REEMPLAZA (no combina)
  el del negocio para ese recurso. Ejemplo real: negocio abre 8-18, un barbero
  puntual solo trabaja 14-18 — para ESE barbero, los turnos disponibles son
  solo dentro de 14-18, nunca 8-14. Cuántos turnos entran en esa ventana
  depende de la duración del servicio elegido (4 cortes de 1hs, o 2 cortes +
  1 servicio de 2hs, etc.). Esto es "capacidad operativa": recurso × ventana
  horaria × duración del servicio.
- **A las empresas se les factura a la empresa, no al agente/contacto.**
  Cuando un cliente es una empresa, el nombre y contacto (`Customer`) puede
  ser la persona que hace la reserva, pero los datos de facturación (razón
  social, CUIT) son de la empresa — son dos cosas distintas que hay que poder
  cargar por separado.
- **La condición frente al IVA no es texto libre.** ARCA/AFIP define
  categorías fijas (Responsable Inscripto, Monotributo, Exento, Consumidor
  Final, No Responsable, y variantes más específicas). Cuando se integre
  facturación electrónica de verdad, hay que reconciliar contra la lista
  oficial de ARCA (webservice `FEParamGetCondicionIvaReceptor`, RG 5259) —
  hoy se usa un subconjunto razonable, no definitivo.
- **Cancelación de una reserva `CONFIRMED` tiene ventana de 24hs.** Si faltan
  menos de 24hs para el `startTime`, no se puede cancelar desde el portal del
  cliente (`CANCELLATION_TOO_LATE`, 422) — sí puede cancelarla el staff.
- **Tarifas especiales priorizan servicio sobre recurso.** Si un cliente tiene
  tarifa especial en un servicio Y en el recurso que ese servicio usa, gana la
  del servicio (es más específica).
- **Un negocio no necesita usar todo el sistema.** Un negocio sin
  `bookable_services` configurados sigue funcionando con reservas simples de
  recurso + horario libre — nada de esto es obligatorio.

---

## 3. Escenarios operativos típicos ("momentos")

### Barbería — reservar un corte
1. Cliente (o recepción) elige el servicio ("Corte corto", 1hs, `slot`).
2. Elige un recurso — puede ser una silla, o directamente un barbero si el
   negocio modela a sus empleados como recursos.
3. El sistema calcula los turnos disponibles ese día para ESE recurso, según
   su horario propio (o el del negocio si no tiene uno cargado) y la duración
   del servicio elegido.
4. Cliente elige turno → se crea la reserva con `serviceId` + `resourceId` +
   horario exacto (no se puede editar la duración después).
5. Al momento del turno, el staff puede confirmar/completar la reserva. El
   precio se resuelve automáticamente (tarifa especial del cliente si tiene,
   si no el precio de catálogo del servicio).

### Hotel — estadía de varias noches
1. Recepción (o el cliente desde el portal) elige el servicio de alojamiento
   (`bookingMode: 'block'`) y la habitación (recurso).
2. Elige check-in y check-out por FECHA, no por hora — el sistema cuenta
   noches por día calendario (un check-in 15:00 y check-out 10:00 del día
   siguiente son 1 noche, no una fracción).
3. El precio se calcula como tarifa unitaria × noches (con tarifa especial si
   el cliente la tiene).
4. Al llegar el huésped, se hace check-in (`Stay`) contra la reserva
   confirmada — esto dispara housekeeping para cuando se desocupe.
5. Al irse, check-out — la habitación queda pendiente de limpieza.
6. Los consumos extra durante la estadía (bar, room service) hoy NO se cargan
   automáticamente a la cuenta del huésped — "cargo a la habitación" es una
   feature pendiente (ver roadmap), se cobra aparte por ahora.

### Cliente empresa — facturación
1. Un cliente se marca como `kind: COMPANY`.
2. Se cargan sus datos de facturación (razón social, CUIT, condición IVA) —
   son de la empresa, no de la persona que reserva.
3. Cuando exista facturación electrónica real (proyecto aparte, ver roadmap),
   la factura sale a nombre de esos datos, no del nombre de contacto.

---

## 4. Glosario

- **Recurso (`resource`)** — lo que se reserva: una habitación, una silla, o
  una persona (barbero, estilista) si el negocio los modela así.
- **Servicio (`bookable_service`)** — lo que se ofrece sobre un recurso, con
  su propia duración y precio de catálogo. `bookingMode`: `slot` (duración
  fija en minutos, ej. corte), `block` (por fechas completas, ej. noche de
  hotel), `event` (horario fijo tipo tour — hoy sin usar en la práctica).
  Estos son conceptos ya explicados en `docs/logica-recursos-categorias-reservas.md`.
- **Tarifa especial (`customer_rates`)** — precio negociado para un cliente
  puntual, sobre un recurso o un servicio específico, que reemplaza el precio
  de catálogo.
- **Cuenta corriente** — saldo acumulado de un cliente (cargos por reservas
  confirmadas menos pagos/reembolsos), independiente de la factura formal.
- **Cliente especial** — cliente con etiquetas (`tags`, ej. "VIP",
  "Corporativo") y/o tarifas especiales configuradas.
- **Horario de atención** — ventanas de tiempo (por día de semana) dentro de
  las que se pueden generar turnos para servicios `slot`. Existe a nivel
  negocio (default) y a nivel recurso (override opcional).

---

## 5. Preguntas abiertas / pendientes de confirmar

- ¿Los recursos que representan personas (barberos, estilistas) necesitan
  algún dato propio además del horario (ej. especialidad, comisión)? No
  preguntado todavía.
- ¿Una empresa puede tener varios contactos/agentes que reservan en su
  nombre, o es siempre un cliente = una persona con un perfil de facturación
  de empresa colgado? Hoy el modelo es 1 cliente = 1 perfil de facturación
  (ver Fase 6 del plan de cuentas corrientes) — no se armó un concepto
  separado de "empresa" con múltiples contactos.
