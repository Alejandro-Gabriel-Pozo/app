# Inventario de rutas — generado, no editar a mano

**GENERADO.** Regenerar con `npm run docs:routes`. No editar este archivo directamente -- el
job `route-inventory-check` de CI falla el build si queda desincronizado.

- Cuándo se regeneró por última vez: ver `git log -1 -- docs/inventario-rutas.md` (sin timestamp acá adentro a propósito -- un timestamp en el contenido rompería el chequeo de CI, que compara el archivo generado contra el commiteado byte a byte para detectar drift, no para saber cuándo corrió).
- `NODE_ENV` usado para generarlo: `development`
- Total: **270** endpoints (229 observados en el árbol vivo de Express + 41 declarados vía `CLOSURE_MOUNTS`, ver el header de `src/scripts/generate-route-inventory.ts`)
- Este inventario dice QUÉ RUTAS EXISTEN. NO dice quién puede pegarles (ver `docs/rbac-matriz-endpoints.md`) ni la forma del request/response (ver `src/openapi/spec.ts`, parcial).
- `/` y `/openapi.json` (`src/app.ts:246-247`) solo existen cuando `NODE_ENV !== 'production'` (`shouldExposeApiDocs()`, `src/api/docs-exposure.ts`) -- este inventario se generó con `NODE_ENV=development` a propósito, así que las incluye. En producción, esas 2 rutas no existen.

