# M13 · Portal de clientes

**Auditado:** 02/09/2026 · **Método:** `00-programa-v2.md`
**Módulo nuevo en v2** — v1 no lo tenía en el inventario.

## 1. Flujo auditado

registro → login → búsqueda de disponibilidad → reserva → consulta de mis
reservas → modificación → cancelación → baja de cuenta

## 2. Estado

- **Módulo:** ⚠️ Revisado con brechas
- **Flujo "reservar desde el portal":** ✅ Completo
- **Flujo "ownership: que un cliente no vea lo de otro":** ◇ Parcial — el
  control existe y no tiene cerca ni test negativo
- **Flujo "pagar desde el portal":** ◌ No existe

## 3. Último paso confirmado / primer paso incompleto

- **Último paso confirmado:** la baja de cuenta. `DELETE /api/customer/me`
  existe (`src/api/routes/customer.routes.ts:593`) y tiene test propio
  (`src/tests/security/customer.delete.account.test.ts`).
- **Primer paso incompleto:** **el pago**. El cliente puede reservar y no puede
  pagar: no hay ningún endpoint de cobro bajo `/api/customer/*`
  (`datos/cobertura.csv`, 12 endpoints, ninguno financiero). La seña se cobra
  por mostrador.

## 4. Severidad máxima

**S1** — por el ownership sin cerca, no por el pago. El pago es una capacidad
ausente conocida (`C1-Fase B`, bloqueada por decisión de proveedor); el
ownership es una superficie de seguridad sin verificación automática.

## 5. Superficie

| Pieza | Ubicación |
|---|---|
| Rutas | `src/api/routes/customer.routes.ts:1` — 12 endpoints |
| Auth | `src/security/customer.auth.service.ts` |
| Tabla | `customers` con `password_hash` nullable (`src/db/schema.sql:323`) |
| Pantallas | `portal/[businessSlug]` + `/login`, `/register`, `/disponibilidad`, `/cuenta/perfil`, `/cuenta/reservas` |
| Cliente HTTP | `appfrontend-main/src/lib/customerApi.ts:135` |

## 6. Identidad

`[V]` **El cliente del portal y el cliente del negocio son la misma fila.**
`password_hash` es nullable a propósito: un cliente walk-in creado por el staff
no tiene contraseña, y el login chequea `!rows[0]?.password_hash`
(`src/db/schema.sql:309`, `:323`). La decisión está documentada en el schema con
el caso que la motivó.

Es una decisión de modelado fuerte y correcta: no hay dos entidades "cliente"
que después haya que reconciliar.

`[V]` El cliente tiene identidad operativa (`customer_number`, `CLI-nnnnnn`) —
ver `fichas/T01-identidad.md`. **El portal no la muestra** `[H]`: no se verificó
pantalla por pantalla en esta corrida.

## 7. Estados

`[V]` La sesión del portal usa cookie httpOnly de dominio entero (`path: '/'`),
y por eso `GET /me` acepta `?businessSlug=X`: un cliente logueado en el negocio
A que visita el portal de B tiene que verse **no logueado**, no logueado con los
datos de A (`src/api/routes/customer.routes.ts:526`). El chequeo compara el
`businessId` del token contra el slug pedido y responde `401 Sesión de otro
negocio` (`src/api/routes/customer.routes.ts:545`).

Es una de las mejores piezas de razonamiento de seguridad del repo, y está
resuelta.

## 8. Documentos y movimientos

`[V]` El portal no genera documentos ni movimientos. Una reserva hecha desde el
portal produce su `CHARGE` por el mismo camino que las del mostrador (outbox).

## 9. Saldos y reportes

`[V]` El cliente **no ve su saldo**. `GET /api/customers/:id/account` es
`FRONT_DESK` (`src/clientes-finanzas/customers.routes.ts:818`) y no hay
equivalente bajo `/api/customer/me`. Quien debe plata no tiene forma de
enterarse desde el portal.

## 10. Permisos y segregación

`[V]` Arquitectura de acceso en tres capas, todas verificadas:

1. Rutas públicas (registro, login, disponibilidad) sin guard, montadas antes de
   `authenticate()` (`src/app.ts:274`).
