# Criterios de integridad de datos — estándar ERP

Reglas de cumplimiento obligatorio para cualquier entidad del sistema. No son
sugerencias: cada una existe porque su ausencia produce un modo de falla
conocido.

> Origen: hallazgo del 13/08/2026 — un bug de categorías fantasma (`resource_categories`
> desactivada volvía invisible para `findById`, dejando recursos huérfanos) llevó a esta
> auditoría completa. Ver también `docs/criterios-negocio.md` para las otras nueve
> dimensiones (tenant, dinero, tiempo, estados, privacidad, concurrencia, etc.).

---

## PARTE 1 — La clasificación que ordena todo

Un ERP no trata a todas las entidades igual. Las divide en tres clases con
reglas incompatibles entre sí. **Antes de crear cualquier tabla nueva hay que
declarar a qué clase pertenece.**

| | **MAESTRO** | **TRANSACCIÓN** | **DOCUMENTO** |
|---|---|---|---|
| Qué es | Un ente que existe con independencia de lo que pase | Un hecho que ocurrió en el tiempo | Una declaración formal emitida |
| Ejemplos tuyos | `Customer`, `PhysicalResource`, `ResourceCategory`, `BookableService`, `Product`, `Tag`, `Business` | `Reservation`, `Stay`, `Order`, `HousekeepingTask`, `StockMovement`, `FinancialTransaction` | Facturas AFIP, notas de crédito *(aún no existen)* |
| ¿Se borra? | **Nunca.** Se desactiva o se marca borrado | **Nunca.** Se cancela o se revierte | **Jamás.** Se anula con otro documento |
| ¿Se edita? | Sí, con auditoría del valor anterior | Solo antes de confirmarse | Nunca, ni un carácter |
| Identidad | ID técnico + **código de negocio** | ID técnico + correlativo | **Numeración correlativa e irrompible**¹ |
| Tiene vigencia | Sí (`válido desde/hasta`) | No, ocurrió y punto | No |
| Depende del presente | Sí, refleja el estado actual | **No.** Congela lo que necesitó | No |

**El error de raíz:** tratás a `ResourceCategory` (maestro) con la misma
lógica que a cualquier fila. Un maestro tiene reglas de ciclo de vida que una
fila común no tiene, y ahí es donde se te escapó.

¹ *Confirmado por comparación externa (14/08/2026, ver
`Gap analysis - Tango ERP vs modelo actual.md`): en un ERP con esta regla ya
madura (Tango), la numeración correlativa es **por talonario**, es decir por
tipo de comprobante — Factura A, Factura B, Nota de Crédito son secuencias
independientes, no una sola numeración global. Cuando exista el primer
DOCUMENTO real (facturación AFIP, `ModuleKey.FACTURACION`), la tabla que lo
implemente necesita esa granularidad desde el diseño inicial, no como
migración posterior — cambiar de "una secuencia" a "una secuencia por tipo"
después de tener comprobantes emitidos es mucho más caro que decidirlo antes
de la primera fila.*

---

## PARTE 2 — Reglas de maestros

### R1. Todo maestro tiene código de negocio, además del ID técnico

Son dos identidades distintas y hacen falta las dos:

| | ID técnico | Código de negocio |
|---|---|---|
| Ejemplo | `cat-salon-1786532846057` | `SALON` |
| Para | Foreign keys, sistema | Humanos, reportes, búsqueda, importación |
| Visible | No | Sí, siempre |
| Editable | Nunca | Nunca (esa es la gracia) |
| Único | Por construcción | **Por constraint, dentro del negocio** |

**Esto es lo que te hubiera evitado las tres "Salon".** Con UUIDs, nada
impide tres filas idénticas para el ojo humano. Con código, la segunda alta
choca contra el índice único y el usuario ve *"el código SALON ya existe"*.
El nombre puede repetirse; el código no.

Regla operativa: el nombre es descriptivo y editable, el código es identidad
y es inmutable. Si el usuario se equivocó al elegir el código, se crea uno
nuevo y se fusiona (R7).

### R2. Un maestro que participó de una transacción es permanente

Desde que una `Reservation` apunta a un `PhysicalResource`, ese recurso
**existe para siempre**. Se puede desactivar, no se puede hacer desaparecer.

Corolario obligatorio: **`findById` nunca filtra por estado.** Buscar por ID
significa "dame esta fila", no "dame esta fila si todavía me gusta". El
filtro por activo va en `findAll` y en los selectores de alta, jamás en la
búsqueda directa.

