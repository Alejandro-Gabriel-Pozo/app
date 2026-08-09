# Contratos HTTP de la API

Este documento define los códigos de respuesta exactos de cada endpoint.
Es la fuente de verdad para implementar el cliente API del frontend.

> **Regla de oro:** el frontend siempre lee `body.code`, nunca el HTTP status solo.
> El status es para routers/proxies; el `code` es para la lógica de la app.

---

## Estructura de error estándar

Todos los errores devuelven al menos `code` y `message`:

```json
{
  "code":    "PLAN_LIMIT_REACHED",
  "message": "Tu plan FREE permite hasta 1 categories. Actualizá tu plan para agregar más."
}
```

Algunos errores incluyen campos adicionales:

| `code` | Campos extra | Descripción |
|---|---|---|
| `PLAN_LIMIT_REACHED` | `plan`, `limit` | Plan actual y límite exacto |
| `VALIDATION_ERROR` | `errors` | Objeto con errores por campo (shape de ZodError.flatten()) |

---

## Tabla global de códigos

| HTTP | `code` | Descripción | Acción recomendada en el frontend |
|---|---|---|---|
| 201 | — | Recurso creado | Actualizar lista, mostrar confirmación |
| 200 | — | Éxito | Renderizar datos |
| 400 | `VALIDATION_ERROR` | Body inválido (Zod) | Mostrar errores por campo |
| 401 | `UNAUTHORIZED` | JWT ausente o inválido | Redirigir a login |
| 401 | `TOKEN_EXPIRED` | JWT vencido | Redirigir a login con mensaje "sesión expirada" |
| 402 | `PLAN_LIMIT_REACHED` | Límite del plan alcanzado | Mostrar `<UpgradePrompt plan={} limit={} />` |
| 403 | `FORBIDDEN` | Rol insuficiente | Mostrar mensaje de acceso denegado |
| 404 | `NOT_FOUND` / `*_NOT_FOUND` | Recurso inexistente | Mostrar estado vacío o redirigir |
| 409 | `INVALID_RESERVATION_CONFLICT` | Conflicto de disponibilidad | Mostrar mensaje de solapamiento |
| 503 | `PLATFORM_UNAVAILABLE` | BD de plataforma no disponible | Mostrar banner de reintento, retry automático |
| 503 | `BUSINESS_NOT_READY` | BD del negocio en provisioning | Mostrar pantalla de espera |
| 500 | `INTERNAL_ERROR` | Error inesperado del servidor | Mostrar error genérico, loguear en Sentry |

---

## Endpoints por recurso

### Categorías `/api/categories`

| Método | Ruta | 2xx | Errores posibles |
|---|---|---|---|
| GET | `/` | 200 | 401, 503 |
| GET | `/:id` | 200 | 401, 404, 503 |
| POST | `/` | 201 | 400, 401, 402, 403, 503, 500 |
| PUT | `/:id` | 200 | 400, 401, 403, 404, 503, 500 |
| DELETE | `/:id` | 204 | 401, 403, 404, 503, 500 |

**Body del 402 en `POST /api/categories`:**
```json
{
  "code":    "PLAN_LIMIT_REACHED",
  "message": "Tu plan FREE permite hasta 1 categories. Actualizá tu plan para agregar más.",
  "plan":    "FREE",
  "limit":   1
}
```

### Recursos `/api/resources`

| Método | Ruta | 2xx | Errores posibles |
|---|---|---|---|
| GET | `/` | 200 | 401, 503 |
| GET | `/:id` | 200 | 401, 404, 503 |
| POST | `/` | 201 | 400, 401, 402, 403, 503, 500 |
| PUT | `/:id` | 200 | 400, 401, 403, 404, 503, 500 |
| DELETE | `/:id` | 204 | 401, 403, 404, 503, 500 |

### Reservas `/api/reservations`

| Método | Ruta | 2xx | Errores posibles |
|---|---|---|---|
| GET | `/` | 200 | 401, 503 |
| GET | `/:id` | 200 | 401, 404, 503 |
| POST | `/` | 201 | 400, 401, 403, 409, 503, 500 |
| PUT | `/:id` | 200 | 400, 401, 403, 404, 409, 503, 500 |
| DELETE | `/:id` | 204 | 401, 403, 404, 503, 500 |

