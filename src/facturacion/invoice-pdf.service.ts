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
 * - Un solo ítem por comprobante (el cobro es un monto único, sin
 *   desglose de líneas a nivel `FinancialTransaction` hoy).
 * - `receptor` asume Consumidor Final -- es el único caso que la UI arma
 *   hoy (`RequestInvoiceInput.buyer` nunca se manda desde el frontend
 *   todavía). Si eso cambia, este archivo necesita resolver la condición
 *   IVA real del receptor contra `getIvaReceptorTypes()`, no adivinarla.
 */

import { InvoicePdfGenerator, type InvoiceData } from '@arcasdk/pdf';
import type { InvoiceRepository } from './invoice.repository.js';
import type { BusinessProfileRepository } from '../repositories/business-profile.repository.js';
import type { CustomerRepository } from '../clientes-finanzas/customer.repository.js';
import { toAfipDate } from './invoice.service.js';
import { CBTE_TIPO_FACTURA_B, CONCEPTO_SERVICIOS, CONDICION_IVA_RECEPTOR_CONSUMIDOR_FINAL, docTipoLabel } from './afip-catalog.constants.js';
import { InvoiceNotFoundError, InvoiceNotIssuedError } from '../domain/errors.js';

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

    const [profile, customer] = await Promise.all([
      this.businessProfileRepo.get(),
      this.customerRepo.getById(invoice.customerId),
    ]);

    // Congelado al crear (schema v26) -- solo cae al valor ACTUAL para
    // comprobantes emitidos antes de que ese campo existiera.
    const emisorCuit = invoice.emisorCuit ?? profile.afipCuit ?? profile.taxId ?? '';

    const domicilioComercial = [profile.fiscalAddressLine1, profile.fiscalAddressCity, profile.fiscalAddressState]
      .filter((part): part is string => !!part)
      .join(', ');

    const isConsumidorFinal = invoice.condicionIvaReceptorId === CONDICION_IVA_RECEPTOR_CONSUMIDOR_FINAL;
    // % real a partir de los montos ya calculados (splitAmount en
    // invoice.service.ts), no default_iva_rate del negocio -- ese puede
    // haber cambiado desde que se emitió este comprobante puntual.
    const alicuotaIvaPct = invoice.impNeto > 0 ? Math.round((invoice.impIva / invoice.impNeto) * 10000) / 100 : 0;

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
      items: [
        {
          descripcion: invoice.concepto === CONCEPTO_SERVICIOS ? 'Servicios' : 'Productos',
          cantidad: 1,
          unidadMedida: 'unidad',
          precioUnitario: invoice.impNeto,
          subtotal: invoice.impNeto,
          ...(invoice.impIva > 0 && { alicuotaIva: alicuotaIvaPct }),
        },
      ],
      importeNetoGravado: invoice.impNeto,
      ...(invoice.impIva > 0 && {
        iva: [{ id: 5, descripcion: `${alicuotaIvaPct}%`, baseImponible: invoice.impNeto, importe: invoice.impIva }],
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