| Método | Ruta | Origen |
|---|---|---|
| GET | `/` | árbol vivo |
| GET | `/api/accounts-receivable` | `CLOSURE_MOUNTS` |
| POST | `/api/accounts-receivable/:id/mark-collected` | `CLOSURE_MOUNTS` |
| POST | `/api/accounts-receivable/:id/mark-invoiced` | `CLOSURE_MOUNTS` |
| POST | `/api/accounts-receivable/:id/reverse` | `CLOSURE_MOUNTS` |
| POST | `/api/admin/set-tenant-url` | árbol vivo |
| GET | `/api/audit-log/` | árbol vivo |
| POST | `/api/auth/logout` | árbol vivo |
| GET | `/api/auth/me` | árbol vivo |
| POST | `/api/auth/refresh` | árbol vivo |
| GET | `/api/bookable-services/` | árbol vivo |
| POST | `/api/bookable-services/` | árbol vivo |
| DELETE | `/api/bookable-services/:id` | árbol vivo |
| GET | `/api/bookable-services/:id` | árbol vivo |
| PUT | `/api/bookable-services/:id` | árbol vivo |
| GET | `/api/bookable-services/:id/available-slots` | árbol vivo |
| GET | `/api/bookable-services/:id/rate-plans` | árbol vivo |
| POST | `/api/bookable-services/:id/rate-plans` | árbol vivo |
| DELETE | `/api/bookable-services/:id/rate-plans/:ratePlanId` | árbol vivo |
| PUT | `/api/bookable-services/:id/rate-plans/:ratePlanId` | árbol vivo |
| GET | `/api/bookable-services/:id/resource-locks` | árbol vivo |
| PUT | `/api/bookable-services/:id/resource-locks` | árbol vivo |
| GET | `/api/bookable-services/:id/schedules` | árbol vivo |
| POST | `/api/bookable-services/:id/schedules` | árbol vivo |
| DELETE | `/api/bookable-services/:id/schedules/:scheduleId` | árbol vivo |
| PUT | `/api/bookable-services/:id/schedules/:scheduleId` | árbol vivo |
| GET | `/api/business-hours/` | árbol vivo |
| POST | `/api/business-hours/` | árbol vivo |
| DELETE | `/api/business-hours/:id` | árbol vivo |
| GET | `/api/business-profile/` | árbol vivo |
| PUT | `/api/business-profile/` | árbol vivo |
| DELETE | `/api/business-profile/afip-credentials/` | árbol vivo |
| PUT | `/api/business-profile/afip-credentials/` | árbol vivo |
| GET | `/api/business-profile/afip-credentials/status` | árbol vivo |
| GET | `/api/business/context/` | árbol vivo |
| GET | `/api/business/modules/` | árbol vivo |
| GET | `/api/business/plan-limits/` | árbol vivo |
| GET | `/api/cancellation-policies/` | árbol vivo |
| POST | `/api/cancellation-policies/` | árbol vivo |
| DELETE | `/api/cancellation-policies/:id` | árbol vivo |
| GET | `/api/cancellation-policies/:id` | árbol vivo |
| PUT | `/api/cancellation-policies/:id` | árbol vivo |
| GET | `/api/cash-register/` | árbol vivo |
| GET | `/api/cash-register/:id` | árbol vivo |
| POST | `/api/cash-register/close` | árbol vivo |
| GET | `/api/cash-register/current` | árbol vivo |
| POST | `/api/cash-register/open` | árbol vivo |
| GET | `/api/categories/` | árbol vivo |
| POST | `/api/categories/` | árbol vivo |
| DELETE | `/api/categories/:id` | árbol vivo |
| GET | `/api/categories/:id` | árbol vivo |
| PUT | `/api/categories/:id` | árbol vivo |
| POST | `/api/companies/` | árbol vivo |
| POST | `/api/companies/link` | árbol vivo |
| POST | `/api/companies/link-requests` | árbol vivo |
| POST | `/api/companies/link-requests/:id/approve` | árbol vivo |
| POST | `/api/companies/link-requests/:id/reject` | árbol vivo |
| GET | `/api/companies/me` | árbol vivo |
| GET | `/api/consumption-destinations/` | árbol vivo |
| POST | `/api/consumption-destinations/` | árbol vivo |
| DELETE | `/api/consumption-destinations/:id` | árbol vivo |
| GET | `/api/consumption-destinations/:id` | árbol vivo |
| PUT | `/api/consumption-destinations/:id` | árbol vivo |
| GET | `/api/credit-note-requests/` | árbol vivo |
| GET | `/api/credit-note-requests/:id` | árbol vivo |
| POST | `/api/credit-note-requests/:id/resolve` | árbol vivo |
| GET | `/api/customer/:businessSlug/availability` | árbol vivo |
| POST | `/api/customer/:businessSlug/login` | árbol vivo |
| POST | `/api/customer/:businessSlug/login/google` | árbol vivo |
| POST | `/api/customer/:businessSlug/register` | árbol vivo |
| GET | `/api/customer/bookable-services` | árbol vivo |
| GET | `/api/customer/categories` | árbol vivo |
| POST | `/api/customer/logout` | árbol vivo |
| DELETE | `/api/customer/me` | árbol vivo |
| GET | `/api/customer/me` | árbol vivo |
| GET | `/api/customer/me/reservations` | árbol vivo |
| POST | `/api/customer/me/reservations` | árbol vivo |
| PATCH | `/api/customer/me/reservations/:id` | árbol vivo |
| POST | `/api/customer/me/reservations/:id/cancel` | árbol vivo |
| POST | `/api/customer/refresh` | árbol vivo |
| GET | `/api/customers/` | árbol vivo |
| POST | `/api/customers/` | árbol vivo |
| GET | `/api/customers/:id` | árbol vivo |
| PATCH | `/api/customers/:id` | árbol vivo |
| GET | `/api/customers/:id/account` | árbol vivo |
| GET | `/api/customers/:id/billing-policy` | árbol vivo |
| PUT | `/api/customers/:id/billing-policy` | árbol vivo |
| GET | `/api/customers/:id/outstanding-invoices` | árbol vivo |
| POST | `/api/customers/:id/payments` | árbol vivo |
| GET | `/api/customers/:id/rates` | árbol vivo |
| POST | `/api/customers/:id/rates` | árbol vivo |
| DELETE | `/api/customers/:id/rates/:rateId` | árbol vivo |
| POST | `/api/customers/:id/tags` | árbol vivo |
| DELETE | `/api/customers/:id/tags/:tagId` | árbol vivo |
| GET | `/api/customers/:id/tax-profile` | árbol vivo |
| PUT | `/api/customers/:id/tax-profile` | árbol vivo |
| GET | `/api/customers/padron/iva-receptor-types` | árbol vivo |
| POST | `/api/customers/padron/lookup-by-cuit` | árbol vivo |
| POST | `/api/customers/padron/lookup-by-dni` | árbol vivo |
| POST | `/api/customers/search` | árbol vivo |
| POST | `/api/customers/search-by-tax-id` | árbol vivo |
| GET | `/api/housekeeping` | `CLOSURE_MOUNTS` |
| POST | `/api/housekeeping` | `CLOSURE_MOUNTS` |
| GET | `/api/housekeeping/:id` | `CLOSURE_MOUNTS` |
| POST | `/api/housekeeping/:id/assign` | `CLOSURE_MOUNTS` |
| POST | `/api/housekeeping/:id/complete` | `CLOSURE_MOUNTS` |
| POST | `/api/housekeeping/:id/inspect` | `CLOSURE_MOUNTS` |
| POST | `/api/housekeeping/:id/start` | `CLOSURE_MOUNTS` |
| GET | `/api/housekeeping/late-checkouts` | `CLOSURE_MOUNTS` |
| GET | `/api/housekeeping/me` | `CLOSURE_MOUNTS` |
| GET | `/api/housekeeping/resource/:resourceId` | `CLOSURE_MOUNTS` |
| GET | `/api/housekeeping/status/:status` | `CLOSURE_MOUNTS` |
| POST | `/api/invitations/accept` | árbol vivo |
| POST | `/api/invitations/lookup` | árbol vivo |
| GET | `/api/invoices/` | árbol vivo |
| POST | `/api/invoices/` | árbol vivo |
| GET | `/api/invoices/:id` | árbol vivo |
| POST | `/api/invoices/:id/mark-not-issued` | árbol vivo |
| GET | `/api/invoices/:id/pdf` | árbol vivo |
| POST | `/api/invoices/:id/reconcile-with-afip` | árbol vivo |
| POST | `/api/invoices/consolidated` | árbol vivo |
| GET | `/api/invoices/uncertain` | árbol vivo |
| GET | `/api/invoices/unreconciled` | árbol vivo |
| GET | `/api/locations/` | árbol vivo |
| POST | `/api/locations/` | árbol vivo |
| POST | `/api/login/` | árbol vivo |
| POST | `/api/login/google` | árbol vivo |
| POST | `/api/login/select-business` | árbol vivo |
| GET | `/api/maintenance-windows` | `CLOSURE_MOUNTS` |
| POST | `/api/maintenance-windows` | `CLOSURE_MOUNTS` |
| POST | `/api/maintenance-windows/:id/close` | `CLOSURE_MOUNTS` |
| GET | `/api/maintenance-windows/resource/:resourceId` | `CLOSURE_MOUNTS` |
| GET | `/api/orders/` | árbol vivo |
| POST | `/api/orders/` | árbol vivo |
| GET | `/api/orders/:id` | árbol vivo |
| POST | `/api/orders/:id/cancel` | árbol vivo |
| POST | `/api/orders/:id/cancel-with-credit-note` | árbol vivo |
| POST | `/api/orders/:id/complete` | árbol vivo |
| POST | `/api/orders/:id/confirm` | árbol vivo |
| POST | `/api/orders/:id/items` | árbol vivo |
| DELETE | `/api/orders/:id/items/:itemId` | árbol vivo |
| PATCH | `/api/orders/:id/notes` | árbol vivo |
| POST | `/api/orders/:id/serve` | árbol vivo |
| POST | `/api/password-resets/accept` | árbol vivo |
| POST | `/api/password-resets/lookup` | árbol vivo |
| POST | `/api/password-resets/request` | árbol vivo |
| GET | `/api/products/` | árbol vivo |
| POST | `/api/products/` | árbol vivo |
| DELETE | `/api/products/:id` | árbol vivo |
| GET | `/api/products/:id` | árbol vivo |
| PUT | `/api/products/:id` | árbol vivo |
| POST | `/api/products/:id/company/price-override/accept` | árbol vivo |
| POST | `/api/products/:id/company/price-override/activate` | árbol vivo |
| POST | `/api/products/:id/company/price-override/deactivate` | árbol vivo |
| POST | `/api/products/:id/company/price-override/reject` | árbol vivo |
| POST | `/api/products/:id/company/publish` | árbol vivo |
| POST | `/api/products/:id/company/recipe-override/accept` | árbol vivo |
| POST | `/api/products/:id/company/recipe-override/activate` | árbol vivo |
| POST | `/api/products/:id/company/recipe-override/deactivate` | árbol vivo |
| POST | `/api/products/:id/company/recipe-override/reject` | árbol vivo |
| POST | `/api/products/:id/company/share` | árbol vivo |
| GET | `/api/products/:id/recipe-items` | árbol vivo |
| POST | `/api/products/:id/recipe-items` | árbol vivo |
| DELETE | `/api/products/:id/recipe-items/:itemId` | árbol vivo |
| PUT | `/api/products/:id/recipe-items/:itemId` | árbol vivo |
| POST | `/api/products/:id/stock/decrement` | árbol vivo |
| GET | `/api/products/:id/variants` | árbol vivo |
| POST | `/api/products/:id/variants` | árbol vivo |
| DELETE | `/api/products/:id/variants/:variantId` | árbol vivo |
| PUT | `/api/products/:id/variants/:variantId` | árbol vivo |
| POST | `/api/products/:id/variants/:variantId/stock/decrement` | árbol vivo |
| GET | `/api/products/company-catalog` | árbol vivo |
| POST | `/api/products/stock/consumption` | árbol vivo |
| POST | `/api/products/stock/production` | árbol vivo |
| POST | `/api/products/stock/transfer` | árbol vivo |
| POST | `/api/products/stock/waste` | árbol vivo |
| GET | `/api/rate-catalog/` | árbol vivo |
| POST | `/api/rate-catalog/` | árbol vivo |
| DELETE | `/api/rate-catalog/:id` | árbol vivo |
| PUT | `/api/rate-catalog/:id` | árbol vivo |
| GET | `/api/reports/accounts-receivable` | `CLOSURE_MOUNTS` |
| GET | `/api/reports/crm/applied-rates` | `CLOSURE_MOUNTS` |
| GET | `/api/reports/crm/new-vs-recurring` | `CLOSURE_MOUNTS` |
| GET | `/api/reports/occupancy` | `CLOSURE_MOUNTS` |
| GET | `/api/reports/occupancy/by-category` | `CLOSURE_MOUNTS` |
| DELETE | `/api/reports/occupancy/purge` | `CLOSURE_MOUNTS` |
| GET | `/api/reports/occupancy/summary` | `CLOSURE_MOUNTS` |
| GET | `/api/reports/occupancy/underutilized` | `CLOSURE_MOUNTS` |
| GET | `/api/reports/pos/sales-by-product` | `CLOSURE_MOUNTS` |
| GET | `/api/reports/pos/ticket-summary` | `CLOSURE_MOUNTS` |
| GET | `/api/reports/pos/waste` | `CLOSURE_MOUNTS` |
| GET | `/api/reservations/` | árbol vivo |
| POST | `/api/reservations/` | árbol vivo |
| GET | `/api/reservations/:id` | árbol vivo |
| PUT | `/api/reservations/:id` | árbol vivo |
| POST | `/api/reservations/:id/cancel` | árbol vivo |
| POST | `/api/reservations/:id/cancel-with-credit-note` | árbol vivo |
| POST | `/api/reservations/:id/cancellation-refund/confirm` | árbol vivo |
| GET | `/api/reservations/:id/cancellation-refund/preview` | árbol vivo |
| POST | `/api/reservations/:id/complete` | árbol vivo |
| POST | `/api/reservations/:id/confirm` | árbol vivo |
| POST | `/api/reservations/:id/confirm-price-adjustment` | árbol vivo |
| GET | `/api/reservations/:id/price-preview` | árbol vivo |
| POST | `/api/reservations/:id/schedule-request` | árbol vivo |
| POST | `/api/reservations/:id/schedule-request/approve` | árbol vivo |
| POST | `/api/reservations/:id/schedule-request/reject` | árbol vivo |
| GET | `/api/reservations/availability-by-category` | árbol vivo |
| POST | `/api/reservations/search` | árbol vivo |
| GET | `/api/resources/` | árbol vivo |
| POST | `/api/resources/` | árbol vivo |
| DELETE | `/api/resources/:id` | árbol vivo |
| GET | `/api/resources/:id` | árbol vivo |
| PUT | `/api/resources/:id` | árbol vivo |
| GET | `/api/resources/:id/hours` | árbol vivo |
| POST | `/api/resources/:id/hours` | árbol vivo |
| DELETE | `/api/resources/:id/hours/:hourId` | árbol vivo |
| GET | `/api/roles/` | árbol vivo |
| POST | `/api/roles/` | árbol vivo |
| DELETE | `/api/roles/:id` | árbol vivo |
| GET | `/api/roles/:id` | árbol vivo |
| PUT | `/api/roles/:id` | árbol vivo |
| GET | `/api/service-items/` | árbol vivo |
| POST | `/api/service-items/` | árbol vivo |
| DELETE | `/api/service-items/:id` | árbol vivo |
| GET | `/api/service-items/:id` | árbol vivo |
| PUT | `/api/service-items/:id` | árbol vivo |
| GET | `/api/stays` | `CLOSURE_MOUNTS` |
| GET | `/api/stays/:id` | `CLOSURE_MOUNTS` |
| POST | `/api/stays/:id/check-out` | `CLOSURE_MOUNTS` |
| GET | `/api/stays/:id/folio` | `CLOSURE_MOUNTS` |
| POST | `/api/stays/:id/no-show` | `CLOSURE_MOUNTS` |
| POST | `/api/stays/:id/transfer-to-receivable` | `CLOSURE_MOUNTS` |
| POST | `/api/stays/check-in` | `CLOSURE_MOUNTS` |
| GET | `/api/stays/reservation/:reservationId` | `CLOSURE_MOUNTS` |
| GET | `/api/stays/resource/:resourceId` | `CLOSURE_MOUNTS` |
| POST | `/api/system/outbox/:id/retry` | `CLOSURE_MOUNTS` |
| GET | `/api/system/outbox/dead-letter` | `CLOSURE_MOUNTS` |
| GET | `/api/users/` | árbol vivo |
| POST | `/api/users/` | árbol vivo |
| DELETE | `/api/users/:id` | árbol vivo |
| GET | `/api/users/:id` | árbol vivo |
| PUT | `/api/users/:id` | árbol vivo |
| POST | `/api/users/:id/password-reset-link` | árbol vivo |
| POST | `/api/users/:id/reactivate` | árbol vivo |
| GET | `/api/users/invitations/` | árbol vivo |
| POST | `/api/users/invitations/` | árbol vivo |
| DELETE | `/api/users/invitations/:id` | árbol vivo |
| POST | `/api/users/invitations/:id/resend` | árbol vivo |
| GET | `/api/waste-reasons/` | árbol vivo |
| POST | `/api/waste-reasons/` | árbol vivo |
| DELETE | `/api/waste-reasons/:id` | árbol vivo |
| GET | `/api/waste-reasons/:id` | árbol vivo |
| PUT | `/api/waste-reasons/:id` | árbol vivo |
| GET | `/health` | árbol vivo |
| GET | `/health/db` | árbol vivo |
| GET | `/openapi.json` | árbol vivo |
| GET | `/platform/businesses` | árbol vivo |
| POST | `/platform/businesses` | árbol vivo |
| GET | `/platform/businesses/:id` | árbol vivo |
| PATCH | `/platform/businesses/:id/plan` | árbol vivo |
| POST | `/platform/businesses/:id/provision` | árbol vivo |
| PATCH | `/platform/businesses/:id/status` | árbol vivo |
| POST | `/platform/login` | árbol vivo |
| POST | `/platform/outbox/purge` | árbol vivo |
| GET | `/platform/plan-limits` | árbol vivo |
| PUT | `/platform/plan-limits/:plan` | árbol vivo |
| GET | `/platform/role-presets` | árbol vivo |
| PUT | `/platform/role-presets/:name` | árbol vivo |
| GET | `/platform/stats` | árbol vivo |
| POST | `/register/` | árbol vivo |
