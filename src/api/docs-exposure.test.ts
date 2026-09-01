import { describe, it, expect } from 'vitest';
import { shouldExposeApiDocs } from './docs-exposure.js';
import { openApiSpec } from '../openapi/spec.js';

describe('shouldExposeApiDocs', () => {
  it('NO expone la documentación con NODE_ENV=production', () => {
    expect(shouldExposeApiDocs({ NODE_ENV: 'production' })).toBe(false);
  });

  it('la expone en desarrollo — el flujo local no cambia', () => {
    expect(shouldExposeApiDocs({ NODE_ENV: 'development' })).toBe(true);
  });

  it('la expone en test y en staging', () => {
    expect(shouldExposeApiDocs({ NODE_ENV: 'test' })).toBe(true);
    expect(shouldExposeApiDocs({ NODE_ENV: 'staging' })).toBe(true);
  });

  it('la expone si NODE_ENV no está seteada — el default de un dev nuevo', () => {
    expect(shouldExposeApiDocs({})).toBe(true);
  });

  it('solo el valor exacto "production" cierra la puerta', () => {
    // Si mañana alguien escribe "Production" o "prod", la doc queda expuesta.
    // Se fija acá para que la fragilidad sea visible en vez de sorpresiva: el
    // valor lo pone Render, no una persona, y el resto del repo compara igual
    // (`app.ts` para CORS, `auth.middleware.ts` para cookies seguras).
    expect(shouldExposeApiDocs({ NODE_ENV: 'Production' })).toBe(true);
    expect(shouldExposeApiDocs({ NODE_ENV: 'prod' })).toBe(true);
  });

  it('no lee process.env por su cuenta — el entorno entra por parámetro', () => {
    // Garantiza que el test no dependa de mutar estado global, y que la
    // función sea verificable en cualquier orden de ejecución.
    const previo = process.env['NODE_ENV'];
    expect(shouldExposeApiDocs({ NODE_ENV: 'production' })).toBe(false);
    expect(process.env['NODE_ENV']).toBe(previo);
  });
});

describe('el spec de OpenAPI no publica credenciales', () => {
  /**
   * Cerca eléctrica. El spec se sirve en `/docs` y `/openapi.json`, y hasta el
   * 01/09/2026 incluía una tabla con usuarios demo y sus contraseñas en texto
   * plano — expuesta sin autenticación en producción. Cerrar el endpoint no
   * alcanza: si las credenciales vuelven al spec, vuelven al repo y a su
   * historia.
   */
  const serializado = JSON.stringify(openApiSpec);

  it('no contiene las contraseñas que estaban publicadas', () => {
    for (const password of ['Admin1234!', 'recep123', 'waiter123']) {
      expect(serializado).not.toContain(password);
    }
  });

  it('no contiene una tabla de credenciales', () => {
    expect(serializado.toLowerCase()).not.toContain('| contraseña |');
    expect(serializado.toLowerCase()).not.toContain('credenciales demo**\\n\\n| email');
  });

  it('no contiene ningún par email/clave con formato de tabla markdown', () => {
    // Cualquier fila `| algo@dominio | algo |` en el spec es sospechosa.
    const filaConEmail = /\|\s*[\w.+-]+@[\w.-]+\s*\|\s*\S+\s*\|/;
    expect(serializado).not.toMatch(filaConEmail);
  });

  /**
   * Las tres aserciones de arriba son lista negra: atrapan **el incidente
   * histórico**, no la clase. Una contraseña NUEVA en los mismos lugares
   * pasaría limpia — y lo demostró el governor rompiendo la cerca.
   *
   * Estas dos son estructurales: prohíben la **forma**, no el valor. Cubren
   * justamente los dos sitios que Swagger UI **precarga en el "Try it out"**,
   * que dispara contra `servers[0]` = producción. Son los peligrosos.
   */
  const login = (openApiSpec as { paths: Record<string, unknown> }).paths['/api/login'] as {
    post: { requestBody: { content: Record<string, Record<string, unknown>> } };
  };
  const cuerpoJson = login.post.requestBody.content['application/json']!;

  it('el requestBody de /api/login no declara `examples` ni `example`', () => {
    // Un ejemplo de login ES una credencial: no hay valor seguro que poner.
    expect(cuerpoJson['examples']).toBeUndefined();
    expect(cuerpoJson['example']).toBeUndefined();
  });

  it('el schema LoginRequest no declara `example` en `password`', () => {
    const schemas = (openApiSpec as { components: { schemas: Record<string, unknown> } })
      .components.schemas;
    const loginRequest = schemas['LoginRequest'] as {
      properties: { password: Record<string, unknown> };
    };
    expect(loginRequest.properties.password['example']).toBeUndefined();
  });
});
