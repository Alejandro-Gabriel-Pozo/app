#!/usr/bin/env node
/**
 * @file concurrency-test-reservations.ts
 * @description Dispara N requests simultáneos de verdad contra
 * `POST /api/reservations` para el mismo recurso + rango horario, y
 * confirma la invariante de negocio: de N intentos concurrentes sobre el
 * mismo hueco, exactamente UNO gana (201) y el resto choca contra el
 * `SELECT ... FOR UPDATE` de `resolveOccupyingReservations()`
 * (reservation-availability.service.ts) con 400 `INVALID_RESERVATION`.
 *
 * ## Por qué hace falta (no es opcional, es la única forma de probar esto)
 * Los 274 tests unitarios de `src/reservas/` nunca ejercitan la rama con
 * lock de `resolveOccupyingReservations()` — los mocks de test no
 * implementan `getActiveForResourceInRangeWithLock()`, así que siempre
 * caen al fallback sin lock (ver el comentario en
 * `reservation.service.ts`, línea ~37: "fallback sin lock si el
 * repositorio no lo implementa, como los mocks en tests"). Un test
 * unitario secuencial jamás va a detectar un bug de scope de transacción
 * en el `FOR UPDATE` real — necesita concurrencia real, con conexiones
 * TCP separadas de verdad. Encontrado corriendo `test:coverage` escopeado
 * a `src/reservas/` (25/08/2026) — 84.7% de cobertura en
 * reservation-availability.service.ts, con exactamente esa rama en 0%.
 *
 * ## Uso
 * Requiere el server local corriendo (`npm run dev`, puerto de `PORT` en
 * `.env`) y un usuario con permiso BOOKING. Recomendado: un usuario de
 * prueba dedicado, no la cuenta real del dueño.
 *
 *   BOOKING_EMAIL=... BOOKING_PASSWORD=... \
 *   RESOURCE_ID=<uuid de un recurso SIN reservas en el rango elegido> \
 *   CUSTOMER_ID=<uuid de un cliente existente> \
 *   npx tsx src/scripts/concurrency-test-reservations.ts
 *
 * Variables opcionales: API_BASE (default http://localhost:3001),
 * CONNECTIONS (default 8, también es el total de requests — una ráfaga,
 * no un test de carga sostenida), START_OFFSET_DAYS (default 90, para
 * caer lejos de cualquier dato real/demo existente).
 *
 * El script NO valida de antemano que el rango esté libre — si el
 * resultado da 0 éxitos CON 0 errores de red, lo más probable es que el
 * recurso ya tenga algo reservado ahí; subí START_OFFSET_DAYS o cambiá
 * de recurso.
 *
 * ## Nota de esta máquina (Windows local, 25/08/2026)
 * Con CONNECTIONS alto (probado 10 y 20) autocannon devolvió `errors`/
 * `timeouts` en vez de respuestas reales — parece agotamiento de puertos
 * efímeros en localhost bajo Windows, no un problema del servidor (con
 * CONNECTIONS=5 las 5 conexiones respondieron bien). El script reporta
 * `errors`/`timeouts` explícitamente para que esto se note en vez de
 * leerse como "0 conflictos" — si aparecen, bajá CONNECTIONS.
 */
import autocannon from 'autocannon';

const API_BASE = process.env['API_BASE'] ?? 'http://localhost:3001';
const CONNECTIONS = Number(process.env['CONNECTIONS'] ?? 8);
const START_OFFSET_DAYS = Number(process.env['START_OFFSET_DAYS'] ?? 90);

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`Falta la variable de entorno ${name}. Ver el docblock del script para el uso completo.`);
    process.exit(1);
  }
  return value;
}

async function login(email: string, password: string): Promise<string> {
  const res = await fetch(`${API_BASE}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) {
    throw new Error(`Login falló (${res.status}): ${await res.text()}`);
  }
  const setCookie = res.headers.get('set-cookie');
  if (!setCookie) {
    throw new Error('El login respondió 200 pero sin Set-Cookie — ¿setAuthCookie cambió de forma?');
  }
  // Solo el par nombre=valor, sin los atributos (HttpOnly, Path, etc.) —
  // node no separa múltiples Set-Cookie en un solo header en fetch nativo,
  // pero acá alcanza con el primero (auth.routes.ts solo setea uno).
  return setCookie.split(';')[0]!;
}

async function main() {
  const email = requireEnv('BOOKING_EMAIL');
  const password = requireEnv('BOOKING_PASSWORD');
  const resourceId = requireEnv('RESOURCE_ID');
  const customerId = requireEnv('CUSTOMER_ID');

  console.log(`Login como ${email}...`);
  const cookie = await login(email, password);

  const startTime = new Date(Date.now() + START_OFFSET_DAYS * 24 * 60 * 60 * 1000);
  startTime.setUTCHours(10, 0, 0, 0);
  const endTime = new Date(startTime.getTime() + 60 * 60 * 1000);

  console.log(`Disparando ${CONNECTIONS} POST /api/reservations simultáneos`);
  console.log(`  recurso=${resourceId}  rango=${startTime.toISOString()} → ${endTime.toISOString()}`);

  const body = JSON.stringify({
    resourceId,
    customer: { id: customerId },
    startTime: startTime.toISOString(),
    endTime: endTime.toISOString(),
    adultos: 1,
  });

  const result = await autocannon({
    url: `${API_BASE}/api/reservations`,
    method: 'POST',
    connections: CONNECTIONS,
    amount: CONNECTIONS,
    headers: {
      'Content-Type': 'application/json',
      'Cookie': cookie,
    },
    body,
  });

  const stats = result.statusCodeStats ?? {};
  const created = stats['201']?.count ?? 0;
  const conflicted = stats['400']?.count ?? 0;
  const other = Object.entries(stats)
    .filter(([code]) => code !== '201' && code !== '400')
    .map(([code, s]) => `${code}×${s.count}`)
    .join(', ');

  console.log('\n── Resultado ──');
  console.log(`201 Created (ganó):        ${created}`);
  console.log(`400 INVALID_RESERVATION:   ${conflicted}`);
  if (other) console.log(`Otros códigos (revisar):   ${other}`);
  if (result.errors || result.timeouts) {
    console.log(`Errores de red: ${result.errors}   Timeouts: ${result.timeouts}`);
  }

  if (result.errors === CONNECTIONS || result.timeouts === CONNECTIONS) {
    console.log('\n⚠️  Ninguna conexión llegó a completarse (errors/timeouts = CONNECTIONS) —');
    console.log('   esto es un problema de red local (agotamiento de puertos en Windows, server');
    console.log('   caído, etc.), NO evidencia de que el lock funcione. Bajá CONNECTIONS y reintentá.');
    process.exitCode = 1;
  } else if (created === 1 && conflicted === CONNECTIONS - 1) {
    console.log('\n✅ El lock serializó bien: exactamente una reserva ganó la carrera.');
  } else if (created === 0 && conflicted === 0) {
    console.log('\n⚠️  Ni éxitos ni conflictos — revisá los errores de red de arriba.');
    process.exitCode = 1;
  } else if (created === 0) {
    console.log('\n⚠️  Nadie ganó — probablemente el rango ya tenía una reserva previa. Subí START_OFFSET_DAYS o cambiá RESOURCE_ID.');
    process.exitCode = 1;
  } else {
    console.log(`\n❌ DOBLE-BOOKING: ${created} reservas quedaron creadas para el mismo recurso/rango — el FOR UPDATE no serializó como se esperaba.`);
    process.exitCode = 1;
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
