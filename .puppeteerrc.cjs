const { join } = require('node:path');

// Sin esto, Puppeteer descarga Chromium en el home del usuario
// (~/.cache/puppeteer, ej. /opt/render/.cache/puppeteer en Render) durante
// el build. Render corre build y runtime en contenedores/filesystems
// separados -- solo el directorio del proyecto viaja de uno a otro, así que
// en runtime esa carpeta está vacía y `@arcasdk/pdf` (Puppeteer) revienta
// con "Could not find Chrome". Redirigiendo el caché adentro del proyecto,
// el Chromium descargado en el build sí llega a runtime. Ver
// https://pptr.dev/guides/configuration.
/** @type {import('puppeteer').Configuration} */
module.exports = {
  cacheDirectory: join(__dirname, '.cache', 'puppeteer'),
};