*Estado 13/08/2026: `bookable_services` cumplía. `resource_categories` y
`resources` no — causa directa del bug de categorías fantasma, y de que
`SqlReservationRepository.rowToReservation()` podía tirar `ResourceNotFoundError`
al leer una reserva histórica cuyo recurso ya se había desactivado. Corregido
el 13/08/2026.*

### R3. `borrado` y `pausado` son estados distintos

Un booleano `active` no alcanza porque colapsa dos cosas con reglas
opuestas:

| | Pausado | Borrado |
|---|---|---|
| Vuelve | Sí, es temporal | No |
| Aparece en selectores | Puede, en gris | Nunca |
| Libera el código/nombre | No | Sí |
| Motivo | Vacaciones, fuera de servicio, temporada | Error de carga, ya no se ofrece |

Mínimo: `active BOOLEAN` (pausado/disponible) + `deleted_at TIMESTAMPTZ`
(borrado).

**Esta información se pierde en el momento de escribir.** Ninguna migración
futura puede recuperar si un `active = FALSE` de hace ocho meses fue una
pausa o un borrado.

*Estado 13/08/2026: agregado `deleted_at` a `resource_categories`, `resources`
y `bookable_services`. Las 7 categorías existentes al momento del hallazgo se
clasificaron a mano — ver commit de esa fecha para el detalle.*

### R4. Los maestros tienen vigencia, no solo un flag

Para todo lo que cambia con el tiempo —tarifas, horarios, contratos,
disponibilidad de un empleado— el modelo correcto es `valid_from` /
`valid_to`, no un booleano.

Diferencia práctica: con booleano no podés responder *"¿cuánto costaba esto
el 3 de marzo?"*. Con vigencia sí, y esa pregunta te la va a hacer un
cliente que discute un cobro.

*Estado: no implementado. Backlog — "cuando duela".*

### R5. Desactivar exige un plan para los dependientes

Nunca en silencio. Al desactivar un maestro con hijos activos, el sistema
ofrece:

1. **Bloquear** — si hay transacciones futuras comprometidas (reservas
   confirmadas)
2. **Cascada** — desactivar también los hijos, con conteo explícito y
   confirmación
3. **Reasignar** — mover los hijos a otro maestro antes de desactivarlo

Si todos los dependientes ya están inactivos, pasa sin fricción.

> No bloquees a secas. El día que retires toda una sección vas a necesitar
> borrar la categoría con sus recursos, y si el sistema te lo impide vas a
> terminar renombrándola `"Mesas VIEJO"` — que es peor que el bug original.

*Estado: no implementado. Backlog — "esta semana".*

### R6. Normalización en la escritura, unicidad en la base

Al guardar: `trim`, colapso de espacios múltiples, y forma comparable sin
acentos ni mayúsculas para el índice.

```sql
CREATE UNIQUE INDEX resources_code_uniq
  ON resources (business_id, upper(btrim(code)))
  WHERE deleted_at IS NULL;
```

**En la base, no en el servicio.** Un chequeo en la capa de servicio es
read-then-write: dos requests concurrentes lo pasan los dos. Es el mismo
problema de carrera que ya resolviste con `FOR UPDATE` en solapamiento de
reservas.

Excepción deliberada: **`Customer` no lleva unicidad de nombre.** Dos
clientes reales se pueden llamar igual. Ahí va detección de similitud +
merge, no bloqueo.

*Estado: no implementado. Backlog — "esta semana", depende de R1 (código de
negocio).*

### R7. La fusión es una operación de primera clase

Los duplicados van a existir igual. Un ERP no los previene solamente: los
**repara**.

`merge(origen, destino)` reapunta todas las transacciones del origen al
destino, marca el origen como fusionado (conservando el puntero, no
borrándolo) y deja asiento de auditoría. Sin esta operación, un duplicado
con reservas y movimientos financieros colgando es irreparable, y ahí es
donde nacen los `"Salon (no usar)"`.

*Estado: no implementado. Backlog — "cuando duela".*

### R8. Todo cambio de maestro deja rastro

Quién, cuándo, qué campo, valor anterior y nuevo. Cuando un cliente discuta
un precio, la respuesta *"no sé quién lo cambió"* no sirve.

`domain_events` **no cubre esto**: es un outbox, se despacha y se marca. Un
log de auditoría es una tabla append-only que nadie consume en tiempo real.

