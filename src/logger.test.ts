/**
 * @file logger.test.ts
 * @description D-02 (17/09/2026, Wave 8) -- prueba prescrita por el propio
 * plan (docs/plan-ejecucion-integral-2026-09-16.md, Etapa 4): montar
 * `pino-http` con el logger real, mandar un request con `authorization`,
 * `cookie` y query string, y asegurar que la línea emitida NO contiene
 * ninguno de los tres valores. Corre contra un server HTTP real (no un
 * doble de `req`/`res`) para no depender de que el mock reproduzca fiel
 * el shape que `pino-http` espera.
 *
 * Importa `REDACT_PATHS`/`redactedReqSerializer` REALES de `logger.ts` --
 * no una copia inline -- para que un cambio (o una regresión) en la
 * config real se refleje acá sin que nadie tenga que acordarse de
 * actualizar el test por separado.
 *
 * Dos mitades, las dos con prueba negativa corrida a mano antes de
 * commitear (no solo la positiva):
 *   (1) lado `req` -- Authorization/Cookie de entrada + query string.
 *   (2) lado `res` -- `Set-Cookie` de salida (login/refresh dejaban el
 *       JWT recién emitido en cada línea; hallazgo del gate
 *       `architecture-governor`, HOLD F1, 17/09/2026 -- el banco de
 *       prueba original de la auditoría usaba un GET que nunca seteaba
 *       cookie, así que el hueco no aparecía en su propia evidencia).
 * Más una cerca sobre el CABLEADO en sí (no solo la función pura): sin
 * pasarle `serializers` a `pinoHttp()` en `app.ts`, la query string sigue
 * filtrando pese a que `logger.ts` esté bien -- ver el docblock de
 * `logger.ts` para el porqué (asimetría `redact` hereda / `serializers`
 * no). Test 3 lee el código fuente de `app.ts` y falla si esa cadena
 * desaparece -- no ejercita `createApp()` real porque necesita Postgres;
 * es un chequeo de texto, no de comportamiento, declarado así a
 * propósito (mismo criterio que `schema-line-anchor-drift.test.ts`).
 */

import { describe, it, expect } from 'vitest';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Writable } from 'node:stream';
import pino from 'pino';
import { pinoHttp } from 'pino-http';
import { REDACT_PATHS, redactedReqSerializer } from './logger.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

function buildTestLoggerWithSink(): { logger: pino.Logger; lines: string[] } {
  const lines: string[] = [];
  const sink = new Writable({
    write(chunk: Buffer, _enc, cb) {
      lines.push(chunk.toString());
      cb();
    },
  });
  const logger = pino(
    { redact: { paths: REDACT_PATHS, censor: '[Redacted]' }, serializers: { req: redactedReqSerializer } },
    sink,
  );
  return { logger, lines };
}

async function withTestServer(
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => void,
  testLogger: pino.Logger,
  run: (port: number) => Promise<void>,
): Promise<void> {
  const middleware = pinoHttp({ logger: testLogger, serializers: { req: redactedReqSerializer } });
  const server = http.createServer((req, res) => {
    middleware(req, res, () => handler(req, res));
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  try {
    await run(port);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe('D-02 -- pino-http no emite secretos en el log de cada request', () => {
  it('lado req: la línea no contiene el Bearer, la cookie de entrada ni la query string -- el path sí queda', async () => {
    const { logger: testLogger, lines } = buildTestLoggerWithSink();

    await withTestServer(
      (_req, res) => {
        res.statusCode = 200;
        res.end('ok');
      },
      testLogger,
      async (port) => {
        await new Promise<void>((resolve, reject) => {
          const req = http.request(
            {
              host: '127.0.0.1',
              port,
              path: '/api/customers?email=cliente%40test.com&name=Juan+Perez',
              headers: {
                authorization: 'Bearer super-secret-jwt-token',
                cookie: 'rh_token=super-secret-cookie-value',
              },
            },
            (res) => {
              res.on('data', () => {});
              res.on('end', resolve);
            },
          );
          req.on('error', reject);
          req.end();
        });
      },
    );

    const emitted = lines.join('\n');
    expect(emitted).not.toContain('super-secret-jwt-token');
    expect(emitted).not.toContain('super-secret-cookie-value');
    expect(emitted).not.toContain('cliente%40test.com');
    expect(emitted).not.toContain('cliente@test.com');
    expect(emitted).toContain('/api/customers');
  });

  it('lado res: la línea no contiene el Set-Cookie de salida, ni una sola cookie ni un array de varias (login/refresh, HOLD F1 del gate 17/09/2026)', async () => {
    const { logger: testLogger, lines } = buildTestLoggerWithSink();

    await withTestServer(
      (_req, res) => {
        // Mismo shape que auth.middleware.ts::setAuthCookie() -- res.cookie(...)
        // termina en un header Set-Cookie con el JWT como valor. Node/Express
        // representan varias cookies del mismo response como un ARRAY, no
        // concatenadas en un string -- verificado (gate `architecture-governor`,
        // 17/09/2026) que fast-redact censura el valor completo del array, no
        // solo strings sueltos.
        res.setHeader('Set-Cookie', ['rh_token=JWT_DE_LOGIN_RECIEN_EMITIDO; HttpOnly; Path=/', 'rh_customer_token=OTRO_JWT_RECIEN_EMITIDO; HttpOnly; Path=/']);
        res.statusCode = 200;
        res.end('ok');
      },
      testLogger,
      async (port) => {
        await new Promise<void>((resolve, reject) => {
          const req = http.request({ host: '127.0.0.1', port, path: '/api/auth/login' }, (res) => {
            res.on('data', () => {});
            res.on('end', resolve);
          });
          req.on('error', reject);
          req.end();
        });
      },
    );

    const emitted = lines.join('\n');
    expect(emitted).not.toContain('JWT_DE_LOGIN_RECIEN_EMITIDO');
    expect(emitted).not.toContain('OTRO_JWT_RECIEN_EMITIDO');
  });

  it('app.ts cablea el serializer explícito en pinoHttp() -- sin esto, la query string filtra igual pese a logger.ts', () => {
    const appTsSource = readFileSync(join(__dirname, 'app.ts'), 'utf-8');
    const pinoHttpCallMatch = appTsSource.match(/pinoHttp\(\{.*\}\)\)/);
    expect(pinoHttpCallMatch, 'no se encontró ningún app.use(pinoHttp({...})) en app.ts').not.toBeNull();
    const pinoHttpCall = pinoHttpCallMatch![0];
    expect(pinoHttpCall).toContain('serializers');
    expect(pinoHttpCall).toContain('redactedReqSerializer');
  });
});
