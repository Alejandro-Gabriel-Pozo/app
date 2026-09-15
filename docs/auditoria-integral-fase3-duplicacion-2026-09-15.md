# Auditoría técnica integral — Fase 3: duplicación semántica

**Fecha:** 15/09/2026. **Alcance:** solo lectura, ningún archivo de código
modificado. Ejecutado sobre los dos repos:

- Backend — `/home/user/app`
- Frontend — `/home/user/appfrontend`

Continúa `docs/auditoria-integral-fase0-2026-09-15.md` (estado de git/runtime)
y `docs/auditoria-integral-fase1-2026-09-15.md` (mapa estructural + cruces
entre dominios). En paralelo, otro agente (`erp-audit-orchestrator`) rastrea
flujos de datos end-to-end de los circuitos de negocio principales (reservas,
POS, estadías) — ese trabajo no se repite acá.

**Foco de este documento:** no la duplicación estructural de carpetas/nombres
(ya cubierta en Fase 1), sino duplicación de LÓGICA — la misma regla de
negocio, el mismo cálculo, la misma validación, reimplementados en más de un
lugar sin que el segundo lugar sepa del primero. Se distingue de duplicación
DECIDIDA y documentada (que no es un hallazgo).

**Punto de partida:** Fase 1 (X-11, X-12) ya marcó "el frontend redefine
tipos a mano en vez de derivarlos del backend" como **el hueco más grande no
verificado** de esa fase, y `docs/decisiones-auditoria-fase2-2026-09-15.md`
ya registró 4 decisiones del dueño que son, en esencia, hallazgos de
duplicación semántica (D-07 TTL de sesión, D-14 contrato de paginación, D-16
formato de moneda, D-23 códigos `INVALID_TRANSITION` compartidos). Esos 4 NO
se repiten acá como hallazgos nuevos — se listan al final, con su estado de
implementación, solo para trazabilidad.

---

## Hallazgos nuevos

### F3-01 — La fórmula de redondeo de tarifa especial (%) está duplicada byte a byte entre `reservas` y `pos-menu`, sin pasar por `domain/money.ts::round2()`

**Ubicación:**
- `src/reservas/reservation-pricing.service.ts:251-254` (`resolveRateAmount`)
- `src/pos-menu/order-pricing.service.ts:102-105` (`resolveRateAmount`)
- Contraste: `src/domain/money.ts:14-16` (`round2`)

**Evidencia (las dos implementaciones, lado a lado):**

```ts
// src/reservas/reservation-pricing.service.ts:251-254
private resolveRateAmount(rate: { fixedPrice: number | null; discountPercentage: number | null }, basePrice: number): number {
  if (rate.fixedPrice !== null) return rate.fixedPrice;
  return Math.round(basePrice * (1 - rate.discountPercentage! / 100) * 100) / 100;
}
```

```ts
// src/pos-menu/order-pricing.service.ts:102-105
private resolveRateAmount(rate: { fixedPrice: number | null; discountPercentage: number | null }, basePrice: number): number {
  if (rate.fixedPrice !== null) return rate.fixedPrice;
  return Math.round(basePrice * (1 - rate.discountPercentage! / 100) * 100) / 100;
}
```

```ts
// src/domain/money.ts:14-16 — existe exactamente para este propósito
export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
```

El propio docblock de `money.ts` (líneas 4-9) narra que `round2` **ya se
duplicó una vez** (`cancellation-refund.service.ts` / `invoice.service.ts`,
hallazgo de una auditoría externa del 23/08/2026) y se centralizó "al agregar
un tercer lugar que la necesita, en vez de triplicarla". Hoy `round2` se usa
en 10 archivos (`facturacion/*`, `reservas/cancellation-refund.service.ts`,
`clientes-finanzas/payment-application.ts`, `clientes-finanzas/customer-account.service.ts`,
`workers/outbox.handlers.ts`) — pero **no** en los dos `resolveRateAmount()`
de arriba, que reimplementan la misma fórmula (`Math.round(n*100)/100`) a
mano, sobre el mismo tipo de dato (dinero).

**Comportamiento actual:** dos funciones privadas idénticas, en dos módulos
de dominio distintos, calculando lo mismo (precio con descuento % aplicado a
una tarifa especial de cliente) con la misma expresión matemática escrita a
mano dos veces.

