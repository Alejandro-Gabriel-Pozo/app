# Developing Defensivo — reglas del proyecto

Este documento es la fuente única de verdad sobre cómo encarar cambios en
este repo. **Todo PR y todo commit deben poder responder las preguntas de
la sección 2** antes de mergear. El objetivo no es burocracia — es que un
bug ya encontrado una vez (ver `CONTRIBUTING.md`, sección de historial) no
vuelva a aparecer porque nadie se acordaba de la regla.

Si trabajás con una IA (Claude, Copilot, etc.) para escribir código en este
repo, pegále el link a este archivo en vez de repetir las reglas en cada
prompt: *"Seguí `docs/DEFENSIVE_DEVELOPING.md`, respondé el checklist de la
sección 2 en el PR."*

---

## 1. Los cinco principios

1. **Fail fast en el borde, no en el medio.** Validar config al arrancar
   (`JWT_SECRET`, `PLATFORM_DATABASE_URL`, etc.) y validar input en la
   frontera de la API (Zod). Un `undefined` que viaja 5 capas y explota en
   un lugar sin contexto es un bug más caro de diagnosticar que el mismo
   bug atajado en el borde.
2. **Que la arquitectura haga imposible el bug, no solo que la disciplina
   lo prevenga.** Si dos cosas no deberían ser intercambiables (ej. el pool
   de la BD de plataforma vs. el pool de un tenant), que el sistema de
   tipos no permita confundirlas — no confiar en que quien escribe el
   siguiente router se acuerde de la regla.
3. **Testear el wiring real, no solo la lógica en aislamiento.** Un test
   que arma sus propias dependencias a mano (mocks, pools de test ad hoc)
   puede pasar en verde mientras el código de producción (`createApp()`,
   los routers reales) está roto. Al menos un test de humo debe pasar por
   el mismo camino que usa producción.
4. **Degradar con ruido, no en silencio.** Si algo entra en un estado
   inesperado (límite superado, tabla faltante, config ausente), lo mínimo
   es un log explícito. Ideal: un error tipado que diga exactamente qué
   se esperaba y qué se recibió.
5. **Un solo camino por responsabilidad.** Si existen dos formas de
   construir lo mismo (dos `TransactionManager`, dos formas de resolver
   `req.db`), el día que una esté mal las dos hay que arreglarlas por
   separado — y es fácil olvidarse de una. Centralizar en un único
   builder/factory.
6. **Una garantía de integridad que deja de vivir en un constraint de la base
   tiene que declararse explícita, no asumirse.** Caso real (D9, 22/08/2026):
   "un solo override de tarifa activo por cliente+ítem" vivía en un índice
   único de Postgres. Al pasar a scope multinivel (bucket/categoría/ítem, con
   filas múltiples por tarifa), esa garantía ya no puede expresarse como
   índice único simple — se resolvió juntando candidatas y ordenando por
   especificidad en la capa de servicio. Si esto no se nombra así de
   explícito en el PR/commit, alguien asume después que sigue tan blindada
   como antes.

---

## 2. Checklist — obligatorio en cada PR

Copiá esta lista en la descripción del PR (el template de GitHub ya la
incluye, ver `.github/PULL_REQUEST_TEMPLATE.md`) y respondé cada punto que
aplíque. Los que no apliquen, marcálos como `N/A` con una razón corta —
"N/A" sin explicación no es una respuesta válida.

- [ ] **¿Qué límite o config del sistema toca este cambio** (pools de BD,
  timeouts, variables de entorno, multi-tenancy) **y se verificó contra
  un ambiente real**, no solo un mock o una BD única de test?
- [ ] **Si cambia la firma de algo público** (función, endpoint, tipo,
  evento de dominio): ¿se actualizaron *todos* los call sites y sus tests
  en el mismo commit?
- [ ] **¿Qué pasa si esto falla a mitad de camino?** (conexión caída,
  timeout, proceso matado) ¿Es atómico? ¿Hay rollback? ¿Puede quedar un
  estado a medias (ej. reserva creada sin evento de dominio)?
- [ ] **¿Este cambio agrega una forma nueva de hacer algo que ya existía**,
  o reemplaza/consolida el único camino existente? Si agrega una nueva,
  justificar por qué no se pudo reusar la existente.
- [ ] **Los tests nuevos, ¿ejercitan el wiring real** (levantando la app o
  el router real) **o solo la lógica de negocio con mocks?** Si solo hay
  tests con mocks, decir explícitamente qué parte del wiring de producción
  queda sin cubrir.
- [ ] **Si este cambio toca secretos o config de entorno**, ¿falla rápido
  y explícito si falta la variable, o puede degradar en silencio (ej. caer
  a `ssl: false` porque `NODE_ENV` no estaba seteado)?
- [ ] **¿Qué se loguea o reporta si esto sale mal en producción?** ¿Alcanza
  para diagnosticar sin acceso a un debugger?
- [ ] **Si vas a hacer `git commit --amend` o reescribir un commit:** ¿corriste
  `git log origin/<rama>..HEAD` para confirmar que nada de eso se pusheó ya?
  Reescribir historia no pusheada es gratis; reescribir historia pusheada no.
- [ ] **Si el ítem es grande o el alcance está ambiguo** (más de una
  interpretación razonable, o toca una decisión de negocio no confirmada):
  ¿existe un doc de diseño en `docs/diseno-*.md` escrito ANTES de tocar
  código, no en paralelo?

---

## 3. Preguntas específicas de este proyecto (multi-tenant)

Además del checklist genérico, todo cambio que toque `src/api/routes/`,
`src/container.ts`, `src/platform/` o `src/workers/` debe responder:

- [ ] ¿Este código corre contra `req.db` (BD del **tenant**) o contra
  `getPlatformRawPool()` / `PLATFORM_DATABASE_URL` (BD **central**)? ¿Es el
  que corresponde?
- [ ] Si abre una transacción (`TransactionManager.run(...)`), ¿el pool con
  el que se construyó ese `TransactionManager` es el mismo que el de los
  repos que participan en esa transacción?
- [ ] Si emite o consume domain events, ¿el `DomainEventRepository` apunta
  a la misma BD donde se escribió el evento?

Estas tres preguntas existen porque los tres bugs críticos encontrados en
el review de agosto 2026 fueron, en el fondo, la misma confusión repetida:
mezclar el pool de plataforma con el del tenant. Ver el informe completo
en `code-review-reservations-api.md` para el detalle de cada caso.

---

## 4. Cómo usar esto con una IA asistente

Prompt sugerido al pedirle un cambio a la IA:

> Implementá [tarea]. Seguí `docs/DEFENSIVE_DEVELOPING.md` — en particular,
> si tocás `req.db`, `PLATFORM_DATABASE_URL` o algún `TransactionManager`,
> respondé las preguntas de la sección 3 antes de dar el cambio por
> terminado. Completá el checklist de la sección 2 en la descripción del
> commit o PR.

Así no hace falta repetir las reglas en cada conversación — el archivo es
el contexto persistente.
