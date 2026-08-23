/**
 * @file invoice-pdf.service.ts
 * @description Genera el PDF oficial (diseño ARCA/AFIP, QR de verificación
 * incluido) de un comprobante YA emitido, vía `@arcasdk/pdf` — no
 * reinventa el layout, reusa el paquete hermano de `@arcasdk/core` (mismo
 * proveedor, mismo protocolo). R14 (criterios-datos.md): un solo camino,
 * no una plantilla propia paralela.
 *
 * `invoices` es DOCUMENTO (criterios-datos.md Parte 1) — sin CAE no hay
 * comprobante fiscal real que representar, así que esto rechaza fuerte
 * (InvoiceNotIssuedError) en vez de imprimir un PDF "provisorio".
 *
 * Simplificaciones deliberadas de este primer corte (documentadas para no
 * confundirlas con datos perdidos):
 * - `emisor.iibb`/`fechaInicioActividades` quedan vacíos -- el sistema no
 *   carga esos datos todavía (no forman parte de la Fase 1 fiscal).
 * - `receptor` asume Consumidor Final -- es el único caso que la UI arma
 *   hoy (`RequestInvoiceInput.buyer` nunca se manda desde el frontend
 *   todavía). Si eso cambia, este archivo necesita resolver la condición
 *   IVA real del receptor contra `getIvaReceptorTypes()`, no adivinarla.
 *
 * D8-Nivel B (23/08/2026, docs/diseno-facturacion-lineas-nivel-b-2026-08-23.md)
 * — `items[]` muestra productos/reservas reales cuando el comprobante
 * tiene `invoice_items` (emitido después de este cambio). Comprobantes
 * viejos (Nivel A, D8, sin filas en `invoice_items`) siguen mostrando el
 * ítem sintético agrupado por tasa de IVA, para siempre -- decisión del
 * dueño, sin reconstrucción retroactiva. `iva[]`/los totales del
 * comprobante NO cambian con Nivel B: siguen saliendo de
 * `afipRequest.Iva` (ya frozen al emitir, R9) en los dos casos.
 */

import { InvoicePdfGenerator, type InvoiceData } from '@arcasdk/pdf';
import type { InvoiceRepository } from './invoice.repository.js';
import type { BusinessProfileRepository } from '../repositories/business-profile.repository.js';
import type { CustomerRepository } from '../clientes-finanzas/customer.repository.js';
import { toAfipDate } from './invoice.service.js';
import { CBTE_TIPO_FACTURA_B, CONCEPTO_SERVICIOS, CONDICION_IVA_RECEPTOR_CONSUMIDOR_FINAL, docTipoLabel, paymentMethodLabel, ivaAlicuotaLabel, ivaAlicuotaPercentFromId } from './afip-catalog.constants.js';
import { InvoiceNotFoundError, InvoiceNotIssuedError } from '../domain/errors.js';

/**
 * Lee `afipRequest.Iva` (D8, 22/08/2026) -- el `afipRequest` real mandado
 * a AFIP al emitir, congelado en `invoices.afip_request` (JSONB, R9).
 * `unknown` porque `Invoice.afipRequest` no tiene un tipo propio (se
 * persiste tal cual se construyó en `InvoiceService.requestInvoice()`) --
 * lectura defensiva, nunca asume la forma sin chequear.
 */
function readAfipIvaGroups(afipRequest: unknown): Array<{ id: number; baseImp: number; importe: number }> {
  if (typeof afipRequest !== 'object' || afipRequest === null || !('Iva' in afipRequest)) return [];
  const iva = (afipRequest as { Iva?: unknown }).Iva;
  if (!Array.isArray(iva)) return [];
  return iva
    .filter((entry): entry is { Id: number; BaseImp: number; Importe: number } =>
      typeof entry === 'object' && entry !== null && 'Id' in entry && 'BaseImp' in entry && 'Importe' in entry)
    .map((entry) => ({ id: Number(entry.Id), baseImp: Number(entry.BaseImp), importe: Number(entry.Importe) }));
}

export class InvoicePdfService {
  constructor(
    private readonly invoiceRepo: InvoiceRepository,
    private readonly businessProfileRepo: BusinessProfileRepository,
    private readonly customerRepo: CustomerRepository,
  ) {}