**Comportamiento esperado (según el propio patrón que el repo ya se dio):**
una sola función (`round2`, o una nueva `applyDiscount(basePrice, pct)` que
la use internamente) en `domain/money.ts`, llamada desde los dos servicios.

**Ejemplo concreto de cómo divergirían:** si mañana se decide cambiar la
política de redondeo (p. ej. redondear a la baja en vez de al más cercano,
para no perjudicar al negocio en centavos — una decisión de negocio
legítima), el cambio se hace en `round2()` y **automáticamente** cubre a los
10 archivos que ya lo usan — pero **no** a estos dos `resolveRateAmount()`,
que seguirían redondeando "al más cercano" en silencio. El resultado: una
reserva con tarifa especial en `%` y una orden de POS con tarifa especial en
`%` redondearían distinto del resto del sistema (facturación, cuentas
corrientes) sin que ningún test lo detecte, porque no hay ningún test que
compare la política de redondeo entre módulos — cada test unitario de cada
servicio valida su propia fórmula inline.

**Tipo de problema:** duplicación accidental.
**Severidad:** Media (no es dinero mal calculado hoy — la fórmula es
idéntica — pero es exactamente el patrón de deuda que ya causó un hallazgo
de auditoría externa una vez).
**Nivel de certeza:** Alta (las dos funciones leídas completas, texto
idéntico carácter a carácter salvo el nombre de la clase contenedora).
**Impacto:** si diverge, es un bug de dinero silencioso — el tipo de bug que
`criterios-negocio.md` (A3.3, citado en el propio `money.ts`) busca evitar
con "un solo lugar redondea, con política declarada".
**Causa probable:** `reservation-pricing.service.ts` y `order-pricing.service.ts`
son los dos módulos que resuelven precio con tarifa especial de cliente para
ALOJAMIENTO/TURNOS y POS respectivamente — nacieron en paralelo (mismo
comentario "D5" citado en los dos, mismo commit de referencia), y quien
escribió el segundo copió el primero sin buscar si ya existía un helper
compartido de redondeo (que para ese momento ya existía, `money.ts` es del
23/08, anterior a `service_items`/Bloque C que agregó comentarios nuevos a
`order-pricing.service.ts` el 15/09).
**Duplicación o contradicción relacionada:** es el mismo patrón, en el mismo
repo, que ya se documentó y corrigió una vez para `round2` — no es un hueco
nuevo de diseño, es una reincidencia del hueco ya conocido, en dos archivos
que el fix original no tocó porque no existían o no se revisaron en ese
momento.
**Recomendación:** reemplazar las dos expresiones inline por `round2(basePrice * (1 - rate.discountPercentage! / 100))`,
importando `round2` de `domain/money.ts` en los dos servicios. Cambio
mecánico, bajo riesgo, alcance de 2 archivos + sus tests unitarios (si
existen aserciones sobre el valor exacto redondeado, no deberían cambiar de
resultado, solo de implementación). Orden sugerido: mismo criterio que la
Fase 1 del roadmap de modularidad original (cambio de bajo riesgo, sin tocar
contrato de API ni schema) — podría ir primero de cualquier bloque que se
abra a partir de esta Fase 3.
**¿Requiere modificar código?** Sí (no ejecutado en esta ronda — solo
análisis).
**Prueba necesaria:** correr los tests unitarios existentes de
`reservation-pricing.service.test.ts` y `order-pricing.service.test.ts` (si
existen) antes y después del cambio, más un test nuevo que fije un caso con
decimales periódicos (p. ej. `basePrice=99.99`, `discountPercentage=33.33`)
para confirmar que el resultado no cambia al pasar por `round2`.

---

### F3-02 — `POST /api/login` está protegido por dos rate-limiters de fuerza bruta independientes, con umbrales que hoy coinciden pero pueden divergir sin aviso

**Ubicación:**
- `src/api/middleware/rate-limit.middleware.ts:70-78` (`authLimiter`,
  montado en `src/app.ts:272`: `app.use('/api/login', ...helmetApi, authLimiter, createAuthRouter(authService))`)
- `src/api/routes/auth.routes.ts:40-70` (`loginRateLimiter`, aplicado
  DENTRO del mismo router: `router.post('/', loginRateLimiter, ...)` en
  `auth.routes.ts:211`, y también en `/select-business` y `/google`,
  líneas 270 y 314)

