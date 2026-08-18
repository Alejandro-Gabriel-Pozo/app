# Referencia externa — QloApps

> Documento de referencia, no de implementación. QloApps (PrestaShop/PHP,
> licencia OSL v3) es un motor de reservas hotelero open-source maduro y en
> producción real desde hace años. El código en sí no es reusable (stack
> distinto, licencia con obligaciones de atribución) — lo que vale acá son
> las **decisiones de producto ya validadas en el mundo real**, para
> evaluarlas conscientemente antes de construir algo propio (mismo criterio
> que la skill `criterios-negocio`: nombrar la idea, el riesgo, y decidir
> si se aborda ahora o se anota para después — nunca implementar de una
> solo porque "otro ya lo resolvió así").

**Código fuente local (no forma parte de este repo, solo para consulta):**
`C:\Users\Usuario\Downloads\QloApps-develop\QloApps-develop`

Agregado 17/08/2026. Referenciado desde `roadmap-pms-multirubro.md` en
las secciones Channel Manager, Portal de clientes, y Factura Electrónica.

---

## Cómo está organizado QloApps (para ubicarse en el zip)

Es una instalación completa de PrestaShop con módulos propios de QloApps
encima. Lo específico de hotelería vive en `modules/`, prefijado `wk*` o
`qlo*` (desarrollados por Webkul, la empresa detrás de QloApps):

| Carpeta | Qué es |
|---|---|
| `modules/hotelreservationsystem/` | Núcleo de reservas hotelero — disponibilidad, precios, `ChannelManagerServices.php` |
| `modules/qlochannelmanagerconnector/` | Conector a channel manager (ver abajo) |
| `modules/qlohotelreview/` | Reviews de huéspedes |
| `modules/wkhotelfeaturesblock/`, `wkhotelfiltersblock/`, `wkroomsearchblock/`, `wkabouthotelblock/` | Bloques del booking engine público (búsqueda, filtros, ficha del hotel) |
| `pdf/` (usa TCPDF) | Generación de comprobantes/facturas en PDF |

## Qué mirar, y a qué gap del roadmap le pega

### 1. Channel Manager — vía agregador, no integración directa por OTA

**Archivo:** `modules/hotelreservationsystem/classes/ChannelManagerServices.php`

QloApps no integra Booking.com/Expedia/Airbnb uno por uno — se conecta a
**myallocator.com**, un agregador que ya tiene esas integraciones hechas, y
expone métodos como `associateUserToPMS()` / `AssociatePropertyToPMS()`
contra la API de ese agregador.

**Por qué importa:** el roadmap (`roadmap-pms-multirubro.md`) tiene
Channel Manager marcado ❌ como "proyecto grande aparte". Este ejemplo
confirma que la forma realista de abordarlo no es construir 3-4
integraciones propias, sino evaluar un agregador (myallocator u otro
equivalente vigente) y construir un único conector contra su API. Reduce
el alcance real del ítem de "N integraciones" a "una integración +
mapeo de disponibilidad/tarifas".

**Ojo:** el archivo tiene credenciales de ejemplo de un módulo demo
hardcodeadas en texto plano (usuario/password de la API del agregador).
No es algo para replicar — es un recordatorio en carne ajena de por qué
`criterios-negocio` es estricta con esto.

### 2. Booking engine público — catálogo de lo que un portal de reservas necesita

**Módulos:** `wkroomsearchblock`, `wkhotelfiltersblock`,
`wkhotelfeaturesblock`, `wkabouthotelblock`, `qlohotelreview`

El roadmap tiene **Portal de clientes** como prioridad #1 ("es el foco de
la próxima sesión"). Antes de diseñarlo desde cero, estos módulos sirven
como checklist de qué features suele tener un booking engine público
maduro: búsqueda con filtros (fecha, tipo de habitación, capacidad),
ficha de propiedad con features/amenities, reviews de huéspedes. No hay
que construir un booking engine tan grande como el de QloApps de entrada
— pero sirve para no diseñar el portal sin saber qué existe como
estándar de la industria.

### 3. Generación de comprobantes en PDF

**Carpeta:** `pdf/` (usa la librería TCPDF)

Relevante para cuando la integración con TusFacturas.app (AFIP) esté
funcionando: la API de TusFacturas resuelve la parte fiscal/legal, pero
probablemente van a querer también un PDF con la marca propia del
negocio (no solo el comprobante que devuelve el proveedor). QloApps usa
TCPDF — librería PHP, no trasladable directo a su stack Node/TS, pero
el patrón (generar PDF de comprobante con logo/datos del negocio,
separado de la validación fiscal en sí) es el que van a necesitar
igual.

## Qué NO mirar de acá

Todo lo que es específico de PrestaShop como plataforma de e-commerce
(carrito, checkout genérico, gestión de catálogo de productos físicos,
métodos de pago de PrestaShop) — no aplica a un sistema multi-tenant
multirubro como el de ustedes, es infraestructura de un CMS de e-commerce
que QloApps heredó por estar montado sobre PrestaShop, no una decisión de
diseño de hotelería.

## Orden sugerido si se retoma

Coincide con el orden ya definido en `roadmap-pms-multirubro.md`:

1. Portal de clientes (usar el punto 2 de arriba como checklist de
   features a evaluar, no como spec a copiar).
2. Cuando se aborde Channel Manager (más adelante en el roadmap): evaluar
   agregador (myallocator u otro vigente a esa fecha) en vez de
   integraciones directas por OTA — ver punto 1.
3. Al implementar el PDF de facturación propia sobre la integración de
   TusFacturas: usar el punto 3 como referencia de separación de
   responsabilidades (fiscal vs. presentación).
