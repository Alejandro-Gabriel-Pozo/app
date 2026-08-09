<!--
  Este template se carga automáticamente al abrir un PR en GitHub.
  Ver docs/DEFENSIVE_DEVELOPING.md para el detalle de cada pregunta.
  Un PR sin este checklist respondido no se mergea.
-->

## Qué cambia y por qué

<!-- 2-3 líneas. Si esto viene de un bug, linkear el issue o describirlo. -->

## Checklist de developing defensivo

- [ ] **Límites/config:** ¿qué límite o config del sistema toca este
  cambio (pools de BD, timeouts, env vars, multi-tenancy) y se verificó
  contra un ambiente real?
- [ ] **Firma pública:** si cambia una firma (función/endpoint/tipo/evento),
  ¿se actualizaron todos los call sites y sus tests en este mismo commit?
- [ ] **Fallo a mitad de camino:** ¿qué pasa si esto falla en el medio
  (conexión caída, timeout, proceso matado)? ¿Es atómico? ¿Puede quedar un
  estado a medias?
- [ ] **Un solo camino:** ¿esto agrega una forma nueva de hacer algo que ya
  existía, o consolida la existente? Si agrega una nueva, ¿por qué no se
  pudo reusar?
- [ ] **Cobertura real:** ¿los tests nuevos ejercitan el wiring real
  (app/router levantado) o solo lógica con mocks? Si es solo mocks, ¿qué
  parte del wiring de producción queda sin cubrir?
- [ ] **Secretos/config:** ¿falla rápido y explícito si falta una variable
  de entorno, o puede degradar en silencio?
- [ ] **Diagnóstico:** ¿qué se loguea si esto sale mal en producción?

### Si este PR toca `src/api/routes/`, `src/container.ts`, `src/platform/` o `src/workers/`

- [ ] ¿Corre contra `req.db` (tenant) o `getPlatformRawPool()` (plataforma)?
  ¿Es el que corresponde?
- [ ] Si abre una transacción, ¿el pool del `TransactionManager` es el
  mismo que el de los repos que participan?
- [ ] Si emite/consume domain events, ¿el `DomainEventRepository` apunta a
  la misma BD donde se escribió el evento?

## N/A

<!-- Para los ítems que no apliquen, listalos acá con una razón corta. -->