*Estado: no implementado. Backlog — "este mes". Confirmado de nuevo el
14/08/2026 contra `schema.sql` real: no existe ninguna tabla `audit_log` ni
equivalente — comparación externa contra Tango (ver
`Gap analysis - Tango ERP vs modelo actual.md`) usada como validación
independiente de que esta regla, ya escrita acá, es exactamente la que un
ERP maduro no deja pendiente. Nivel mínimo viable si se prioriza: no hace
falta el modelo completo de Tango (auditoría configurable campo por campo,
`CampoAuditable`) — alcanza con una tabla genérica
`(entity, entity_id, field, old_value, new_value, changed_by, changed_at)`
poblada desde la capa de repositorio, no por-entidad.*

---

## PARTE 3 — Reglas de transacciones

### R9. Una transacción congela lo que necesita del maestro

La regla más importante de todas. Una transacción **no debe depender del
estado presente** de los maestros que referencia.

Al confirmar, copia a sus propias columnas: precio, impuestos, **nombre**,
código, y datos fiscales del cliente.

*Ya se hace con `unitPrice` (snapshot inmutable) — está perfecto. Pendiente
verificar si también se congela el **nombre**: si no, renombrar "Barbero
Isahia" a "Barbero Juan" reescribe la historia de todas las reservas
pasadas.*

### R10. El estado del maestro no afecta transacciones históricas

Desactivar un recurso no invalida ni oculta las reservas que lo usaron.
Consecuencia directa de R2 + R9.

*Estado 13/08/2026: roto hasta el fix de R2 (ver arriba) — una reserva cuyo
recurso se desactivaba dejaba de poder leerse. Corregido junto con R2.*

### R11. Bloqueo hacia adelante, nunca hacia atrás

Un maestro inactivo **no se puede usar en transacciones nuevas**. Las
existentes siguen intactas y visibles.

*Estado 13/08/2026: implementado explícitamente en `ReservationService`
(`createReservation`, `checkAvailability`, `assertAllResourcesAvailable`) y
en `resources.routes.ts` (validación de categoría al crear/editar recurso) —
antes esto lo hacía, sin querer, el filtro de `active` dentro de `findById`/
`getById`, que R2 obligó a sacar de ahí.*

### R12. Corregir es revertir, no editar

Una transacción confirmada no se modifica: se cancela o se contra-asienta, y
se crea la corregida. El histórico queda con ambas.

Aplica con fuerza de ley a `FinancialTransaction` y `OrderItem`. Idealmente
revocado a nivel Postgres, no solo por disciplina en la capa de servicio.

*Estado: `financial_transactions` solo hace `UPDATE ... SET status`, nunca
toca `amount` — cumple en la práctica. No hay revoke a nivel Postgres
todavía.*

### R13. Idempotencia en toda creación

Clave de idempotencia generada por el cliente antes del POST. Mata el doble
click, el reintento por timeout y el duplicado por red inestable.

*Ya se hace en pagos (`FinancialTransaction.idempotencyKey`). Backlog:
extenderlo a las altas de maestros y de transacciones.*

---

## PARTE 4 — Reglas de sistema

### R14. Un solo camino de escritura

Toda alta o modificación pasa por la capa de servicio con sus validaciones.
Nada de seeds, imports, scripts administrativos o endpoints de reparación
que escriban directo contra la tabla.

⚠️ *`POST /api/admin/repair-tenant-db` es exactamente el riesgo que esta
regla previene — apunta la connection string del negocio, no escribe datos
de negocio directamente. Pendiente auditar si hay otro camino que sí lo
haga.*

### R15. Las referencias rotas fallan fuerte

Si un FK apunta a algo inexistente, error ruidoso. Nunca degradar a `null`,
a string vacío o a `"—"` en la UI. El silencio es lo que convirtió el bug de
categorías en algo que se descubrió meses después y por casualidad.

### R16. Los límites de plan se cuentan sobre lo que existe

Si `PLAN_LIMITS` cuenta solo activos, se crean infinitos inactivos sin tocar
el tope. El conteo debe incluir todo lo no borrado, y aplicarse dentro de la
misma transacción que el INSERT (no `SELECT COUNT` y después `INSERT`).

