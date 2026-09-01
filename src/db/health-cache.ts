/**
 * @file health-cache.ts
 * @description Chequeo de salud de BD con caché de vencimiento corto y
 * single-flight, para que un ping de liveness no se traduzca en una consulta
 * por request.
 *
 * ## Por qué existe
 * Render pinguea `healthCheckPath: /health` (render.yaml) y además hay un bot
 * externo que mantiene despierto el servicio del plan free. En Neon con
 * scale-to-zero, cada consulta despierta la base y la mantiene activa: un
 * `SELECT 1` por ping es tiempo de cómputo pago sin actividad de negocio
 * detrás.
 *
 * ## Qué NO hace, a propósito
 * **No esconde una base caída.** Tres decisiones deliberadas:
 *
 * 1. **TTL asimétrico.** Un OK se cachea `okTtlMs`; un fallo, `failTtlMs`
 *    (mucho más corto). Ahorrar consultas no puede retrasar la detección de
 *    una caída — degradar con ruido, no en silencio
 *    (`docs/DEFENSIVE_DEVELOPING.md:33`).
 * 2. **La edad se expone siempre.** El caller recibe `checkedAt`/`ageMs`/
 *    `cached` y puede decidir si un valor de hace 28 s le sirve. Un OK
 *    cacheado nunca se presenta como un OK fresco.
 * 3. **Hay salida de escape.** `get({ fresh: true })` fuerza consulta real,
 *    para deploys, monitoreo e incidentes. **Con un límite conocido:** si ya
 *    hay una sonda en vuelo, `fresh` se suma a esa sonda en vez de abrir
 *    otra (ver "Single-flight"). Como `checkDatabaseHealth` **no tiene
 *    timeout**, una sonda colgada contra una conexión TCP muerta deja
 *    `inFlight` sin resolver y `fresh` cuelga con ella. O sea que la salida
 *    de escape **no funciona durante un cuelgue**, que es justo uno de los
 *    incidentes para los que se pensó. No empeora lo que había —antes cada
 *    request colgaba por su cuenta— pero es una promesa acotada, no absoluta.
 *    Se resuelve con un timeout en la sonda: bloque aparte.
 *
 * ## Single-flight
 * Si llegan N requests juntos y hace falta refrescar, se dispara **una** sola
 * consulta y los demás esperan esa misma promesa. A la escala actual (una
 * instancia, tráfico bajo) el ahorro es marginal; el valor real es acotar el
 * peor caso si el endpoint profundo queda expuesto a un monitor con sondas
 * paralelas.
 *
 * Un `fresh: true` que llega con una consulta ya en vuelo **se suma a esa
 * consulta** en vez de abrir otra: la que está corriendo también es fresca.
 *
 * ## Límite conocido: la caché es POR PROCESO
 * No hay estado compartido. Con N instancias hay hasta N consultas por ventana
 * de TTL en vez de una. Sigue acotado y degrada de forma proporcional; una
 * caché compartida exigiría Redis, que hoy no existe en el stack (ver
 * "Deuda estructural: Redis rate-limit" en pendientes) y queda fuera de
 * alcance.
 */

export interface DbHealthSnapshot {
  /** `true` si la última verificación conocida (fresca o cacheada) fue exitosa. */
  ok: boolean;
  /** Epoch ms del momento en que se ejecutó la consulta que produjo este valor. */
  checkedAt: number;
  /** Antigüedad del valor en ms. `0` = recién consultado. */
  ageMs: number;
  /** `true` si se sirvió de caché sin consultar la base. */
  cached: boolean;
}

export interface CachedDbHealthOptions {
  /** Cuánto vale un OK antes de re-consultar. */
  okTtlMs?: number;
  /** Cuánto vale un FALLO. Debe ser menor que `okTtlMs`: un problema se
   *  re-chequea antes que una confirmación de salud. */
  failTtlMs?: number;
  /** Inyectable para tests deterministas, sin timers reales. */
  now?: () => number;
}

export class CachedDbHealth {
  private last: { ok: boolean; at: number } | undefined;
  private inFlight: Promise<boolean> | undefined;

  private readonly okTtlMs: number;
  private readonly failTtlMs: number;
  private readonly now: () => number;

  constructor(
    private readonly probe: () => Promise<boolean>,
    options: CachedDbHealthOptions = {},
  ) {
    this.okTtlMs = options.okTtlMs ?? 30_000;
    this.failTtlMs = options.failTtlMs ?? 5_000;
    this.now = options.now ?? Date.now;
  }

  async get(options: { fresh?: boolean } = {}): Promise<DbHealthSnapshot> {
    const t = this.now();

    if (!options.fresh && this.last !== undefined) {
      const ttl = this.last.ok ? this.okTtlMs : this.failTtlMs;
      const age = t - this.last.at;
      if (age < ttl) {
        return { ok: this.last.ok, checkedAt: this.last.at, ageMs: age, cached: true };
      }
    }

    // Single-flight: una sola consulta en vuelo; el resto espera la misma.
    this.inFlight ??= this.probe()
      .then((ok) => {
        this.last = { ok, at: this.now() };
        return ok;
      })
      .catch(() => {
        // `probe` no debería tirar (checkDatabaseHealth atrapa), pero si lo
        // hace se trata como fallo — nunca se propaga una excepción a un
        // endpoint de salud.
        this.last = { ok: false, at: this.now() };
        return false;
      })
      .finally(() => {
        this.inFlight = undefined;
      });

    const ok = await this.inFlight;
    const at = this.last?.at ?? this.now();
    return { ok, checkedAt: at, ageMs: Math.max(0, this.now() - at), cached: false };
  }
}
