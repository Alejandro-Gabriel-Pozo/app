# Reservations API

Sistema de reservas multi-recurso para hoteles y resorts: cabañas, mesas de restaurante, spa y asientos de tour.

## Características

- Dominio tipado con validación Zod por tipo de recurso
- Máquina de estados de reserva (`PENDING` → `CONFIRMED` / `CANCELLED` → `COMPLETED`)
- Comprobación de disponibilidad con detección de solapamientos
- Reportes de ocupación por recurso y período
- API REST con Swagger UI
- Modo demo in-memory con datos precargados (sin base de datos)

## Inicio rápido

```bash
npm install
npm run dev
```

Abre:

- **Swagger UI:** http://localhost:3000/docs
- **Health check:** http://localhost:3000/health

## Scripts

| Comando | Descripción |
|---------|-------------|
| `npm run dev` | Servidor con hot-reload |
| `npm start` | Servidor en producción local |
| `npm test` | Tests unitarios (Vitest) |
| `npm run build` | Compilación TypeScript |

## API

### Recursos

```http
GET  /api/resources
GET  /api/resources/type/CABIN
GET  /api/resources/{id}
GET  /api/resources/{id}/availability?startTime=...&endTime=...
```

### Reservas

```http
GET  /api/reservations
GET  /api/reservations/{id}
POST /api/reservations
POST /api/reservations/{id}/confirm
POST /api/reservations/{id}/cancel
POST /api/reservations/{id}/complete
```

### Reportes

```http
GET /api/reports/occupancy?startDate=...&endDate=...
GET /api/reports/summary?startDate=...&endDate=...
GET /api/reports/underutilized?startDate=...&endDate=...
```

### Ejemplo: crear reserva

```bash
curl -X POST http://localhost:3000/api/reservations \
  -H "Content-Type: application/json" \
  -d '{
    "resourceType": "RESTAURANT_TABLE",
    "resourceId": "table-terrace",
    "customer": {
      "id": "cust-new",
      "fullName": "Ana Demo",
      "email": "ana@demo.com"
    },
    "startTime": "2026-07-25T21:00:00.000Z",
    "endTime": "2026-07-25T23:00:00.000Z",
    "details": {
      "allergies": [],
      "tableLocation": "TERRACE"
    }
  }'
```

## Datos demo

Al arrancar se cargan automáticamente:

| ID | Tipo | Nombre |
|----|------|--------|
| `cabin-a` | CABIN | Cabaña Bosque |
| `cabin-b` | CABIN | Cabaña Lago |
| `table-window` | RESTAURANT_TABLE | Mesa Ventana |
| `table-terrace` | RESTAURANT_TABLE | Mesa Terraza |
| `table-inside` | RESTAURANT_TABLE | Mesa Interior |
| `spa-1` | SPA | Sala Masaje Zen |
| `tour-1`, `tour-2` | TOUR_SEAT | Asiento Tour Isla |

También hay 3 reservas de ejemplo (confirmadas y pendientes).

## Arquitectura

```
src/
├── domain/          # Entidades, reglas de negocio
├── repositories/    # Persistencia (in-memory + SQL)
├── services/        # Casos de uso
├── api/             # Rutas Express, DTOs, middleware
├── seed/            # Datos demo
└── openapi/         # Especificación Swagger
```

## Deploy en Render

1. Sube el repo a GitHub (ver abajo).
2. En [Render](https://render.com), crea un **Web Service** conectado al repo.
3. Render detecta `render.yaml` automáticamente, o configura manualmente:
   - **Build command:** `npm install && npm run build`
   - **Start command:** `npm start`
   - **Health check path:** `/health`
4. Tras el deploy, la API queda en `https://<tu-servicio>.onrender.com` con Swagger en `/docs`.

## Publicar en GitHub

```bash
git add .
git commit -m "Flatten repo structure and prepare Render deploy"
git push -u origin main
```

Repositorio: https://github.com/alepozo/reservations-main

El workflow de CI (`.github/workflows/ci.yml`) ejecuta tests y typecheck en cada push.

## Próximos pasos

- [ ] Docker + PostgreSQL para persistencia real
- [ ] Autenticación JWT (middleware ya preparado en `src/security/`)
- [ ] UI web

## Licencia

MIT
