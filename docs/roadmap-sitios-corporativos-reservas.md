# Roadmap — Sitios corporativos por cliente + motor de reservas público

> Traída por el dueño el 15/08/2026, con el "Contexto ya resuelto" marcado
> explícitamente `(VERIFICAR)`. Contrastada contra el código real antes de
> guardarla. **No implementada** — es planificación, mismo criterio que
> `docs/roadmap-multi-cliente-arquitectura.md` (con la que esta hoja de
> ruta se cruza en varios puntos, ver notas por fase).

## Contexto ya resuelto — verificado

Los 4 puntos que el documento daba por hechos son correctos, confirmados
hoy mismo en esta sesión:

- ✅ Backend en Render (`app-chny.onrender.com`), frontend en Vercel
  (`reservasapp-teal.vercel.app`, dominio propio `host.zuluhub.com.ar`
  conectándose).
- ✅ Multi-tenencia por path — `portal/[businessSlug]/...`, confirmado
  en `docs/roadmap-multi-cliente-arquitectura.md` sección 2.3.
- ✅ Cookies cross-domain para el panel de gestión — rewrite-proxy de
  Vercel, confirmado en la misma sección 1 de ese doc.

Ninguno de los tres necesita revisarse de nuevo — la verificación de hoy
solo confirma que la hoja de ruta parte de una base real, no supuesta.

---

## Fase 1 — Modelo de datos

❌ **Genuinamente nuevo**, confirmado con el schema real
(`platform.schema.sql`): la tabla `businesses` hoy tiene
`id/name/slug/plan/status/owner_email/supabase_project_id/
db_url_encrypted/schema_version` — nada de `custom_domain`/
`domain_status`. Tampoco existe ninguna tabla de contenido de sitio
(fotos/descripción/políticas) a nivel de negocio — los únicos campos
`description` del schema son de `categories`/`products`/`resources`
(por-ítem, no del negocio como marca).

`slug` ya existe, ya es `UNIQUE`, ya se genera automático
(`generateSlug()`, `business.routes.ts`) — la pregunta abierta del
documento ("¿puede cambiar una vez asignado?") tiene una respuesta ya
implícita en el código actual: **no cambia hoy** (no hay ningún endpoint
que lo actualice), así que "no permitir cambiarlo" no es una decisión
nueva, es simplemente no agregar esa función.

## Fase 2 — Resolución de tenant (dual: hostname + path)

⚠️ **Parcial.** La resolución por PATH ya existe y ya es exactamente el
mecanismo a reutilizar (`portal/[businessSlug]/layout.tsx`, confirmado
en la hoja de ruta anterior). La resolución por HOSTNAME (dominio propio
→ tenant) es 100% nueva — hoy `next.config.js` no tiene ninguna lógica
de rewrite basada en el host de la request, y el backend no tiene
ninguna tabla que mapee `custom_domain → business_id` (depende de la
Fase 1).

## Fase 3 — Alta de dominio propio (API de Vercel)

❌ **Nuevo, mismo patrón que el aprovisionamiento de Neon de hoy.** No
hay ninguna integración con la API de dominios de Vercel en el código
(esperable — recién hoy se conectó el primer dominio propio,
`host.zuluhub.com.ar`, a mano desde el dashboard). Vale la pena
diseñarlo con el mismo criterio que `neon-provisioning.ts`: `fetch`
nativo contra la API de Vercel, sin SDK nuevo, un `VERCEL_API_TOKEN`
declarado en `render.yaml` como secreto. **Lección de hoy aplicable
directamente acá:** verificar el shape exacto de la API contra una
prueba real antes de darlo por bueno — la documentación de Neon dio
resultados contradictorios más de una vez hoy mismo (ver
`pendientes-2026-08-15.md` sección B1), més vale asumir que puede pasar
lo mismo con la de Vercel y probar con un dominio descartable antes de
confiar en el flujo completo.

## Fase 4 — Fallback por path

✅ **Casi gratis dado lo que ya existe.** Si el negocio no tiene
`custom_domain`, ya tiene automáticamente `portal/[businessSlug]` — es
el comportamiento de hoy sin ningún cambio. Lo único nuevo es la
resolución por hostname de la Fase 2; el fallback en sí no requiere
código adicional.