### Autenticación

| Método | Ruta | 2xx | Errores posibles |
|---|---|---|---|
| POST | `/api/login` | 200 + JWT | 400, 401 |

### Usuarios `/api/users`

| Método | Ruta | 2xx | Errores posibles |
|---|---|---|---|
| GET | `/` | 200 | 401, 403 |
| POST | `/` | 201 | 400, 401, 403, 500 |
| PUT | `/:id` | 200 | 400, 401, 403, 404, 500 |
| DELETE | `/:id` | 204 | 401, 403, 404, 500 |

---

## Guía de implementación para el frontend

### 1. Cliente centralizado

```ts
// src/api/client.ts
export type ApiError = {
  code:        string;
  message:     string;
  httpStatus:  number;
  plan?:       string;   // PLAN_LIMIT_REACHED
  limit?:      number;   // PLAN_LIMIT_REACHED
  errors?:     unknown;  // VALIDATION_ERROR
};

export async function apiFetch<T>(url: string, options?: RequestInit): Promise<T> {
  const token = localStorage.getItem('token') ?? '';
  const res   = await fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
      ...options?.headers,
    },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw { ...body, httpStatus: res.status } as ApiError;
  return body as T;
}
```

### 2. Despachador de errores

```ts
// src/hooks/useApiError.ts
type ErrorHandlers = {
  onPlanLimit?:  (err: ApiError) => void;   // 402
  onRetry?:      (err: ApiError) => void;   // 503
  onValidation?: (err: ApiError) => void;   // 400
  onUnauth?:     ()              => void;   // 401
  onNotFound?:   (err: ApiError) => void;   // 404
  onGeneric?:    (err: ApiError) => void;   // 500 / default
};

export function handleApiError(err: ApiError, handlers: ErrorHandlers): void {
  switch (err.code) {
    case 'PLAN_LIMIT_REACHED':   return handlers.onPlanLimit?.(err);
    case 'PLATFORM_UNAVAILABLE':
    case 'BUSINESS_NOT_READY':   return handlers.onRetry?.(err);
    case 'VALIDATION_ERROR':     return handlers.onValidation?.(err);
    case 'TOKEN_EXPIRED':
    case 'UNAUTHORIZED':         return handlers.onUnauth?.();
    case 'NOT_FOUND':
    case 'CATEGORY_NOT_FOUND':   return handlers.onNotFound?.(err);
    default:                     return handlers.onGeneric?.(err);
  }
}
```

### 3. Uso en un componente

```ts
try {
  await apiFetch('/api/categories', { method: 'POST', body: JSON.stringify(data) });
  refreshList();
} catch (err) {
  handleApiError(err as ApiError, {
    onPlanLimit:  (e) => showUpgradePrompt({ plan: e.plan!, limit: e.limit!, resource: 'categorías' }),
    onRetry:      (e) => showRetryToast(e.message),
    onValidation: (e) => setFormErrors(e.errors),
    onUnauth:         () => router.push('/login?reason=expired'),
    onGeneric:    (e) => showErrorBanner(e.message),
  });
}
```

### 4. Componente `<UpgradePrompt />`

```tsx
// Los valores plan y limit vienen del backend — nunca hardcodear en el frontend
function UpgradePrompt({ plan, limit, resource, onDismiss }) {
  return (
    <Banner variant="warning" onDismiss={onDismiss}>
      <p>Tu plan <strong>{plan}</strong> permite hasta <strong>{limit}</strong> {resource}.</p>
      <Button href="/settings/billing">Actualizá tu plan →</Button>
    </Banner>
  );
}
```

---

## Verificación rápida en DevTools

Ante cualquier error al crear una categoría:

1. DevTools → **Network** → `POST /api/categories`
2. Pestaña **Response** → leer `code` y `message`
3. Cruzar con la tabla global de códigos de arriba
4. Si `code` es `PLAN_LIMIT_REACHED` → verificar el plan del negocio en la BD:
   ```sql
   SELECT id, name, plan, status FROM businesses WHERE id = '<businessId del JWT>';
   ```
5. Si `code` es `PLATFORM_UNAVAILABLE` → el `businessId` del JWT no existe en la BD
   de plataforma o la BD está caída.