**Evidencia:**

```ts
// src/api/middleware/rate-limit.middleware.ts:70-78 — express-rate-limit
export const authLimiter = rateLimit({
  windowMs:               15 * 60 * 1_000,
  limit:                  10,
  skipSuccessfulRequests: true,
  message:                'Demasiados intentos de autenticación. Esperá 15 minutos.',
  handler:                tooManyRequestsHandler,   // { error: 'TOO_MANY_REQUESTS', message }
});
```

```ts
// src/api/routes/auth.routes.ts:39-51 — implementación propia, en memoria
const loginAttempts = new Map<string, { count: number; resetAt: number }>();
/** Máximo de intentos fallidos por IP en la ventana */
const MAX_ATTEMPTS = 10;
/** Ventana de tiempo en milisegundos (15 minutos) */
const WINDOW_MS = 15 * 60 * 1_000;
function loginRateLimiter(req: Request, res: Response, next: NextFunction): void { /* ... */ }
```

`app.ts:271-272` monta `authLimiter` sobre el prefijo `/api/login` completo
(según su propio comentario: "10-11. /register + /api/login — helmetApi +
authLimiter (anti brute-force)"). El router que cuelga de ahí
(`createAuthRouter`) vuelve a aplicar, por dentro, `loginRateLimiter` a cada
uno de sus 3 endpoints (`/`, `/select-business`, `/google`). Cada request a
`POST /api/login` pasa por **dos** contadores de intentos independientes,
ambos con el mismo umbral hoy (10 intentos / 15 minutos por IP), pero
implementados con mecanismos distintos: uno es la librería
`express-rate-limit` (con soporte para un store distribuido si se
configura); el otro es un `Map` en memoria de proceso, cuyo propio
comentario declara la limitación: *"Suficiente para una instancia única
(Render free/starter). Para multi-instancia reemplazar por un store
Redis."*

**Comportamiento actual:** dos contadores independientes protegiendo el
mismo endpoint contra el mismo ataque (fuerza bruta de login), sin que
ninguno de los dos sepa del otro.

**Comportamiento esperado:** un solo mecanismo de rate-limit por endpoint
sensible, para que ajustar el umbral en un lugar sea suficiente y para que
el comportamiento en un deploy multi-instancia sea predecible (uno de los
dos mecanismos hoy explícitamente no lo soporta).

**Ejemplo concreto de cómo divergirían:** si en el futuro se decide bajar el
umbral de intentos de login a 5 (una decisión de seguridad razonable) y
alguien edita `MAX_ATTEMPTS` en `auth.routes.ts` sin saber que
`authLimiter` en `rate-limit.middleware.ts` sigue en 10 — el límite
efectivo para un atacante sigue siendo 10 (el `authLimiter` de
`express-rate-limit` corre primero en la cadena de middleware, y solo si
pasa sigue a `loginRateLimiter`; ninguno bloquea al otro, cada uno cuenta
por su cuenta) — el cambio de seguridad queda sin efecto real, sin que
ningún test lo detecte (no hay ningún test cruzado que compare los dos
umbrales entre sí). El caso inverso (subir el límite en un lugar y no en el
otro) produce el resultado opuesto: el atacante queda bloqueado antes de lo
que el operador cree haber configurado.

**Tipo de problema:** duplicación accidental (con riesgo de seguridad).
**Severidad:** Media — hoy los umbrales coinciden y el resultado neto es
"al menos tan estricto como el más bajo de los dos", que no es peligroso
por sí mismo, pero el diseño invita a un error de configuración silencioso
en el futuro, sobre una superficie de seguridad (brute-force de login).
**Nivel de certeza:** Alta — los dos archivos leídos completos, el
`app.use('/api/login', ...)` y el `router.post('/', loginRateLimiter, ...)`
confirmados en el mismo camino de request real.
**Impacto:** bajo hoy (redundancia, no ausencia de protección); alto como
riesgo latente de configuración (quien edite uno de los dos asumirá
razonablemente que está cambiando "el" rate-limit de login).
**Causa probable:** `loginRateLimiter` (con su propio `Map` y comentario
sobre Redis) tiene todo el aspecto de haber sido la primera implementación,
anterior a que `rate-limit.middleware.ts` se armara como "estrategia de 4
capas" documentada (ese archivo tiene un docblock extenso, fechado como
diseño consciente, que declara "2. authLimiter — /api/login + /register").
Cuando se agregó la capa de `authLimiter` en `app.ts`, nadie retiró el
`loginRateLimiter` interno de `auth.routes.ts` — probablemente porque
tocar `auth.routes.ts` (código de login) inspira cautela, o porque no se
notó que ya cubría el mismo caso.
**Duplicación o contradicción relacionada:** ninguna previa documentada en
`docs/` — grep sobre `loginRateLimiter` en `docs/*.md` no devuelve
resultados. No es una reincidencia de un hallazgo ya conocido, es nuevo.
**Recomendación:** decisión del dueño (ver sección de preguntas más abajo)
sobre cuál mecanismo conservar. Si se conserva `authLimiter`
(`express-rate-limit`, más fácil de migrar a un store distribuido el día
que haya más de una instancia — hoy Render corre single-instance según
`docs/conocimiento/runbook-deploy-render.md`, a confirmar), retirar
`loginRateLimiter` y su `Map` de `auth.routes.ts`. Si se conserva el
`Map` en memoria (por algún motivo no evidente en el código, p. ej. que
cuente también intentos exitosos de forma distinta a `authLimiter` — no
verificado), retirar el `authLimiter` del mount de `/api/login` en
`app.ts` y dejarlo solo en `/register` (que no tiene el limiter interno).
**¿Requiere modificar código?** Sí (no ejecutado en esta ronda).
**Prueba necesaria:** un test de integración que dispare 11 intentos de
login fallidos seguidos desde la misma IP y verifique que el 11º devuelve
429 con **un solo** formato de respuesta esperado (hoy, si se llega a
recorrer las dos capas, el orden de middleware hace que `authLimiter`
(externo) responda primero, así que en la práctica el formato que ve el
cliente es siempre `{ error: 'TOO_MANY_REQUESTS', message }` de
`rate-limit.middleware.ts` — `loginRateLimiter` nunca llega a devolver su
propia respuesta 429 salvo que `authLimiter` se saque del medio; esto no
se verificó corriendo el server real, es lectura de código).

