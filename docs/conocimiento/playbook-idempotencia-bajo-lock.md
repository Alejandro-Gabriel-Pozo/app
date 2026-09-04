# Playbook — idempotencia bajo lock, no antes del lock

- **Fecha:** 2026-09-05
- **Estado:** implementado (`accounts-receivable.service.ts` O2F2-A, `cancellation-refund.service.ts` BRECHA-REFUND-01 Fase 3 + residual #2)
- **Contexto:** el mismo defecto apareció DOS VECES en este repo, en dos servicios distintos, separados por dos días — la segunda vez fue en un código que un revisor (`architecture-governor`) ya había aprobado creyendo que lo evitaba.
- **Categoría:** Playbook de concurrencia financiera (ledger, no disponibilidad de recurso — para eso ver `playbook-locks-exclusividad.md`)
- **Etiquetas:** `A8.1` `A8.2` `postgres` `advisory-lock` `FOR UPDATE` `idempotencyKey` `ABBA`
- **Referencias:** `clientes-finanzas/payment-application.ts` (`acquireIdempotencyLock`, `applyCappedPaymentToInvoice`, `applyCappedRefundToInvoice`); `accounts-receivable.service.ts:321` (comentario O2F2-A); `reservas/cancellation-refund.service.ts` (`confirmRefund()`); `facturacion/sql.invoice.repository.ts` §7.1 (`getOutstandingForUpdate`/`getRefundableForUpdate`).

## Problema — el chequeo de idempotencia corrido ANTES del lock no ve al ganador de la carrera

Patrón recurrente: dos escrituras concurrentes comparten una clave de idempotencia (`idempotencyKey`) para no duplicar. El chequeo típico es "¿ya existe una fila con esta clave? si sí, devolvela; si no, seguí". Si ese chequeo corre **antes** de tomar cualquier lock (advisory o `FOR UPDATE`), el perdedor de una carrera genuina puede leer "no existe" — porque el ganador todavía no hizo commit — y seguir de largo con su propio cálculo completo, calculado sobre un estado que ya cambió. El resultado no es un duplicado con la MISMA clave (eso el `ON CONFLICT`/`getByIdempotencyKey` sí lo frena) — es una fila **nueva**, con una clave derivada distinta (típicamente el sufijo `:sin-asignar`/`:excedente` del remanente) que el ganador nunca creó. Crédito fantasma, no error visible.

**Ocurrió dos veces:**
- **O2F2-A** (`accounts-receivable.service.ts`, 03/09/2026): el perdedor releía `outstanding = 0` (ya descontado por el ganador) y recalculaba `excessAmount` completo otra vez.
- **BRECHA-REFUND-01 Fase 3** (`cancellation-refund.service.ts`, 05/09/2026): el chequeo de reintento se agregó **fuera** de la transacción como único chequeo. `architecture-governor` lo aprobó igual — confirmado y reproducido después con un test de integración real (`concurrencia real CON FACTURA`, ver más abajo) que devolvía dos ids de `REFUND` distintos y 2000 en vez de 1000.

## Receta

1. **Camino rápido, fuera del lock (opcional, solo por costo):** un chequeo de idempotencia antes de la transacción evita pagar el costo completo (lock + N locks de fila) en el caso común de un reintento **en serie**, después de que todo ya terminó y comprometió. Documentar explícitamente que este chequeo NO alcanza para una carrera genuina.
2. **Primera operación de la transacción:** `acquireIdempotencyLock(client, key)` — `pg_advisory_xact_lock(hashtext($1))`. Serializa TODAS las llamadas concurrentes con la misma clave antes de tocar cualquier fila de negocio.
3. **Re-chequeo AUTORITATIVO, inmediatamente después del lock, antes de cualquier otra lectura o lock de negocio:** el mismo predicado que el paso 1, ejecutado de nuevo. Si encuentra algo, devolver eso y cortar — no seguir de largo. Este es el único chequeo que importa; el del paso 1 es una optimización, no una garantía.
4. **Todo lo que determina EL MONTO (no solo si hay que insertar) se relee bajo el lock, después del re-chequeo del paso 3** — no antes de entrar a la transacción. Si una cantidad se calculó afuera y se usa adentro sin releerse, cualquier escritura concurrente que la afecte, y que commitee en la ventana entre el cálculo y el commit de esta transacción, queda invisible. No importa si esa escritura viene de OTRA instancia del mismo método (la carrera "clásica") o de un método completamente distinto que toca los mismos datos (recordPayment tocando el mismo saldo que confirmRefund) — la ventana es la misma, la causa es la misma.
5. **Orden de lock CANÓNICO cuando se toca más de una fila:** ordenar por un campo estable (id, `localeCompare` ascendente) antes de lockear, no en el orden que trae el caller ni el orden de negocio (LIFO, prioridad, etc.). Desacoplar "en qué orden tomamos los locks" de "en qué orden aplicamos la lógica de negocio" — dos loops distintos si hace falta, uno de pre-lockeo canónico y otro de reparto en el orden que tenga sentido para el negocio.
6. **El invariante de orden canónico es CRUZADO entre servicios, no por archivo.** Si dos servicios distintos lockean filas del mismo dominio (ej. `invoices`), los dos tienen que usar el MISMO comparador sobre el MISMO campo — si no, hay ABBA entre ellos aunque cada uno esté "bien" por separado. Verificarlo releyendo el código real de el otro lado, no un comentario que lo describe (ver "Falla de proceso" abajo).

## Qué NO alcanza a proteger este patrón (declarar explícitamente, no prometer de más)

- Una escritura concurrente sobre la MISMA entidad que **no pasa por ningún lock de fila** (ej. un `PAYMENT` genérico contra una reserva, sin `settled_invoice_id`) puede seguir aterrizando en la ventana entre el pre-lockeo de otras filas y el commit final. El lock protege lo que está atado por FK a una fila lockeada (vía `FOR KEY SHARE` implícito del INSERT), no todo lo que comparte la misma clave de negocio.
- La semántica de que un INSERT con FK hacia una fila `FOR UPDATE` espera el commit (`FOR KEY SHARE` conflictuando con `FOR UPDATE`) es comportamiento documentado de Postgres, pero no se verificó empíricamente en ninguno de los dos casos de este repo — dejarlo escrito como inferencia en el comentario del código, no como hecho probado, hasta que alguien escriba el test de bloqueo dedicado (ver "Tareas futuras").

## Falla de proceso encontrada (además de la técnica) — no citar un comentario como evidencia de estado del código

`architecture-governor` aprobó Fase 3 de BRECHA-REFUND-01 citando, dentro de su propio veredicto, un comentario del código que él mismo estaba revisando ("`recordPayment()` lockea en el orden que le manda el caller, no canónico") como si fuera un hecho verificado. Ese comentario estaba desactualizado desde `a2aaf40` (dos días antes) — `recordPayment()` ya ordenaba canónicamente. La corrección llegó recién en la siguiente vuelta, cuando alguien releyó el archivo real en vez de confiar en la prosa que lo describía.

**Regla:** un comentario que describe el comportamiento de OTRO archivo es una afirmación con fecha de vencimiento, no una fuente. Antes de usarlo como base de una decisión (aprobar, diseñar, priorizar), releer el archivo que describe. Esto no es nuevo — es el mismo principio que `audit-before-patch` y "no citar sin ancla verificable" ya exigen para hallazgos de auditoría — pero acá mordió a la propia revisión de arquitectura, no a un hallazgo externo.

## Procedimiento de prueba que funcionó — condiciones de carrera reales sin sleeps ni `Promise.all` con suerte de timing

`Promise.all([callA(), callB()])` prueba que el LOCK sirve (dos llamadas genuinamente simultáneas no duplican), pero no prueba que la lectura de datos bajo el lock sea FRESCA — para eso hace falta controlar exactamente CUÁNDO aterriza la escritura interferente, y `Promise.all` no da ese control.

**Técnica:** envolver un colaborador que el método llama en un punto conocido — idealmente el ÚLTIMO que llama ANTES de entrar a la transacción, en AMBAS versiones del código (la que tiene el bug y la que tiene el fix) — con un objeto que, en su primera invocación, ejecuta la escritura interferente (commit real, sobre `db`/pool, autocommit) y RECIÉN DESPUÉS delega a la implementación real. Ese único hook reproduce, sin condición de carrera real ni temporización, la ventana exacta que separa "leído antes del fix" de "releído después del fix": en el código viejo, la lectura que importa ya pasó cuando el hook dispara (la escritura llega tarde); en el código nuevo, esa lectura vive dentro de la transacción, después del punto donde corre el hook (la escritura llega a tiempo).

Ejemplo real (`cancellation-refund.integration.test.ts`, Escenario A/B): se hookeó `businessProfileRepo.get()` — sin relación de negocio con el bug, elegido únicamente porque es el último colaborador llamado antes de `transactionManager.run()` en las dos versiones del método.

```ts
let fired = false;
const interferingBusinessProfileRepo: Pick<BusinessProfileRepository, 'get'> = {
  async get() {
    if (!fired) {
      fired = true;
      await /* escritura interferente, commit real */;
    }
    return realBusinessProfileRepo.get();
  },
};
```

**Disciplina de verificación:** correr el test contra el código VIEJO primero (`git stash push -- <archivo del fix>`) y confirmar que falla con el síntoma esperado (no solo "falla" — falla con el número/id equivocado que predice el mecanismo). Recién ahí restaurar el fix (`git stash pop`) y confirmar que pasa. Un test nuevo que nunca se vio fallar no prueba que prueba algo — mismo criterio que ya se aplicaba a los tests de concurrencia con `Promise.all` en este repo, extendido acá a los que necesitan orden exacto, no solo simultaneidad.

## Alternativas descartadas

- Mover TODO el cálculo (incluyendo catálogo/config sin relación con la carrera, ej. `findApplicableTier`, `businessProfileRepo.get()`) dentro de la transacción "por las dudas": alarga la ventana en la que la transacción sostiene locks mientras espera dos round-trips de red que no protegen nada. Releer adentro solo lo que la carrera puede afectar.
- Confiar en que `Promise.all` sea suficiente evidencia de que una relectura bajo lock es fresca: prueba el lock, no la frescura de la lectura (ver arriba).

## Tareas futuras

- Extraer el comparador de orden canónico de lock (`(a, b) => a.id.localeCompare(b.id)`) a un helper compartido, o cubrirlo con un test/regla de lint — hoy son dos `.sort()` ad-hoc en archivos distintos (`customer-account.service.ts`, `cancellation-refund.service.ts`) sin nada que avise si un tercer sitio que lockee `invoices` usa un orden distinto. Nota: `reservas/reservation-availability.service.ts:308` ya usa `[...ids].sort()` con comparador **default** (no `localeCompare`) sobre OTRA tabla (`resources`) — dos convenciones de comparador conviven en el repo; copiar la equivocada al añadir un tercer sitio es un error de una línea.
- Escribir el test de bloqueo dedicado que demuestre (o desmienta) la semántica de `FOR KEY SHARE` vs `FOR UPDATE` sobre `invoices` que este playbook asume — hoy es inferencia, no hecho verificado (ver §7.1 en `sql.invoice.repository.ts`, donde una suposición parecida sobre subconsultas correlacionadas ya resultó falsa una vez).
- Cerrar el caso no protegido de "escritura sobre la reserva sin FK a ninguna fila lockeada" (Escenario B de BRECHA-REFUND-01, hoy estrechado, no eliminado).
