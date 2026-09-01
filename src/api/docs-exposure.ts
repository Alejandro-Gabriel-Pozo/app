/**
 * @file docs-exposure.ts
 * @description Decide si la documentación interactiva de la API (`/docs`,
 * `/openapi.json` y el redirect de `/`) se monta o no.
 *
 * ## Por qué existe
 * `/docs` (Swagger UI) y `/openapi.json` estaban montados **sin autenticación
 * en producción** desde una etapa temprana del proyecto. No fue una decisión:
 * es un default de armado que nunca se revisó al pasar a producción real con
 * tenants. Cualquiera con la URL veía la superficie completa de la API.
 *
 * Peor: el `info.description` del spec incluía credenciales demo en texto
 * plano junto con las instrucciones para usarlas, y `servers[0]` apunta al
 * origin de producción — o sea que el "Try it out" disparaba contra la base
 * real. Esas credenciales se sacaron del spec en el mismo cambio; sacarlas es
 * independiente de cerrar el endpoint, porque el texto vivía en el repo y en
 * su historia.
 *
 * ## La regla
 * **No se monta en producción.** En cualquier otro entorno, sí.
 *
 * El resultado es `404`, no `401`, y es a propósito: un `401` confirma que el
 * recurso existe. Si la ruta no se monta, el 404 sale del handler por defecto
 * de Express sin código extra.
 *
 * ## Por qué NO hay variable de override
 * La alternativa evaluada era un `EXPOSE_API_DOCS=true` para habilitarlo en
 * staging. Se descartó: hoy no existe un entorno de staging, y una variable
 * que habilita documentación pública es exactamente el tipo de switch que
 * termina prendido en producción sin que nadie lo note. Menos superficie de
 * configuración es menos superficie de riesgo.
 *
 * Si algún día hay staging, la decisión se vuelve a tomar **deliberadamente**
 * —con el criterio de ese momento— en vez de encontrarse con un interruptor
 * ya construido y prendido.
 *
 * ## Por qué no basic auth ni IP allowlist
 * Las dos se evaluaron y se descartaron por superficie, no por esfuerzo:
 * basic auth es un segundo sistema de credenciales que mantener y rotar
 * (el repo no tiene ninguno hoy); una allowlist de IPs detrás del proxy de
 * Render depende de confiar en headers reenviados y se desactualiza sola.
 * Ninguna se justifica sin un consumidor externo, y el dueño confirmó el
 * 01/09/2026 que **nadie fuera del equipo usa `/docs`**.
 */

/**
 * `true` si `/docs`, `/openapi.json` y el redirect de `/` deben montarse.
 *
 * Recibe el entorno como parámetro en vez de leer `process.env` adentro, para
 * que sea verificable sin mutar estado global en los tests.
 */
export function shouldExposeApiDocs(env: NodeJS.ProcessEnv = process.env): boolean {
  return env['NODE_ENV'] !== 'production';
}