---

### F3-03 — El frontend exige `email` obligatorio al crear un cliente; el backend lo trata como opcional

**Ubicación:**
- `appfrontend/src/app/dashboard/clientes/page.tsx:199-203` (formulario
  "Nuevo cliente")
- `app/src/clientes-finanzas/customers.routes.ts:73-88` (`CreateCustomerSchema`)

**Evidencia:**

```tsx
// appfrontend/src/app/dashboard/clientes/page.tsx:198-203
<label className="label">Nombre completo</label>
<input ... required />
...
<label className="label">Email</label>
<input type="email" ... required />
```

```ts
// app/src/clientes-finanzas/customers.routes.ts:73-88
/**
 * Creación de cliente.
 * - displayName (o fullName como alias legacy) — obligatorio.
 * - email — atajo opcional: si se provee se convierte en un ContactMethod EMAIL primario.
 * - contactMethods — array completo opcional, prevalece sobre email si ambos presentes.
 */
const CreateCustomerSchema = z.object({
  displayName:    z.string().min(1).optional(),
  fullName:       z.string().min(1).optional(),   // alias legacy
  email:          z.string().email().optional(),
  contactMethods: z.array(ContactMethodSchema).optional(),
}).superRefine((data, ctx) => {
  if (!data.displayName && !data.fullName) {
    ctx.addIssue({ code: 'custom', message: 'displayName es obligatorio', path: ['displayName'] });
  }
});
```

El propio comentario del schema backend documenta la regla real: solo el
nombre es obligatorio, `email` es "un atajo opcional", y el mecanismo
general (`contactMethods`, con canales `EMAIL`/`PHONE`/`WHATSAPP`) ya
soporta dar de alta un cliente sin email (p. ej. solo con teléfono/WhatsApp).
El modal del frontend no ofrece esa opción: el atributo HTML `required` en
el input de email bloquea el submit del lado del cliente para cualquier
alta que no incluya email, sin relación con lo que el backend realmente
exige.

**Comportamiento actual:** el modal "Nuevo cliente" del dashboard no deja
crear un cliente sin email, aunque el backend lo permitiría.

