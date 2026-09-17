/**
 * @file afip-request.timeout.ts
 * @description D-20 (Wave 9, 17/09/2026 --
 * docs/auditoria-integral-fase15-2026-09-16.md:579-599). Timeout de
 * aplicación compartido por las 7 llamadas reales al SDK de AFIP
 * (`@arcasdk/core`) de todo el repo: las 4 de `arca-sdk-billing.adapter.ts`
 * (`InvoiceService`) + las 3 de `padron.service.ts` (autocompletado de
 * padrón). Extraído a un módulo propio porque la primera versión de este
 * bloque (gate `architecture-governor`, primera pasada -- HOLD) cubría
 * SOLO las 4 de `arca-sdk-billing.adapter.ts`: las 3 de `padron.service.ts`,
 * detrás de 3 rutas autenticadas (`POST /api/customers/padron/lookup-by-cuit`,
 * `POST .../lookup-by-dni`, `GET .../iva-receptor-types`), quedaban sin
 * timeout -- exactamente el mismo riesgo de agotamiento de capacidad que
 * este bloque existe para resolver, solo que en la ruta de autocompletado
 * en vez de en la de facturación. Un solo módulo, un solo constante, un
 * solo mecanismo -- no una copia por archivo (DEFENSIVE_DEVELOPING.md,
 * principio 5, "un solo camino por responsabilidad").
 *
 * Por qué un `Promise.race` de aplicación y no un timeout real del SDK:
 * ver el docblock largo de `arca-sdk-billing.adapter.ts` -- `@arcasdk/core`
 * declara un punto de extensión (`soap-client.js:68-78`,
 * `request: adapterRequestOptions`) que NO está alcanzable desde la
 * superficie pública (`Arca`'s constructor nunca reenvía `request`/
 * `requestOptions`, verificado leyendo el código instalado). Parchear el
 * SDK (patch-package) para wirearlo de verdad queda evaluado y no elegido
 * en este bloque -- más invasivo que necesario mientras este wrapper
 * cumpla el mismo contrato observable para los callers.
 */

import { logger } from '../logger.js';

/**
 * Valor único para las 7 llamadas (no diferenciado por endpoint, a
 * diferencia de los 3 no-AFIP de D-20 sub-bloque 2) -- las siete son la
 * misma contraparte (WSFEv1 + padrón) y el mismo SDK. No medido contra
 * latencia real de AFIP -- registrado en docs/pendientes-2026-09-12.md
 * (`D-20-AFIP-TIMEOUT-VALUE-VERIFY-001`).
 *
 * `createNextVoucher()` en particular es una llamada COMPUESTA por dentro
 * del SDK (`create-next-voucher.use-case.js`: primero
 * `FECompUltimoAutorizado`, después `FECAESolicitar`; más el login WSAA
 * lazy de `base-soap-repository.js` si el ticket cacheado venció) -- los
 * 20s de acá son un presupuesto para TODO eso junto, no por sub-llamada.
 * Consecuencia real: un timeout puede dispararse ANTES de que
 * `FECAESolicitar` se haya transmitido siquiera, y aun así
 * `InvoiceService` lo marca `afipContacted: true` (ver docblock de
 * `arca-sdk-billing.adapter.ts`) -- conservador (nunca declara "seguro
 * que no se emitió" cuando no lo sabe), pero cuesta una revisión manual
 * evitable si el presupuesto quedó corto. Con `issue()` encadenando hasta
 * 4 llamadas (getLastVoucher -> createNextVoucher -> [si falla]
 * getLastVoucher -> getVoucherInfo), el techo real de una request de
 * facturación es ~4x este valor (~80s), no 20s -- bounded igual (satisface
 * el hallazgo), pero el numero solo no lo deja ver.
 */
export const AFIP_REQUEST_TIMEOUT_MS = 20_000;

/**
 * `Promise.race` de aplicación contra un timer -- NO cancela el socket TCP
 * subyacente: si el timer gana, la llamada real a AFIP puede seguir en
 * curso del otro lado, y su resolución/rechazo tardío llega igual (la
 * promesa original sigue viva) pero ya no puede afectar al caller, que ya
 * siguió su curso con el error de timeout. Se loguea
 * ese asentamiento tardío en vez de descartarlo en silencio
 * (`honest-degradation`): sin este log, un fault SOAP real que llega
 * después de vencido el timeout (ej. "CAE duplicado", una condición que
 * SÍ importaría diagnosticar) desaparecería sin dejar rastro.
 */
export function withAfipTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      settled = true;
      reject(new Error(`[AFIP] ${label} no respondió en ${AFIP_REQUEST_TIMEOUT_MS}ms`));
    }, AFIP_REQUEST_TIMEOUT_MS);
    // No debe mantener vivo el proceso mientras espera -- mismo criterio
    // verificado por el gate para AbortSignal.timeout() en D-20 sub-bloque 2.
    timer.unref?.();

    promise.then(
      (value) => {
        clearTimeout(timer);
        if (settled) {
          logger.warn({ label }, '[AFIP] la llamada resolvió DESPUÉS de vencer el timeout -- descartada, el caller ya siguió con el error de timeout');
          return;
        }
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        if (settled) {
          logger.warn(
            { label, err: err instanceof Error ? err.message : String(err) },
            '[AFIP] la llamada rechazó DESPUÉS de vencer el timeout -- descartada, el caller ya siguió con el error de timeout',
          );
          return;
        }
        reject(err);
      },
    );
  });
}
