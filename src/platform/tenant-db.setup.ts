/**
 * @file tenant-db.setup.ts
 * @description Cifrado de connection strings de tenant + carga del schema.
 *
 * Antes se llamaba supabase.provisioner.ts y también auto-creaba proyectos
 * Supabase vía su API de gestión. Ese flujo automático ya no se usa (dejaron
 * de operar con Supabase) y se eliminó — ver el hallazgo del code review de
 * agosto 2026. Lo que queda acá es independiente del proveedor:
 *
 * 1. Cifrado AES-256-GCM de la connection string antes de guardarla en
 *    `businesses.db_url_encrypted` (BD central).
 * 2. Carga de `src/db/schema.sql` para aplicarlo a una BD de tenant nueva.
 *
 * ## Flujo actual de alta de un negocio (creación de BD manual, resto ya no)
 * 1. Se crea el negocio vía POST /register o POST /platform/businesses —
 *    queda en estado PENDING, sin BD asignada.
 * 2. Alguien crea la BD del negocio a mano (hoy: un proyecto Neon) — vacía,
 *    sin schema todavía.
 * 3. El ADMIN del negocio llama POST /api/admin/set-tenant-url (o
 *    repair-tenant-db) con la connection string. Desde ahí el propio
 *    endpoint llama a applyTenantSchema() — corre schema.sql y registra la
 *    versión (ver CURRENT_SCHEMA_VERSION más abajo) antes de cifrar y
 *    guardar la connection string. Ya no hace falta correr schema.sql a
 *    mano por SQL Editor/psql como antes.
 *
 * ## Variables de entorno requeridas
 * | Variable              | Descripción                                          |
 * |------------------------|------------------------------------------------------|
 * | DB_ENCRYPTION_KEY      | 32 bytes hex para cifrar db_urls en la BD central     |
 * | DB_ENCRYPTION_KEY_OLD  | OPCIONAL -- 32 bytes hex, clave anterior durante una rotación en curso (SEC-ROT-001). Ver `docs/conocimiento/runbook-rotacion-db-encryption-key.md`. Sin ella, comportamiento idéntico al de una sola clave. |
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripSslMode, sslConfig } from '../db/pg.client.js';

// ---------------------------------------------------------------------------
// Schema loader — fuente de verdad única, resuelta desde este archivo
// ---------------------------------------------------------------------------

/** Caché en memoria: se lee una sola vez por proceso. */
let _schemaSQLCache: string | undefined;

/**
 * Devuelve el contenido de src/db/schema.sql.
 *
 * Usa import.meta.url para resolver el path de forma robusta,
 * independientemente de la estructura del directorio de build.
 * El resultado se cachea en memoria para no releer el disco en cada uso.
 */
export async function loadTenantSchema(): Promise<string> {
  if (_schemaSQLCache) return _schemaSQLCache;
  // Este archivo está en src/platform/ — schema.sql está en src/db/
  const thisDir = dirname(fileURLToPath(import.meta.url));
  const schemaPath = resolve(thisDir, '..', 'db', 'schema.sql');
  _schemaSQLCache = await readFile(schemaPath, 'utf-8');
  return _schemaSQLCache;
}

// ---------------------------------------------------------------------------
// Cifrado de connection strings
// ---------------------------------------------------------------------------