**Comportamiento esperado:** o el frontend refleja la regla real del
backend (email opcional, quizás con un mensaje que explique por qué
conviene cargarlo), o —si el negocio de verdad quiere exigir email siempre
en esta pantalla— esa restricción debería declararse en el backend también
(como regla de negocio, no solo de UI), para que valga para cualquier otro
cliente de la API (integraciones, importaciones futuras) y no dependa de
que todos los formularios lo repitan a mano.

**Ejemplo concreto de cómo divergirían:** si el negocio pide habilitar de
carga rápida de clientes solo con WhatsApp en el mostrador (caso realista
para un hotel/restaurante que capta el contacto en el momento), el backend
ya lo permite hoy sin ningún cambio — pero el modal de "Nuevo cliente" del
dashboard seguiría rechazando el alta hasta que alguien note, leyendo este
archivo puntual, que el `required` del input es una regla de UI que nadie
volvió a mirar desde que se escribió.

**Tipo de problema:** duplicación accidental (regla de validación
reimplementada del lado del cliente, más estricta que el contrato real).
**Severidad:** Baja-Media — no es un bug hoy (nadie reportó que "no se
puede cargar un cliente sin email" sea un problema), pero es exactamente el
patrón que el encargo pide señalar: una regla de negocio (qué campos son
obligatorios para dar de alta un cliente) fijada en el código de la
pantalla, no derivada de ningún contrato compartido ni configurable.
**Nivel de certeza:** Alta (los dos archivos leídos completos).
**Impacto:** bajo en el estado actual (UX más estricta que el backend no
rompe nada), medio como fuente de una futura decisión de producto
mal implementada si nadie recuerda revisar el frontend al cambiar la regla.
**Causa probable:** el modal se escribió pensando en el caso más común
(cliente con email) sin derivar la regla del schema Zod real — mismo
mecanismo general que Fase 1 marcó como el hueco más grande (frontend
redefine validaciones/tipos a mano en vez de leerlos del backend).
**Duplicación o contradicción relacionada:** mismo mecanismo de fondo que
F3-04 (más abajo) y que el hallazgo ya confirmado
`CRASH-CUSTOMER-RATE-RENDER-01` — la falta de un contrato compartido entre
`request.schemas.ts`/`customers.routes.ts` (backend) y
`appfrontend/src/lib/clientes/` (frontend) para la entidad `Customer`.
**Recomendación:** no resolver por defecto hacia "sacar el `required`" — es
una pregunta de producto (ver sección de preguntas). Si el dueño confirma
que el email debe seguir siendo obligatorio en la práctica, la
recomendación técnica es moverlo al backend (`CreateCustomerSchema` con
`email` requerido, o un campo de configuración por tenant si distintos
negocios quieren reglas distintas — coherente con el criterio general del
proyecto de "no asumir nada como global").
**¿Requiere modificar código?** Depende de la decisión del dueño (no
ejecutado en esta ronda).
**Prueba necesaria:** ninguna automatizada existe hoy que cubra este caso
(Fase 1, hallazgo F-01: el frontend tiene 4 archivos de test en total, cero
sobre `src/app/`). Si se decide alinear, agregar un test de backend que
confirme que `POST /api/customers` sin `email` (solo `contactMethods` con
`PHONE`) sigue funcionando, más una verificación manual del formulario.

---

### F3-04 — El mecanismo que ya causó un crash de producción (tipos del frontend redefinidos a mano, divergentes del shape real del backend) sigue activo para el resto de los dominios

**Ubicación:** `appfrontend/src/lib/clientes/types.ts:9-24` (`CustomerRate`,
ya corregido) — citado como evidencia empírica, no como hallazgo nuevo en
sí, de que el riesgo genérico señalado por Fase 1 (X-11/X-12: "el frontend
redefine tipos a mano en vez de derivarlos del backend", 18 de 19 dominios
sin contrato compartido, verificado solo para `business-context`) ya se
materializó una vez y sigue latente para los dominios no revisados.

**Evidencia:**

```ts
// appfrontend/src/lib/clientes/types.ts:9-24
/**
 * CRASH-CUSTOMER-RATE-RENDER-01 (12/09/2026) — forma REAL de la respuesta
 * de `GET /api/customers/:id/rates` (...), no la que este tipo declaraba
 * antes (`price: number` no opcional — mentía: el backend nunca manda
 * `price` en la respuesta, solo `fixedPrice`, y puede ser `null`).
 */
export interface CustomerRate {
  ...
  fixedPrice: number | null
  discountPercentage: number | null
  rateCatalogId: string | null
  ...
}
```

**Comportamiento actual:** el tipo `CustomerRate` del frontend hoy SÍ
coincide con el backend (`clientes-finanzas/customer-rate.repository.ts`) —
el incidente ya se corrigió puntualmente. Lo que sigue sin resolver es el
mecanismo: cada uno de los 18 dominios de `appfrontend/src/lib/<dominio>/types.ts`
declara sus tipos a mano, sin generación ni validación automática contra el
backend, salvo `business-context` (el único contrato formalmente
espejado, según §5.4/§5.5 del plan canónico y `src/lib/business-context/types.ts`).

**Comportamiento esperado:** un mecanismo (generación desde los schemas Zod
del backend, o al menos un test de contrato que compare la forma real de
una respuesta contra el tipo declarado) que hubiera detectado
`CRASH-CUSTOMER-RATE-RENDER-01` antes de que llegara a producción, en vez
de depender de que alguien lo note al ver un crash real.

**Ejemplo concreto de cómo divergirían (ya ocurrió, y puede repetirse en
cualquiera de los otros 17 dominios):** el mismo patrón que causó
`CRASH-CUSTOMER-RATE-RENDER-01` —un campo que el backend declara opcional
o de tipo distinto, y el frontend lo declara como obligatorio/no-nullable
"porque en la práctica siempre viene"— puede estar hoy mismo presente en
cualquiera de los otros dominios sin que nadie lo haya verificado
(`clientes`, `finanzas`, `productos`, `ordenes`, `reservas`, `estadias`,
`recursos`, `servicios`, `usuarios`, `negocio`, `sistema`, `catalogo`,
`housekeeping`, `portal`, `facturacion`, `maintenance-windows`). Fase 1 ya
declaró esto explícitamente como "no revisado" (punto 6 de su sección de
límites) — este documento no lo revisó caso por caso tampoco (fuera de
alcance de tiempo de esta ronda), pero deja la evidencia de que el riesgo
no es hipotético.

**Tipo de problema:** deuda técnica (con un caso ya confirmado como
problema real, corregido puntualmente).
**Severidad:** Media-Alta como riesgo sistémico (dado el precedente real),
Baja para el caso puntual ya corregido.
**Nivel de certeza:** Alta para el caso confirmado; Baja (no verificada) la
extensión a los otros 17 dominios — no se revisaron caso por caso en esta
ronda.
**Impacto:** un crash de UI en producción, ya ocurrido una vez; el mismo
patrón puede repetirse en cualquier pantalla que consuma un campo opcional
del backend como si fuera obligatorio.
**Causa probable:** no existe, en ninguno de los dos repos, un mecanismo
que genere o valide tipos del frontend contra el backend — ni siquiera
para el contrato ya declarado "canónico" (`business-context`) hay
verificación automática de que los dos lados coincidan, más allá de la
disciplina manual de quien edita cada lado (que ya falló una vez).
**Duplicación o contradicción relacionada:** Fase 1, X-11/X-12 ("hueco más
grande de este informe": tipos redefinidos a mano en 18 de 19 dominios).
Este hallazgo no es nuevo respecto de Fase 1 — es la confirmación empírica
de que el riesgo que Fase 1 dejó como hipótesis ya se manifestó como bug
real, con nombre y fecha (`CRASH-CUSTOMER-RATE-RENDER-01`, 12/09/2026).
**Recomendación:** evaluar (decisión de producto/arquitectura, no técnica
per se) si conviene generar tipos TypeScript del frontend a partir de los
schemas Zod del backend (ya instalado, ver la propuesta de stack del dueño
registrada al final de `auditoria-integral-fase1-2026-09-15.md`, punto 6:
"OpenAPI sincronizado con Zod") — o, más acotado y de menor radio, agregar
un test de contrato por dominio de alto riesgo (los que tocan dinero:
`clientes`, `finanzas`, `facturacion`, `ordenes`, `reservas`) que compare
la forma real de una respuesta de la API contra el tipo del frontend.
**¿Requiere modificar código?** Sí, si se decide avanzar (no ejecutado en
esta ronda — y depende de una decisión de alcance mayor que excede esta
Fase).
**Prueba necesaria:** inventario dominio por dominio (Fase 4 o posterior,
fuera del alcance de tiempo de esta ronda) comparando cada
`lib/<dominio>/types.ts` contra el `*.entities.ts`/`*.schemas.ts` real del
backend correspondiente.

---

## Verificaciones negativas (patrones del encargo, revisados, sin hallazgo)

- **`role === 'OWNER'`/`'ADMIN'` a mano:** no encontrado fuera de
  `hooks/useAuthRole.ts` (la única ocurrencia real en `FacturarButton.tsx`
  es un comentario que describe el ANTES del fix, no código vivo). El
  hallazgo original de Fase de modularidad (F7) sigue resuelto.
- **`TIME_ONLY_REGEX`/`timeOnlySchema`:** todo uso de formato HH:MM en el
  backend pasa por el helper de `common.schemas.ts` — ningún regex inline
  nuevo encontrado.
- **`resolvePlanLimits()`:** los 3 consumidores nuevos desde su creación
  (`categories.routes.ts`, `users.routes.ts`, `user-invitation.routes.ts`,
  `roles.routes.ts`) lo usan correctamente, sin reimplementación.
- **Resolución de `default_iva_rate`:** correctamente centralizada — `pos-menu`
  (`product.entities.ts`, `order.entities.ts`, `order-pricing.service.ts`)
  guarda `ivaRate: item.ivaRate ?? null` y deja el fallback real
  (`?? profile.defaultIvaRate`) exclusivamente a `facturacion/invoice.service.ts`.
  No hay una segunda resolución del default en ningún otro lugar.
- **`Invoice`/`InvoiceStatus` (frontend vs. backend):** los 4 valores del
  union type (`PENDING`/`ISSUED`/`REJECTED`/`FAILED_UNCERTAIN`) y la forma
  del objeto coinciden exactamente entre
  `appfrontend/src/lib/facturacion/types.ts` y
  `app/src/facturacion/invoice.entities.ts` — este contrato sí se mantiene
  sincronizado, con comentarios fechados a cada lado explicando por qué
  ciertos campos son opcionales (`cbteTipoLabel`). Contraejemplo útil de
  F3-04: cuando alguien SÍ revisa los dos lados con cuidado, el contrato se
  sostiene.
- **`ReservationStatus`/transiciones:** el frontend no reimplementa la
  máquina de estados — usa el array `allowedTransitions` que manda el
  backend (`reservas/page.tsx`, `reservas/[id]/page.tsx`,
  `turnos/page.tsx`, `turnos/[id]/page.tsx`), salvo dos botones
  (`Editar horario`/`Pedir horario especial`) que gatean por
  `status === 'PENDING' || 'CONFIRMED'` a mano — pero esas no son
  transiciones de la máquina de estados en sí, son acciones distintas
  (edición de horario), y el backend igual las revalida. No se reporta
  como hallazgo — impacto insuficiente.
- **Frontend no bypassea la capa HTTP del backend** (re-verificado, mismo
  resultado que X-14 de Fase 1: sin driver de BD, sin `DATABASE_URL`, sin
  `from 'pg'` en `appfrontend/src`).

---

## Duplicaciones ya conocidas (Fase 2) — solo trazabilidad, no repetidas como hallazgo nuevo

Estos 4 ítems de `docs/decisiones-auditoria-fase2-2026-09-15.md` son, en
esencia, hallazgos de duplicación semántica dentro del alcance de esta Fase
3. Ya tienen decisión del dueño registrada — no se vuelven a analizar acá,
solo se listan para que quien lea este documento no los reporte de nuevo
como si fueran nuevos:

| Decisión | Qué se duplica | Estado de implementación |
|---|---|---|
| D-16 | Formato de moneda (2 decimales, `'ARS'`/`'es-AR'`) hardcodeado en ~30 archivos del frontend (17 según el conteo original de la decisión) en vez de un resolver único | Decidido (2 decimales fijos), diseño (`lib/business-context/moneda.ts`) definido, **no implementado todavía** ("no en este batch") |
| D-07 | TTL de sesión hardcodeado/copiado en 5 lugares (`auth.service.ts`, `customer.auth.service.ts`, `customer.routes.ts`, `business.routes.ts`, `platform.auth.service.ts`) | Decidido (por tenant, no variable de entorno global), **diseño pendiente**, requiere `criterios-negocio` antes de tocar código |
| D-23 | 4 códigos de error `INVALID_TRANSITION` compartidos entre dominios (`Order`/`Stay`/`HousekeepingTask`/`AccountsReceivable`) + un 5º caso divergente en Reservas (`InvalidReservationError`, 400 en vez de 409) | Decidido (desambiguar), **no implementado** — requiere verificar primero quién en `appfrontend` matchea el código compartido hoy |
| D-14 | Contrato de paginación inconsistente entre 5 listados (`page`/`limit` en reservas vs. `limit`/`offset` sin envelope en `orders`/`products`/`cash-register-shift`/`customers`) | Resuelto con grounding (contrato `limit`/`offset` + envelope), **implementación parcial este mismo batch** (solo `reservations`); el resto queda pendiente |

---

## Preguntas para el dueño (no resueltas acá — requieren decisión de negocio o de arquitectura, no solo técnica)

1. **F3-02 (doble rate-limiter de login):** ✅ RESUELTO — ver
   `docs/decisiones-auditoria-fase3-2026-09-15.md` §1 (se conserva
   `authLimiter`, se retira `loginRateLimiter`).
2. **F3-03 (email obligatorio en el alta de cliente):** ✅ RESUELTO — ver
   `docs/decisiones-auditoria-fase3-2026-09-15.md` §2 (email pasa a ser
   obligatorio, sin excepción, regla global — no configurable por tenant
   por ahora).
3. **F3-04 (contrato de tipos frontend/backend):** ¿vale la pena, dado que
   ya causó un incidente real, priorizar antes de Fase 4 un inventario
   dominio-por-dominio de `appfrontend/src/lib/<dominio>/types.ts` contra
   su backend (la brecha que Fase 1 dejó explícitamente sin verificar), o
   se prefiere esperar a la decisión de arquitectura más grande
   (generación de tipos desde Zod/OpenAPI, ítem 6 de la propuesta de stack
   del dueño)?

---

## Cobertura declarada de esta Fase

**Revisado con evidencia:** validaciones de creación de cliente (backend vs.
frontend), cálculo de precio con tarifa especial (`resolveRateAmount` en
`reservas`/`pos-menu`), resolución de IVA por default de negocio,
comparaciones de rol duplicadas, regex de hora, `resolvePlanLimits`, rate
limiters de todos los routers que los declaran, `ReservationStatus`/
transiciones frontend vs. backend, tipo `Invoice`/`InvoiceStatus` frontend
vs. backend, tipo `Customer`/`CustomerRate` frontend vs. backend (con el
antecedente real `CRASH-CUSTOMER-RATE-RENDER-01`).

**No revisado en esta ronda, declarado explícitamente (no omitido en
silencio):**
1. Los otros 16 dominios del frontend no comparados campo a campo contra su
   backend (`productos`, `ordenes`, `recursos`, `servicios`, `estadias`,
   `housekeeping`, `usuarios`, `negocio`, `sistema`, `catalogo`, `portal`,
   `maintenance-windows`, entre otros) — priorizados los 2 con evidencia de
   riesgo real o alto valor de negocio (dinero).
2. Duplicación de lógica de fecha/timezone más allá de lo ya cubierto por
   `docs/conocimiento/playbook-fechas-timezone.md` — se verificó que el
   playbook sigue citado como vigente, no se revisó cada `new Date()`/
   `DateTime.now()` de los 27 archivos que los usan.
3. Flujos de datos end-to-end de reservas/POS/estadías — expresamente fuera
   de esta Fase (cubierto en paralelo por `erp-audit-orchestrator`).
4. Comparación exhaustiva de los 262 endpoints del backend contra cada
   pantalla del frontend que los consume — se revisaron los casos con señal
   previa de riesgo (Fase 1, Fase 2), no los 262.

---

## Nota para quien siga con Fase 4

Los 3 hallazgos nuevos de esta Fase (F3-01, F3-02, F3-03) son de bajo a
medio riesgo y acotados en superficie de archivos — candidatos razonables
para un bloque chico y reversible cada uno, siguiendo el mismo criterio de
"un bloque por vez" que ya rige el resto del proyecto. F3-04 es distinto:
no es un fix puntual, es una pregunta de arquitectura (¿generar tipos desde
el backend, o test de contrato por dominio?) que necesita decisión del
dueño antes de cualquier bloque de implementación.