  async generate(id: string): Promise<Buffer> {
    const invoice = await this.invoiceRepo.getById(id);
    if (!invoice) throw new InvoiceNotFoundError(id);
    if (invoice.status !== 'ISSUED' || !invoice.cae || !invoice.cbteNro || !invoice.caeVto) {
      throw new InvoiceNotIssuedError(id);
    }

    const [profile, customer, invoiceItems] = await Promise.all([
      this.businessProfileRepo.get(),
      this.customerRepo.getById(invoice.customerId),
      this.invoiceRepo.getItemsByInvoiceId(id),
    ]);

    // Congelado al crear (schema v26) -- solo cae al valor ACTUAL para
    // comprobantes emitidos antes de que ese campo existiera.
    const emisorCuit = invoice.emisorCuit ?? profile.afipCuit ?? profile.taxId ?? '';

    const domicilioComercial = [profile.fiscalAddressLine1, profile.fiscalAddressCity, profile.fiscalAddressState]
      .filter((part): part is string => !!part)
      .join(', ');

    const isConsumidorFinal = invoice.condicionIvaReceptorId === CONDICION_IVA_RECEPTOR_CONSUMIDOR_FINAL;
    const condicionVenta = paymentMethodLabel(invoice.paymentMethod, invoice.cardInstallments);

    // D8 (22/08/2026) -- `invoice.afipRequest.Iva` es el desglose REAL por
    // tasa, congelado al emitir (R9) -- una orden con productos a 21% y
    // 10.5% ya no tiene un único "% real" que calcular desde impNeto/impIva
    // (eso da un blend sin sentido fiscal, ej. "18.2%", que no es ninguna
    // alícuota real de AFIP). Se lee directo de ahí en vez de recalcular.
    const ivaGroups = readAfipIvaGroups(invoice.afipRequest);

    const data: InvoiceData = {
      emisor: {
        razonSocial: profile.legalName ?? '',
        domicilioComercial,
        condicionIva: profile.taxCondition ?? '',
        cuit: emisorCuit,
        iibb: '',
        fechaInicioActividades: '',
      },
      receptor: {
        razonSocial: isConsumidorFinal ? (customer?.fullName ?? 'Consumidor Final') : (customer?.fullName ?? ''),
        condicionIva: isConsumidorFinal ? 'Consumidor Final' : '',
        documentoTipo: docTipoLabel(invoice.docTipo),
        documentoNro: invoice.docNro,
      },
      cbteTipo: invoice.cbteTipo,
      cbteLetra: invoice.cbteTipo === CBTE_TIPO_FACTURA_B ? 'B' : String(invoice.cbteTipo),
      puntoVenta: invoice.ptoVta,
      cbteDesde: invoice.cbteNro,
      cbteHasta: invoice.cbteNro,
      cbteFecha: toAfipDate(invoice.issuedAt ?? invoice.createdAt),
      concepto: invoice.concepto,
      moneda: invoice.moneda,
      ...(condicionVenta !== undefined && { condicionVenta }),
      // D8-Nivel B (23/08/2026) -- si el comprobante tiene líneas reales
      // (invoice_items, emitido después de este cambio), se muestran los
      // productos/reservas reales. Si no (factura Nivel A, vieja -- ver
      // docs/diseno-facturacion-lineas-nivel-b-2026-08-23.md decisión 2,
      // "sigue mostrando el ítem agrupado por tasa para siempre"), cae al
      // ítem sintético por grupo de tasa de D8, sin cambios.
      items: invoiceItems.length > 0
        ? invoiceItems.map((item) => ({
            descripcion: item.description,
            cantidad: item.quantity,
            unidadMedida: item.unit ?? 'unidad',
            precioUnitario: item.unitPrice,
            subtotal: item.subtotal,
            alicuotaIva: item.ivaRate,
          }))
        : ivaGroups.length > 0
        ? ivaGroups.map((g) => ({
            descripcion: `${invoice.concepto === CONCEPTO_SERVICIOS ? 'Servicios' : 'Productos'} (${ivaAlicuotaLabel(g.id)})`,
            cantidad: 1,
            unidadMedida: 'unidad',
            precioUnitario: g.baseImp,
            subtotal: g.baseImp,
            alicuotaIva: ivaAlicuotaPercentFromId(g.id) ?? 0,
          }))
        : [
            {
              descripcion: invoice.concepto === CONCEPTO_SERVICIOS ? 'Servicios' : 'Productos',
              cantidad: 1,
              unidadMedida: 'unidad',
              precioUnitario: invoice.impNeto,
              subtotal: invoice.impNeto,
            },
          ],
      importeNetoGravado: invoice.impNeto,
      ...(ivaGroups.length > 0 && {
        iva: ivaGroups.map((g) => ({
          id: g.id,
          descripcion: ivaAlicuotaLabel(g.id),
          baseImponible: g.baseImp,
          importe: g.importe,
        })),
      }),
      importeIva: invoice.impIva,
      importeTotal: invoice.impTotal,
      cae: invoice.cae,
      caeFechaVencimiento: invoice.caeVto.replace(/-/g, ''),
    };

    const generator = new InvoicePdfGenerator();
    const pdf = await generator.generate(data);
    // @arcasdk/pdf declara Promise<Buffer> pero page.pdf() de Puppeteer
    // devuelve Uint8Array en runtime (desde que Puppeteer dejó de atarse a
    // la API de Node) -- el propio paquete lo sabe y lo corrige en su
    // camino de "múltiples copias" (_mergeBuffers, vía pdf-lib), pero no en
    // el camino normal de una sola copia, que es el que usamos acá. Sin
    // este Buffer.from(), Express.res.send() no reconoce el Uint8Array
    // como binario (Buffer.isBuffer() da false) y cae a res.json(), que
    // serializa cada byte como una clave de objeto -- el PDF que le llega
    // al cliente no es un PDF, es texto JSON con extensión .pdf.
    return Buffer.from(pdf);
  }
}