*Estado 13/08/2026, confirmado por diagnóstico: `countActive()` en
categorías y recursos excluye correctamente `active = FALSE`, pero
`POST /api/resources` **no llama a `PLAN_LIMITS` en absoluto** —
`maxResources` está definido en `plan-limits.ts` y nunca se aplica. Y el
chequeo que sí existe (categorías) es `SELECT COUNT` + `INSERT` sin
transacción — dos altas simultáneas lo pasan las dos. Backlog.*

---

## PARTE 5 — Checklist para tabla nueva

Antes de escribir el `CREATE TABLE`:

- [ ] ¿Es maestro, transacción o documento? *(no se avanza sin esto)*
- [ ] Si es maestro: ¿tiene `code` único además del ID?
- [ ] Si es maestro: ¿`active` y `deleted_at` separados?
- [ ] Si es maestro: ¿necesita `valid_from`/`valid_to`?
- [ ] ¿`findById` está libre de filtros de estado?
- [ ] ¿Hay índice único parcial sobre la forma normalizada?
- [ ] ¿Se normaliza al escribir (trim, espacios, case)?
- [ ] ¿Qué pasa al desactivarlo con hijos activos? *(bloquear/cascada/reasignar)*
- [ ] Si es transacción: ¿qué congela del maestro? *(precio **y nombre**)*
- [ ] ¿El POST acepta clave de idempotencia?
- [ ] Dinero en `NUMERIC(12,2)` o centavos enteros, jamás float
- [ ] Fechas en `TIMESTAMPTZ`
- [ ] ¿Los cambios quedan auditados?

---

## PARTE 6 — Cómo evitar que se degrade

Las reglas escritas se olvidan. Estas se hacen cumplir solas:

**Test de arquitectura.** Recorre `src/repositories/*` y falla si algún
`findById`/`getById` menciona `active` o `deleted_at` en el `WHERE`. Feo y
efectivo. *(Backlog — "esta semana".)*

**Constraints en la base.** Todo lo que se pueda expresar como índice único
parcial o `CHECK` va ahí, no en TypeScript. La base no se olvida ni tiene
condiciones de carrera.

**Instrucción permanente para la IA.** Ver `CLAUDE.md` de este repo.

---

## PARTE 7 — Estado de cumplimiento (actualizado 13/08/2026)

| Regla | Estado |
|---|---|
| R1 código de negocio | ❌ Ningún maestro lo tiene. Causa directa de las tres "Salon" |
| R2 `findById` sin filtro | ✅ Corregido 13/08/2026 en `resources` y `resource_categories`. `bookable_services` ya cumplía |
| R3 borrado ≠ pausado | ✅ `deleted_at` agregado 13/08/2026 en las 3 tablas maestro con el bug conocido |
| R4 vigencia | ❌ No existe |
| R5 plan para dependientes | ❌ Desactiva en silencio |
| R6 unicidad normalizada | ❌ Sin constraint en maestros |
| R7 fusión | ❌ No existe |
| R8 auditoría de cambios | ❌ `domain_events` es outbox, no audit log |
| R9 snapshot | ⚠️ Precio sí, nombre por verificar |
| R10 histórico intacto | ✅ Corregido junto con R2 |
| R11 bloqueo hacia adelante | ✅ Implementado explícitamente 13/08/2026 (antes lo hacía sin querer el filtro que R2 sacó) |
| R12 revertir no editar | ✅ En la práctica (`financial_transactions` solo cambia `status`). Sin revoke a nivel Postgres |
| R13 idempotencia | ⚠️ Solo en pagos |
| R14 un camino de escritura | ⚠️ Verificar `repair-tenant-db` a fondo |
| R15 fallo ruidoso | ✅ Corregido junto con R2 — antes la categoría fantasma fallaba en silencio |
| R16 límites sobre lo existente | ❌ `maxResources` nunca se aplica; el chequeo de categorías tiene carrera |

### Orden sugerido

**Hecho 13/08/2026:** R3 `deleted_at` + clasificación manual de las 7
categorías + R2 sacar el filtro de `findById`/`getById` + R11 explícito +
R15 (fail loud en vez de fantasma).

**Esta semana:** R1 código de negocio en maestros — es una migración con
backfill, más barata ahora que nunca. R6 índices únicos (depende de R1). R5
guard con confirmación. El test de arquitectura de R2.

**Este mes:** R9 snapshot de nombre, R8 auditoría, R13 idempotencia general,
R16 (aplicar `PLAN_LIMITS` a recursos + serializar el chequeo).

**Cuando duela:** R4 vigencia, R7 fusión.