## Fase 5 — Motor de reservas público (guest, sin cuenta)

❌ **Gap real, confirmado.** Hoy **todas** las rutas de reserva del
portal de clientes requieren cuenta —
`router.use(authenticate(), authorize(Roles.CUSTOMER_ONLY))` en
`customer.routes.ts` gatea la creación de reservas (y todo lo demás)
sin excepción. Sí existe ya `GET /api/customer/:businessSlug/availability`
público (sin auth) — la consulta de disponibilidad de la Fase 5 ya está
resuelta, solo falta la creación de la reserva en sí sin cuenta.

**Nota de criterios de negocio, no solo técnica:** un guest booking
necesita decidir cómo se relaciona con `Customer` (la entidad de
dominio) — ¿se crea un `Customer` "fantasma" sin `identity` asociada
para cada guest, o queda un modelo separado? Esto se cruza directo con
la Fase 6 de abajo. Correr la skill `criterios-negocio` antes de
diseñar esto — toca directamente R-de-clientes y probablemente
aislamiento multi-tenant de un flujo público nuevo.

## Fase 6 — Cuenta de cliente final (opcional, en paralelo a guest)

⚠️ **Parcial — la cuenta ya existe, lo que falta es todo lo demás.**
`CustomerAuthContext`/`customer.auth.service.ts` (email+password,
confirmado hoy leyendo el código) es exactamente el sistema de auth
"liviano y separado del de staff" que pide esta fase — **ya existe, no
hay que construirlo de nuevo.** Lo que falta:
- Magic link — no existe, hoy es solo password.
- Ofrecer "crear cuenta" al final de un guest checkout — no puede
  existir todavía porque el guest checkout de la Fase 5 tampoco existe.
- Vista de historial de reservas para clientes logueados — ✅ **ya existe**,
  confirmado: `portal/[businessSlug]/cuenta/reservas/page.tsx` llama
  `customerReservationsApi.list()`. Esta parte de la Fase 6 está resuelta
  desde antes de hoy.

**🔗 Cruce directo con un gap ya documentado:** "vincular reservas
guest a una cuenta creada después con el mismo email" (marcado acá como
"fase posterior, no bloqueante") es **el mismo problema exacto** que
`docs/roadmap-multi-cliente-arquitectura.md` sección 5.2 ya documentó
hoy más temprano — ahí el caso es "cliente cargado a mano por el
negocio (CRM) que se autoregistra después"; acá es "cliente que reservó
como guest y quiere una cuenta después". Es el mismo mecanismo de
`claim`/`merge` de un registro de `Customer` sin `identity` a una
`identity` real, solo que con dos disparadores distintos. **No diseñar
esto dos veces por separado** — cuando se encare, es un solo mecanismo
que resuelve ambos casos.

## Fase 7 — CMS del sitio corporativo

❌ **Nuevo, sin decisión tomada.** Correcto que es independiente de las
fases 1-6 salvo por depender del mismo mecanismo de resolución de tenant
(Fase 2). La pregunta abierta del documento (CMS propio vs. headless de
terceros) es una decisión de producto, no técnica — no hay elementos en
el código actual que inclinen la balanza para un lado u otro.

---

## Secuencia recomendada, ajustada a lo ya verificado

1. **Fase 1 + 2** siguen siendo el prerrequisito real — pero la Fase 2
   es más chica de lo que parece (la mitad, resolución por path, ya
   está hecha).
2. **Fase 4 (fallback) queda prácticamente gratis** una vez lista la
   Fase 2 — no hace falta tratarla como una fase separada de trabajo
   real, es una consecuencia de la Fase 2 bien hecha.
3. **Fase 5 (guest) es el gap más grande y más aislado** — no depende
   de dominios propios ni de CMS, se podría encarar en paralelo a las
   fases 1-4 si hay ancho de banda, ya que la disponibilidad pública ya
   existe y solo falta la creación de la reserva.
4. **Fases 5 y 6 comparten el diseño de `claim`/`merge`** con la hoja de
   ruta anterior — vale la pena resolver ese mecanismo una sola vez,
   pensando en los dos disparadores (CRM del negocio + guest checkout)
   desde el principio, no parchearlo después.