export async function encryptConnectionString(plaintext: string): Promise<string> {
  const key = await deriveEncryptionKey();
  const iv = randomBytes(16);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted.toString('hex')}`;
}

/**
 * SEC-ROT-001 (11/09/2026, gate `architecture-governor`) -- `opts.allowOldKey`
 * (default `true`) es lo que hace posible rotar `DB_ENCRYPTION_KEY` sin
 * downtime: durante la ventana de rotación (`DB_ENCRYPTION_KEY_OLD` seteada,
 * ver el runbook), un ciphertext puede haber sido escrito con la clave
 * ANTERIOR y necesita ese fallback para seguir siendo legible.
 *
 * `opts?` es un objeto, no un booleano posicional, A PROPÓSITO: los 10
 * call sites productivos de esta función pasan exactamente un argumento
 * (`ciphertext`) de forma explícita -- ninguno es point-free
 * (`arr.map(decryptConnectionString)`), que es el único patrón donde un
 * segundo parámetro posicional heredaría el índice del array por accidente
 * y activaría/desactivaría el fallback sin que nadie lo haya pedido.
 * Verificado al agregar este parámetro (`grep` de `map(`/`then(` sobre los
 * call sites, vacío) -- si algún día se agrega un consumidor point-free,
 * hay que re-verificar esto, no asumir que sigue siendo cierto.
 */
export async function decryptConnectionString(
  ciphertext: string,
  opts?: { allowOldKey?: boolean },
): Promise<string> {
  const allowOldKey = opts?.allowOldKey ?? true;
  const [ivHex, authTagHex, dataHex] = ciphertext.split(':');
  if (!ivHex || !authTagHex || !dataHex) {
    throw new Error('[tenant-db.setup] Formato de ciphertext inválido — esperado: iv:authTag:ciphertext');
  }
  const iv = Buffer.from(ivHex, 'hex');
  const authTag = Buffer.from(authTagHex, 'hex');
  const data = Buffer.from(dataHex, 'hex');

  const tryDecryptWith = (key: Buffer): string => {
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(authTag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
  };

  const primaryKey = await deriveEncryptionKey();
  try {
    return tryDecryptWith(primaryKey);
  } catch (primaryErr) {
    // Sin DB_ENCRYPTION_KEY_OLD (el caso de siempre, fuera de una rotación
    // activa) o con allowOldKey:false: comportamiento IDÉNTICO al de antes
    // de este bloque -- un solo intento de descifrado, se relanza el error
    // de la primaria tal cual, sin envolver.
    const oldKey = allowOldKey ? await deriveOldEncryptionKey() : null;
    if (!oldKey) throw primaryErr;

    try {
      return tryDecryptWith(oldKey);
    } catch {
      // Compuesto, no el error de la vieja a secas (P2 del gate, con
      // evidencia: error.middleware.ts nunca filtra este mensaje al
      // cliente, solo a logs/Sentry -- no hay costo en ser explícito, y el
      // operador necesita saber, a las 3 de la mañana, si DB_ENCRYPTION_KEY_OLD
      // siquiera estaba cargada). Nunca material de clave ni ciphertext acá.
      throw new Error(
        '[tenant-db.setup] No se pudo descifrar -- se probaron 2 claves ' +
        '(DB_ENCRYPTION_KEY y DB_ENCRYPTION_KEY_OLD, ambas configuradas) y ' +
        'ninguna de las dos matchea. Ver docs/conocimiento/runbook-rotacion-db-encryption-key.md.',
        { cause: primaryErr },
      );
    }
  }
}

async function deriveEncryptionKey(): Promise<Buffer> {
  const keyMaterial = process.env.DB_ENCRYPTION_KEY;
  if (!keyMaterial) {
    throw new Error(
      '[tenant-db.setup] DB_ENCRYPTION_KEY no está definida. ' +
      'Esta variable es obligatoria en modo multi-tenant. ' +
      'Generá una con: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"',
    );
  }
  const keyBuffer = Buffer.from(keyMaterial, 'hex');
  if (keyBuffer.length !== 32) {
    throw new Error(
      `[tenant-db.setup] DB_ENCRYPTION_KEY debe ser 32 bytes en hex (64 caracteres). ` +
      `Recibido: ${keyBuffer.length} bytes.`,
    );
  }
  return keyBuffer;
}

/**
 * SEC-ROT-001 -- clave anterior durante una rotación en curso. `null` (no
 * error) cuando `DB_ENCRYPTION_KEY_OLD` no está seteada -- ese es el estado
 * normal, fuera de una ventana de rotación activa, y `decryptConnectionString()`
 * lo trata como "sin fallback disponible", no como una falla. Si SÍ está
 * seteada pero mal formada, falla ruidosa -- mismo criterio fail-loud que
 * `deriveEncryptionKey()`: una clave de rotación cargada a medias tiene que
 * hacer ruido al arrancar el proceso, no fallar en silencio a mitad de una
 * rotación real. Sin exportar -- sin consumidor fuera de este archivo.
 */
async function deriveOldEncryptionKey(): Promise<Buffer | null> {
  const keyMaterial = process.env.DB_ENCRYPTION_KEY_OLD;
  if (!keyMaterial) return null;
  const keyBuffer = Buffer.from(keyMaterial, 'hex');
  if (keyBuffer.length !== 32) {
    throw new Error(
      `[tenant-db.setup] DB_ENCRYPTION_KEY_OLD debe ser 32 bytes en hex (64 caracteres). ` +
      `Recibido: ${keyBuffer.length} bytes.`,
    );
  }
  return keyBuffer;
}

// ---------------------------------------------------------------------------
// Versionado y aplicación de schema.sql por tenant
// ---------------------------------------------------------------------------

/**
 * Versión actual de src/db/schema.sql. Única fuente de verdad — bumpear a
 * mano cada vez que schema.sql cambie de forma que valga la pena rastrear
 * (nueva tabla/columna, backfill nuevo). No hay migraciones numeradas
 * separadas: el archivo entero se re-aplica siempre, así que esta versión
 * es solo una etiqueta de "hasta qué cambio llegó esta tenant DB".
 *
 * Consumida por applyTenantSchema() (acá abajo, quien la persiste) y por
 * tenant.middleware.ts (quien la compara contra businesses.schema_version
 * para advertir sobre tenants desactualizados).
 */
// v2 (14/08/2026): BLOQUE 10 de schema.sql — tabla audit_log nueva (R8/A9.4).
// Bumpeado a mano acá mismo, junto con el cambio de schema.sql que lo
// motiva — es justamente el paso que pendientes-2026-08-13.md (A4) marcó
// como "hay que acordarse a mano" y que se saltó la sesión anterior.
// v3 (14/08/2026): BLOQUE 11 — tabla cash_register_shifts nueva +
// financial_transactions.payment_method/shift_id (Gap analysis Tango #2).
// v4 (14/08/2026): BLOQUE 12 — financial_transactions.card_installments/
// card_surcharge_amount (Gap analysis Tango #3).
// v5 (15/08/2026): BLOQUE 13 — índice único (order_item_id, movement_type)
// en stock_movements, primer uso real de la tabla (handler de inventario
// enganchado al outbox, ver docs/arquitectura-monolito-modular.md).
// v6 (15/08/2026): BLOQUE 14 — orders.served_at, para que cancelOrder()
// sepa si el bien ya se consumió físicamente antes de restaurar stock.
// v7 (15/08/2026): BLOQUE 7 — domain_events.retry_count/failed_at/last_error
// + índice de dead-letter, dead-letter/alertas del outbox (A9.5/A8.7,
// pendientes-2026-08-15.md punto 2).
// v8 (15/08/2026): BLOQUE 3 — products/product_variants.reserved_quantity +
// CHECK reserved<=stock. BLOQUE 5/13 — stock_movements gana el tipo
// RESERVATION_RELEASED + índice de exclusión mutua con OUT por order_item.
// Carrera de stock en confirmOrder(), pendientes-2026-08-15.md punto 1.
// v9 (15/08/2026): BLOQUE 15 — business_profile (MAESTRO singleton) nueva,
// identidad del negocio para el remitente de mails (punto 5/E5,
// pendientes-2026-08-15.md).
// v10 (15/08/2026): customers.google_sub — login con Google del portal
// (punto 5/E5, segunda mitad). identities.google_sub (staff) vive en
// platform.schema.sql, sin versionado propio — se reaplica en cada boot.
// v11 (16/08/2026): Fase 1 del carve-out de inventario
// (docs/diseno-inventario-carve-out.md) — tabla `inventory_levels` nueva
// (BLOQUE 16), reemplaza products/product_variants.stock_quantity/
// reserved_quantity/stock_min_alert (dropeadas, con backfill previo a
// loc-default). `orders.location_id` nuevo. `stock_movements` gana
// location_id/from_location_id/to_location_id + movement_type TRANSFER.
// v12 (17/08/2026): Fase 2 del carve-out de inventario — tabla
// `waste_reasons` nueva (BLOQUE 17, maestro de catálogo propio por
// negocio). `stock_movements` gana movement_type WASTE + waste_reason_id
// (obligatorio cuando movement_type = 'WASTE').
// v13 (17/08/2026): Fase 3 del carve-out de inventario — `products` gana
// product_type/assemble_on_demand. Tabla `recipe_items` nueva (BLOQUE 18,
// BOM multinivel). `order_items.stock_snapshot` nuevo (persiste qué
// componentes se reservaron de verdad, para que cancelOrder() revierta
// exacto aunque la receta cambie después). `stock_movements` gana
// movement_type PRODUCTION; los índices únicos de idempotencia por
// order_item (BLOQUE 13/D1) se amplían a (order_item, producto/variante,
// tipo) para soportar N componentes por ítem compuesto.
// v14 (17/08/2026): Empresas multipropiedad (BLOQUE 19,
// docs/diseno-empresas-multipropiedad.md) — `products` gana
// company_product_id (vínculo sin FK real a company_products en la BD
// central) + price_override_status/recipe_override_status (tres estados:
// INACTIVO/ACTIVO/PENDIENTE_DE_REVISION) + sus columnas de valor/snapshot
// pendiente. El catálogo canónico en sí (companies/company_products/
// company_recipe_items/company_catalog_propagation_queue) vive en
// platform.schema.sql, no acá.
// v15 (17/08/2026): auditoría de hardcodes (pendientes-2026-08-17.md
// sección F3) — `business_profile` gana `currency`/`timezone`,
// configurables por negocio en vez de constantes fijas en código/SQL.
// DEFAULT explícito igual al valor que estaba hardcodeado antes ('ARS' /
// America/Argentina/Buenos_Aires) para no cambiar comportamiento hasta
// que alguien edite el perfil a propósito.
// v16 (18/08/2026): `occupancy_records` gana `category_id`/`category_name`
// — sql.occupancy.repository.ts ya las escribía (agrupar ocupación por
// categoría real, ver reservation.service.ts) pero la tabla nunca las tuvo.
// Bug real: confirmar una reserva devolvía 500 (Postgres 42703) aunque la
// reserva sí quedaba CONFIRMED, porque recordOccupancy() corre después de
// la transacción. DEFAULT '' solo afecta filas ya existentes.
// v17 (18/08/2026, noche): `resource_categories` gana `is_lodging` —
// backlog E1 (pendientes-2026-08-13.md), separa el panel de Estadías/PMS
// del de Turnos/servicios. DEFAULT FALSE, categorías existentes hay que
// marcarlas a mano desde Categorías (no hay forma de inferirlo).
// v18 (18/08/2026, noche): `reservations` gana `adultos`/`ninos` —
// spec de mejoras PMS (docs/referencia-mejoras-pms-2026-08-18-anexo.md
// sección A). Nullable: solo se pide/muestra hoy en categorías de
// alojamiento (isLodging=true); una reserva de Turnos queda con NULL.
// v19 (18/08/2026, noche): `rate_plans` (precio por tipo de habitación en
// vez de por recurso físico) + `reservations.rate_plan_id`. Ver
// pendientes-2026-08-18.md punto M.
// v20 (18/08/2026, noche): flujo de check-in/check-out — horario estándar
// en `business_profile`, pedido/aprobación de horario en `reservations`,
// `housekeeping_tasks.not_before`. Ver pendientes-2026-08-18.md punto N.
// v21 (18/08/2026, noche): perfil fiscal del negocio emisor en
// `business_profile` (legal_name/tax_id/tax_id_type/tax_condition,
// domicilio fiscal, punto de venta AFIP) — Fase 1 de Facturación
// Electrónica AFIP. Ver docs/referencia-afip-wsfev1.md.
// v22 (19/08/2026): financial_transactions.amount admite negativo cuando
// type='ADJUSTMENT' (nota de crédito al recotizar una reserva CONFIRMED
// hacia abajo) — CHARGE/PAYMENT/REFUND siguen exigiendo amount >= 0.
// financial_transactions.confirmed_by (identity_id de quien autorizó el
// ajuste a mano, mismo criterio que schedule_approved_by). Ver
// pendientes-2026-08-18.md punto I.
// v23 (19/08/2026): conexión real a AFIP — business_profile gana
// default_iva_rate/prices_include_iva/afip_environment/afip_cert_encrypted/
// afip_key_encrypted/afip_ticket_encrypted/afip_ticket_expires_at; tabla
// `invoices` nueva (DOCUMENTO — comprobantes con CAE). Ver
// docs/referencia-afip-wsfev1.md y pendientes-2026-08-19.md.
// v24 (19/08/2026): invoices.afip_contacted — permite que
// InvoiceService.requestInvoice() reintente un comprobante FAILED_UNCERTAIN
// cuando createNextVoucher() nunca llegó a invocarse (ej. WSAA rechazó el
// certificado antes de siquiera intentar el CAE), sin arriesgar un
// reintento ciego cuando la falla ocurrió DESPUÉS de contactar a AFIP
// (A8.6 -- ahí sigue requiriendo revisión manual). Encontrado en vivo:
// un negocio real probó Facturar en homologación y quedó con una fila
// FAILED_UNCERTAIN irrecuperable (el idempotency_key determinístico por
// financial_transaction_id devolvía esa misma fila para siempre).
// v25 (19/08/2026): business_profile.afip_cuit — CUIT de autenticación
// AFIP separado del CUIT legal (tax_id). Encontrado en vivo, misma sesión:
// el certificado real cargado en homologación era del gestor de
// PRODUCCIÓN de AFIP, y homologación puede requerir un CUIT de testing
// ficticio para probar -- pisar tax_id directamente ensuciaría "Datos
// fiscales" (identidad legal real). NULL = se sigue autenticando como
// tax_id, sin cambio de comportamiento para quien no lo cargue.
// v26 (19/08/2026): invoices.emisor_cuit — congela el CUIT de
// autenticación usado al CREAR el comprobante (R9), para que el PDF
// (`@arcasdk/pdf`) siempre muestre el CUIT real con el que AFIP lo
// asoció, sin importar si business_profile.afip_cuit cambia después.
// v27 (19/08/2026): índice único customer_tax_profiles_customer_uniq —
// customer_tax_profiles gana su primer repositorio/ruta real (padrón de
// ARCA), un perfil fiscal por cliente por ahora.
// v28 (19/08/2026): invoices.payment_method/card_installments — el
// comprobante AFIP ahora congela la forma de pago de la
// FinancialTransaction de origen (R9), antes invisible en el PDF.
//
// NOTA: C1-Fase A y D9-Parte 1/2 (22/08/2026, pendientes-2026-08-22.md)
// cambiaron schema.sql (deposit_policies, reservations.deposit_amount,
// scope multi-nivel de customer_rates/rate_catalog) sin bumpear esta
// constante — hallazgo de paso al tocar este archivo para v29. No se
// corrige retroactivo acá (aplicar el archivo completo siempre reaplica
// todo igual, así que no rompe nada), pero un tenant que se resincronizó
// entre v28 y esta v29 quedó registrado como "v28" sin reflejar esos
// cambios. Backlog, no forma parte de D6.
// v29 (22/08/2026): número operativo de Reserva/Cliente (D6,
// pendientes-2026-08-22.md sección D) — tabla `number_sequences` nueva,
// `customers.customer_number`/`reservations.reservation_number` (con
// backfill retroactivo por antigüedad), `business_profile.customer_number_prefix`/
// `reservation_number_prefix`.
// v30 (22/08/2026): IVA por producto (D8, pendientes-2026-08-19.md sección D)
// — `products.iva_rate`/`unit`/`arca_unit_code`, `order_items.iva_rate`
// (snapshot al armar la orden, R9). `InvoiceService` agrupa el comprobante
// AFIP por tasa cuando la orden mezcla productos con distinta alícuota.
// v31 (22/08/2026): reportes POS/CRM (D7, pendientes-2026-08-19.md sección D)
// — `order_items.applied_customer_rate_id`/`reservations.applied_customer_rate_id`
// (snapshot de qué CustomerRate se aplicó, si hubo alguna, R9). Ninguno de
// los dos lo registraba antes -- necesario para el reporte "tarifas aplicadas".
// v32 (23/08/2026): facturación por líneas, Nivel B (C3,
// docs/diseno-facturacion-lineas-nivel-b-2026-08-23.md) — tabla
// `invoice_items` nueva. Facturas nuevas ganan líneas reales por
// producto/reserva; facturas viejas (Nivel A) siguen sin filas acá, el
// PDF les sigue mostrando el ítem agrupado por tasa para siempre.
// v33 (23/08/2026): cancelación con reembolso + Nota de Crédito (C2,
// docs/diseno-cancelacion-notas-credito-c2-2026-08-23.md) — tabla
// `cancellation_policies` nueva (tramos de % según anticipación) y
// `financial_transactions.reversed_invoice_id` (qué factura cubre cada
// REFUND del reparto LIFO).
// v34 (23/08/2026): bug real en producción, pendientes-2026-08-23.md — el
// Ticket de Acceso de WSAA está scoped a un solo servicio de ARCA, pero
// `business_profile.afip_ticket_*` guardaba uno solo por negocio. Tabla
// `afip_tickets` nueva (particionada por `service_name`); se dropean las
// dos columnas viejas de `business_profile`.
// v35 (23/08/2026): G1, pendientes-2026-08-23.md — búsqueda de clientes
// por CUIT/DNI contra la base propia. Índice nuevo
// `idx_customer_tax_profiles_tax_id`.
// v36 (23/08/2026): F1-Pieza 1, pendientes-2026-08-23.md — tipificación de
// cliente para Cuentas Corrientes. `customers.enable_current_account`
// nuevo, DEFAULT FALSE.
// v37 (23/08/2026): I4, pendientes-2026-08-23.md — conciliación de pagos.
// `financial_transactions.settled_invoice_id` nuevo, espejo de
// `reversed_invoice_id`.
// v38 (23/08/2026): F1-Pieza 3, pendientes-2026-08-23.md — ciclo de vida de
// cuentas por cobrar. `accounts_receivable.invoice_ref` nuevo (N° de
// comprobante anotado a mano al marcar "Facturado").
// v39 (23/08/2026): C1-Fase C (recorte confirmado), pendientes-2026-08-23.md.
// `billing_policies` nueva; `accounts_receivable.financial_transaction_id`
// nuevo; `invoices.financial_transaction_id` pasa a nullable; `invoice_charges`
// nueva (N:1 para facturación consolidada, sin migrar facturas existentes).
// v40 (24/08/2026): ventana de mantenimiento, pendientes-2026-08-24.md.
// `maintenance_windows` nueva (reemplaza OUT_OF_SERVICE de housekeeping_tasks
// como mecanismo de bloqueo); `business_profile.maintenance_horizon_days`
// nuevo; `reservations.needs_maintenance_review` nuevo.
// v41 (25/08/2026): gating de check-in por limpieza, pendientes-2026-08-25.md.
// `stays.housekeeping_override_by`/`housekeeping_override_at`/
// `housekeeping_status_at_override` nuevos (A6.5 — rastro del override de
// MANAGEMENT cuando el check-in se fuerza con la limpieza sin INSPECTED).
// v42 (25/08/2026): Bug 2 — doble booking bajo concurrencia,
// docs/auditoria-tecnica-infra-reservas.md. `resource_categories.is_exclusive`
// nuevo (desacoplado de `is_lodging`, ver comentario en schema.sql);
// `reservations.is_exclusive_resource` (snapshot R9) y constraint
// `reservations_no_overlap_exclusive` (EXCLUDE USING gist, requiere
// btree_gist) como respaldo A8.2 del fix aplicativo
// (`ResourceRepository.lockByIds()`).
// v43 (28/08/2026): temporada que cruza el rango de la estadía (bug de
// cobro vivo, pendientes-2026-08-27.md ítem 5). `rate_plans` cambia
// UNIQUE(service_id, name) por `excl_rate_plans_overlapping_validity`
// (EXCLUDE USING gist, rango semiabierto) -- varias filas pueden compartir
// nombre si sus vigencias no se solapan, resueltas por noche en
// reservation-pricing.service.ts.
// v44 (28/08/2026): sobre del evento + idempotencia por handler — Fase 1 de
// docs/plan-separacion-dominios-multirubro-2026-08-28.md. `domain_events`
// gana `event_id`/`correlation_id`/`causation_id`/`version` (A9.2/A10.1/
// A10.4; las dos del medio quedan en NULL hasta que exista contexto por
// request — se agregan ahora para no migrar con datos cargados después), y
// `processed_events` nueva: idempotencia genérica por (evento, handler) para
// el caso en que el handler no tiene clave natural propia. El disparador
// concreto es el handler de mail, que hoy reenvía la confirmación de reserva
// cada vez que el handler financiero del MISMO evento falla.
// v46 (03/09/2026): las cuatro columnas de sello de `orders` (`confirmed_at`,
// `cancelled_at`, `completed_at`, `served_at`) pasan a tener su
// `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`. Estaban declaradas sólo dentro
// del `CREATE TABLE IF NOT EXISTS orders`, que es un no-op en una BD donde la
// tabla ya existe: `served_at`, agregada al schema el 15/08/2026, nunca se
// creó en `biz-demo-01` (provisionado el 09/08) y ningún deploy posterior la
// creó -- verificado contra los dos tenants el 03/09/2026. `markServed()`
// respondía 42703 -> 500 y la lectura lo enmascaraba como `null`. Sin
// backfill: el NULL de las órdenes viejas significa "no consta".
// v47 (08/09/2026): CHECK `chk_financial_transactions_reversed_invoice_type`
// (`reversed_invoice_id IS NULL OR type IN ('REFUND','ADJUSTMENT')`). Cierra
// la "mitad de datos" de la condición 3 del re-gate del ADR cancelar-con-NC:
// la whitelist de F4/N1.b ya no depende sólo de la cerca estática. Verificado
// 0 filas con `reversed_invoice_id` en las dos tenants -> ADD CONSTRAINT
// instantáneo, sin backfill. Ver schema.sql, bloque "schema v47".
// v48 (10/09/2026): OUTBOX-RETRY-HIST-01/OUTBOX-BACKOFF-01,
// docs/diseno-outbox-backoff-2026-09-10.md. `domain_events` gana
// `first_failed_at`/`last_failed_at` -- visibilidad de "hace cuánto que
// esto falla" (Odoo `first_failure_date`) + backoff real por evento en
// `getPending()` (esto último recién en el commit B de ese diseño, no
// acá -- este bump acompaña las columnas, no el cambio de query).
// v49 (12/09/2026): checkOut() pasa a warn-and-override,
// docs/investigacion-decisiones-bloqueado-2026-09-12.md caso 3.
// `stays.balance_override_by`/`balance_override_at`/`balance_at_override`
// nuevos (A6.5 -- mismo patrón que housekeeping_override_* de v41).
// v50 (12/09/2026): CHECK `chk_financial_transactions_order_or_reservation`
// (<=1 de order_id/reservation_id no-nulo), docs/investigacion-decisiones-
// bloqueado-2026-09-12.md caso 6. Cierra a nivel de BD lo que
// CreditNoteAmbiguousSubjectError solo rechazaba en lectura.
// v51 (12/09/2026): Caso 6 residuo parte 2 (decisión del dueño el mismo
// día). Los 3 CHECK de `financial_transactions`
// (chk_financial_transactions_amount, _reversed_invoice_type,
// _order_or_reservation) dejan el patrón DROP+ADD incondicional -- que
// revalidaba la tabla entera bajo ACCESS EXCLUSIVE en CADA deploy, para
// siempre -- por un guard `pg_constraint` (DO $$ IF NOT EXISTS ... $$):
// el ADD solo corre (y revalida) la primera vez que un tenant no lo
// tiene. NO se movieron a `migrations/NNN_*.sql` -- esa carpeta no está
// conectada a `applyTenantSchema()`, así que un tenant nuevo nunca
// recibiría el CHECK. Ver schema.sql, comentario del primer bloque
// (`chk_financial_transactions_amount`) para el razonamiento completo.
// v52 (12/09/2026): Bloque 1 de docs/diseno-reconciliacion-city-ledger-
// 2026-09-12.md (gate architecture-governor, aprobado con condiciones).
// `accounts_receivable` gana el estado terminal REVERTIDO (mismo guard
// pg_constraint que v51) + `reversed_by`/`reversed_at`/`reversed_reason`
// + `reversal_transaction_id`/`replaces_ar_id` (ON DELETE NO ACTION
// explícito, ver schema.sql BLOQUE 9). Solo schema -- inerte hasta que
// exista `reverseTransfer()` (Bloque 2, no incluido acá).
// v53 (13/09/2026): CITY-LEDGER-CUSTOMER-BALANCE-STATUS-ASYMMETRY-001,
// paso 1 (grounding auditor-circuitos-erp + gate architecture-governor).
// `accounts_receivable` gana `guest_payment_transaction_id` -- vincula la
// pata del huésped (PAYMENT sintético) de transferStayBalanceToReceivable()
// con la fila, simétrico a `financial_transaction_id` (pata empresa, ya
// existía). Nullable, sin backfill retroactivo. Acompaña el cambio de
// código del mismo commit (transferStayBalanceToReceivable() y
// getNetBalanceByCustomerId(), paso 3 del mismo ítem).
// v54 (14/09/2026): mecanismo general de reversa del ledger (grounding
// auditor-circuitos-erp + gate architecture-governor, docs/diseno-
// reconciliacion-city-ledger-2026-09-12.md §4.2/§4.3). `financial_transactions`
// gana `reversed_transaction_id` (auto-referencial, solo ADJUSTMENT, mismo
// patrón que `reversed_entry_id`/`reversal_of` de Odoo/ERPNext) + 2 CHECK
// (anti-loop, tipo) + índice. `SqlFinancialTransactionRepository::insert()`
// acepta ahora ese campo como documento de origen válido (guard F1-Pieza 2
// generalizado, no relajado). `accounts_receivable.reversal_transaction_id`
// (v52) se retira -- redundante con el campo nuevo, 0 call sites, 0 filas
// en producción. Destraba Finding A de `reverseTransfer()` (Bloque 2,
// todavía sin implementar).
// v55 (14/09/2026): CANCEL-POLICY-SCOPE-BASE-001, residuo de "dónde vive el
// campo snapshot-vs-live" (docs/pendientes-2026-09-12.md, decisión del dueño
// vía AskUserQuestion). `cancellation_policies` gana `policy_resolution_timing`
// (enum, NOT NULL DEFAULT 'SNAPSHOT_AT_BOOKING') + CHECK -- ver docblock en
// schema.sql. Solo schema + CRUD (repositorio/servicio/rutas) -- inerte
// hasta que exista snapshot congelado en `reservations` (Block 2, no
// incluido acá).
// v56 (15/09/2026): docs/diseno-factura-borrador-2026-08-31.md §29.7 (gate
// architecture-governor, Bloque A de 4 -- SOLO schema). `service_items`
// nueva (MAESTRO: catálogo de servicios administrativos/intangibles, mismo
// patrón estructural que `products`, category_id nullable hacia
// resource_categories, active + deleted_at desde el día uno). `order_items`
// gana `service_item_id` (FK nullable), el CHECK de `item_type` pasa a 4
// valores (PRODUCT/PRODUCT_VARIANT/RESERVATION/SERVICE, nombre nuevo
// chk_order_item_type) y `chk_order_item_polymorphic` se rediseña a 4 ramas
// bajo nombre nuevo chk_order_item_polymorphic_service (guard pg_constraint,
// mismo criterio que v51 -- nombre nuevo para que el DROP+ADD no revalide la
// tabla en cada deploy siguiente). Repositorio, rutas y wiring de precio/
// descripción quedan para los Bloques B/C/D, cada uno con su propio gate.
// v57 (15/09/2026): docs/diseno-cancelacion-con-nota-credito-comun-2026-09-06.md
// §6.5 bis (reapertura, gatillo 1: reconciliación manual real de
// FAILED_UNCERTAIN -- HOLD del 08/09/2026 levantado). `credit_note_request`
// nueva (TRANSACCIÓN de workflow: trackea un intento de emisión de NC del
// escape fiscal N1.a, máquina de estados propia de 3 valores + `resolution_
// outcome` separado, FK a invoices + order_id/reservation_id nullable con
// CHECK CASE-based "= 1" igual que financial_transactions, `sla_alert_sent_at`
// para el worker de SLA de la pregunta 2). Bump elegido en el momento
// (v56 ya tomado en esta misma sesión por el bloque paralelo de
// `service_items`, ver entrada de arriba) -- siguiente número disponible,
// no el 56 citado originalmente en el diseño. Solo schema -- repositorio,
// rutas, worker `CreditNoteReviewSlaWorker` y el wiring de
// cancelOrderWithCreditNote()/cancelReservationWithCreditNote() quedan para
// bloques separados, cada uno con su propio gate.
// v58 (15/09/2026): Bloque 5 del ADR común cancelar-con-NC (§6.5 bis,
// pregunta de negocio 1, opción (b)). `invoices` gana `uncertain_cleared_at`/
// `uncertain_cleared_by` (nullable, sin backfill, ver BLOQUE 24 en
// schema.sql) -- el desbloqueo que `POST /api/credit-note-requests/:id/resolve`
// con `outcome: 'NO_EMITIDA'` escribe para que `retryExisting()` deje de
// negarse a reintentar esa factura. Acompaña el cableado real de las 3
// rutas nuevas (`GET /api/credit-note-requests`, `GET /:id`,
// `POST /:id/resolve`) + `authorizeAny()` + las transiciones EMITIDA/
// NO_EMITIDA de `InvoiceService`, mismo commit.
// v59 (15/09/2026): F2-13 (docs/decisiones-auditoria-fase2-2026-09-15.md
// #2, decisión del dueño) -- unicidad de nombre de recurso. `resources`
// gana el índice único parcial `uq_resources_name` sobre
// `upper(btrim(name))`, acotado a filas `active = TRUE AND deleted_at IS
// NULL` (ver BLOQUE 25 en schema.sql para el razonamiento completo:
// normalización R6, por qué no lleva `business_id`, y por qué no usa el
// guard `pg_constraint` que sí hace falta para CHECK constraints).
// Acompaña `ResourceNameConflictError` (domain/errors.ts, code
// `RESOURCE_NAME_CONFLICT` -- el que `openapi/spec.ts` ya documentaba
// como 409 desde antes, hasta ahora fantasma), el case 409 en
// `error.middleware.ts::domainErrorStatus()`, y el catch de la violación
// real `23505` en `resources.routes.ts` (POST y PUT), mismo commit.
export const CURRENT_SCHEMA_VERSION = 59;

/**
 * Aplica schema.sql (completo, idempotente) contra la tenant DB dada y
 * registra CURRENT_SCHEMA_VERSION en su tabla `schema_migrations`.
 *
 * Reemplaza al flujo manual ("alguien corre schema.sql a mano por SQL
 * Editor o psql" — ver comentario de archivo) en los dos puntos donde el
 * código ya conoce la connection string de un tenant: los endpoints de
 * admin (`repair-tenant-db`, `set-tenant-url`) y el runner masivo
 * (src/scripts/migrate-tenants.ts). Segura de re-correr: mismo criterio
 * idempotente que el resto de schema.sql.
 *
 * @returns la versión máxima registrada en `schema_migrations` después de
 *   aplicar — normalmente CURRENT_SCHEMA_VERSION, pero se lee con MAX() por
 *   si un proceso con código más viejo corre esto contra una BD que un
 *   proceso más nuevo ya migró: nunca reporta un número menor al real.
 */
export async function applyTenantSchema(connectionString: string): Promise<number> {
  const { default: pg } = await import('pg');
  const client = new pg.Client({
    connectionString: stripSslMode(connectionString),
    ssl: sslConfig(),
    connectionTimeoutMillis: 10_000,
  });
  try {
    await client.connect();
    const schemaSQL = await loadTenantSchema();
    await client.query(schemaSQL);
    await client.query(
      `INSERT INTO schema_migrations (version) VALUES ($1) ON CONFLICT (version) DO NOTHING`,
      [CURRENT_SCHEMA_VERSION],
    );
    const result = await client.query<{ max: number }>(
      `SELECT MAX(version)::int AS max FROM schema_migrations`,
    );
    return result.rows[0]?.max ?? CURRENT_SCHEMA_VERSION;
  } finally {
    await client.end();
  }
}