2. `router.use(authenticate(), authorize(Roles.CUSTOMER_ONLY))` a partir de
   `/logout` (`src/api/routes/customer.routes.ts:503`).
3. `requireCustomerId(req, res)` dentro de cada handler, que es lo que ata la
   operación al cliente del token (`src/api/routes/customer.routes.ts:303`).

`[V]` El `req.db` se resuelve con un middleware propio del router, porque
`tenantMiddleware` no corre sobre este montaje e ignora `role=CUSTOMER`
(`src/api/routes/customer.routes.ts:508`). Decisión declarada.

`[V]` **La capa 3 no tiene cerca.** `rbac-route-coverage.test.ts` valida
`authorize()`/`router.use()`, no un chequeo dentro del handler: si alguien
agrega `GET /me/invoices` y se olvida de `requireCustomerId`, ninguna cerca
falla. ↔ `RBAC-OWN-001`, que es exactamente este hueco.

## 11. Auditoría y trazabilidad

`[V]` Ninguna acción del portal deja rastro en `audit_log`: ni el registro, ni
la reserva, ni la cancelación, ni la baja de cuenta. Una baja de cuenta es
irreversible y no queda registrada. ⊃ `A2-T03-001`.

## 12. Errores, idempotencia y fallo parcial

`[V]` `customerApi.ts` implementa reintento con backoff exponencial
(1,5 s → 3 s → 6 s) del lado del cliente
(`appfrontend-main/src/lib/customerApi.ts:23`). **Sin clave de idempotencia**:
un reintento de `POST /me/reservations` sobre una respuesta perdida puede crear
dos reservas. El backoff está del lado que reintenta y la protección debería
estar del lado que escribe.

`[V]` `POST /refresh` figura sin guard declarativo
(`datos/endpoints.csv`) — correcto por diseño: renueva la cookie leyendo el
token vencido.

## 13. Capacidad ausente

1. **Pago desde el portal.** ↔ `C1-Fase B`, bloqueada hasta que el negocio elija
   proveedor.
2. **Ver el saldo y los comprobantes propios.**
3. **Cerca y test negativo de ownership.** ↔ `RBAC-OWN-001`.
4. **Idempotencia en la creación de reserva desde el portal.**
5. **Auditoría de las acciones del cliente.**
6. **Recuperación de contraseña del cliente del portal.** `password-resets` es
   para usuarios del negocio (`src/app.ts:306`); no se verificó que el portal
   tenga su propio camino `[H]`.

## 14. Brechas

| ID | Sev | Qué falta | Evidencia | Cruce |
|---|---|---|---|---|
| `A2-M13-001` | S1 | Ownership por `requireCustomerId` dentro del handler, sin cerca ni test negativo: una ruta nueva que se lo olvide no rompe nada. | `src/api/routes/customer.routes.ts:303`; `src/tests/security/rbac-route-coverage.test.ts:20` | ↔ `RBAC-OWN-001` |
| `A2-M13-002` | S1 | El reintento con backoff no tiene clave de idempotencia: puede duplicar una reserva. | `appfrontend-main/src/lib/customerApi.ts:23` | **nuevo** |
| `A2-M13-003` | S2 | El cliente no puede ver su saldo ni sus comprobantes. | `src/clientes-finanzas/customers.routes.ts:818` (es `FRONT_DESK`) | **nuevo** |
| `A2-M13-004` | S2 | Ninguna acción del portal se audita, incluida la baja de cuenta. | `grep -c` = 0 en `customer.routes.ts` | ⊃ `A2-T03-001` |
| `A2-M13-005` | S2 | No se puede pagar desde el portal. | `datos/cobertura.csv` | ↔ `C1-Fase B` |
| `A2-M13-006` | S3 | No verificado si el portal muestra el número operativo del cliente. | — | **nuevo** `[H]` |
| `A2-M13-007` | S3 | No verificado si el cliente del portal puede recuperar su contraseña. | `src/app.ts:306` | **nuevo** `[H]` |

## 15. Criterios de cierre

- Hay cerca automática y test negativo de ownership en `/api/customer/*`.
- La creación de reserva desde el portal es idempotente.
- El cliente ve su saldo y sus comprobantes, o está escrito por qué no.
- Las acciones del portal quedan auditadas, empezando por la baja de cuenta.
