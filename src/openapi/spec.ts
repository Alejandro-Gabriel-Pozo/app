/**
 * @file spec.ts
 * @description Especificación OpenAPI 3.0 de la Reservations API.
 */

export const openApiSpec = {
  openapi: '3.0.3',
  info: {
    title: 'Reservations API — Multi-resource booking',
    version: '1.0.0',
    description:
      'API de reservas multi-recurso: cabañas, mesas, spa y asientos de tour.\n\n' +
      '## Autenticación\n\n' +
      '1. Usa `POST /api/login` con las credenciales demo para obtener un JWT.\n' +
      '2. Haz clic en el botón **Authorize** 🔒 e ingresa el token.\n' +
      '3. Swagger enviará `Authorization: Bearer <token>` automáticamente.\n\n' +
      '**Credenciales demo**\n\n' +
      '| Email | Contraseña | Rol |\n' +
      '|---|---|---|\n' +
      '| admin@demo.com | Admin1234! | ADMIN |\n' +
      '| recepcion@demo.com | recep123 | RECEPTIONIST |\n' +
      '| mesero@demo.com | waiter123 | WAITER |',
  },
  servers: [
    { url: 'https://app-chny.onrender.com', description: 'Render (producción)' },
    { url: 'http://localhost:3000', description: 'Desarrollo local' },
  ],

  security: [{ BearerAuth: [] }],

  tags: [
    { name: 'Auth',         description: 'Autenticación y emisión de tokens' },
    { name: 'Admin',        description: 'Mantenimiento puntual (solo ADMIN)' },
    { name: 'Resources',    description: 'Recursos reservables (CRUD)' },
    { name: 'Reservations', description: 'Gestión de reservas' },
    { name: 'Reports',      description: 'Reportes de ocupación' },
  ],

  paths: {
    // -------------------------------------------------------------------------
    // Rutas públicas
    // -------------------------------------------------------------------------
    '/health': {
      get: {
        summary: 'Health check',
        tags: ['System'],
        security: [],
        responses: {
          '200': {
            description: 'Servicio operativo',
            content: {
              'application/json': {
                example: { status: 'ok', mode: 'multi-tenant', db: 'connected' },
              },
            },
          },
        },
      },
    },

    '/api/login': {
      post: {
        summary: 'Obtener JWT',
        description:
          'Autentica con email y contraseña. Copia el `token` de la respuesta ' +
          'y pégalo en el botón **Authorize** 🔒 para usar los demás endpoints.',
        tags: ['Auth'],
        security: [],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/LoginRequest' },
              examples: {
                admin: {
                  summary: 'Administrador (acceso total)',
                  value: { email: 'admin@demo.com', password: 'Admin1234!' },
                },
                recepcionista: {
                  summary: 'Recepcionista (crea y gestiona reservas)',
                  value: { email: 'recepcion@demo.com', password: 'recep123' },
                },
                mesero: {
                  summary: 'Mesero (solo lectura y completar)',
                  value: { email: 'mesero@demo.com', password: 'waiter123' },
                },
              },
            },
          },
        },
        responses: {
          '200': {
            description: 'Token JWT emitido correctamente',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/LoginResponse' } },
            },
          },
          '400': { $ref: '#/components/responses/ValidationError' },
          '401': {
            description: 'Credenciales incorrectas',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ErrorResponse' },
                example: { code: 'INVALID_CREDENTIALS', message: 'Credenciales inválidas' },
              },
            },
          },
        },
      },
    },

    // -------------------------------------------------------------------------
    // Admin — mantenimiento
    // -------------------------------------------------------------------------
    '/api/admin/repair-tenant-db': {
      post: {
        summary: 'Activar BD del negocio (uso único)',
        description:
          'Cifra la `DATABASE_URL` del proceso con `DB_ENCRYPTION_KEY` y la ' +
          'persiste en la BD central, activando el negocio del usuario autenticado.\n\n' +
          '⚠️ **Uso único** — ejecutar una sola vez para negocios sembrados por SQL. No requiere body.',
        tags: ['Admin'],
        security: [{ BearerAuth: [] }],
        responses: {
          '200': {
            description: 'Negocio activado correctamente',
            content: {
              'application/json': {
                example: { message: 'Negocio biz-demo-01 activado y apuntado a DATABASE_URL.' },
              },
            },
          },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '403': { $ref: '#/components/responses/Forbidden' },
          '500': {
            description: 'DATABASE_URL o DB_ENCRYPTION_KEY no definidas',
            content: {
              'application/json': {
                example: { code: 'MISSING_DATABASE_URL', message: 'DATABASE_URL no está definida en este proceso.' },
              },
            },
          },
        },
      },
    },

    // -------------------------------------------------------------------------
    // Recursos
    // -------------------------------------------------------------------------
    '/api/resources': {
      get: {
        tags: ['Resources'],
        summary: 'Listar todos los recursos',
        security: [{ BearerAuth: [] }],
        responses: {
          '200': { description: 'Lista de recursos' },
          '401': { $ref: '#/components/responses/Unauthorized' },
        },
      },
      post: {
        tags: ['Resources'],
        summary: 'Crear recurso',
        description: 'Requiere rol **ADMIN**.',
        security: [{ BearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/CreateResource' },
              examples: {
                mesa: {
                  summary: 'Mesa de restaurante',
                  value: {
                    name: 'Mesa 5',
                    categoryId: 'cat-restaurant-01',
                    basePrice: 0,
                    visualData: {
                      shape: 'rect',
                      width: 80,
                      height: 60,
                      positionX: 120,
                      positionY: 200,
                      rotationDegrees: 0,
                    },
                  },
                },
                cabaña: {
                  summary: 'Cabaña',
                  value: {
                    name: 'Cabaña del Bosque',
                    categoryId: 'cat-cabin-01',
                    basePrice: 15000,
                  },
                },
              },
            },
          },
        },
        responses: {
          '201': { description: 'Recurso creado' },
          '400': { $ref: '#/components/responses/ValidationError' },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '403': { $ref: '#/components/responses/Forbidden' },
          '409': {
            description: 'Ya existe un recurso con ese nombre',
            content: {
              'application/json': {
                example: { code: 'RESOURCE_NAME_CONFLICT', message: 'Ya existe un recurso con el nombre "Mesa 5".' },
              },
            },
          },
        },
      },
    },

    '/api/resources/type/{type}': {
      get: {
        tags: ['Resources'],
        summary: 'Listar recursos por tipo',
        security: [{ BearerAuth: [] }],
        parameters: [
          {
            name: 'type',
            in: 'path',
            required: true,
            schema: { type: 'string', enum: ['CABIN', 'RESTAURANT_TABLE', 'SPA', 'TOUR_SEAT'] },
          },
        ],
        responses: {
          '200': { description: 'Lista filtrada por tipo' },
          '401': { $ref: '#/components/responses/Unauthorized' },
        },
      },
    },

    '/api/resources/{id}': {
      get: {
        tags: ['Resources'],
        summary: 'Obtener recurso por ID',
        security: [{ BearerAuth: [] }],
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
        ],
        responses: {
          '200': { description: 'Recurso encontrado' },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '404': { $ref: '#/components/responses/NotFound' },
        },
      },
      put: {
        tags: ['Resources'],
        summary: 'Editar recurso',
        description: 'Reemplaza todos los campos del recurso. Requiere rol **ADMIN**.',
        security: [{ BearerAuth: [] }],
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'string' }, example: 'table-001' },
        ],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/CreateResource' },
              example: {
                name: 'Mesa 5 (renovada)',
                categoryId: 'cat-restaurant-01',
                basePrice: 0,
                visualData: {
                  shape: 'rect',
                  width: 90,
                  height: 60,
                  positionX: 130,
                  positionY: 200,
                  rotationDegrees: 0,
                },
              },
            },
          },
        },
        responses: {
          '200': { description: 'Recurso actualizado' },
          '400': { $ref: '#/components/responses/ValidationError' },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '403': { $ref: '#/components/responses/Forbidden' },
          '404': { $ref: '#/components/responses/NotFound' },
          '409': {
            description: 'Ya existe otro recurso con ese nombre',
            content: {
              'application/json': {
                example: { code: 'RESOURCE_NAME_CONFLICT', message: 'Ya existe otro recurso con el nombre "Mesa 5 (renovada)".' },
              },
            },
          },
        },
      },
      delete: {
        tags: ['Resources'],
        summary: 'Eliminar recurso',
        description: 'Requiere rol **ADMIN**. Operación irreversible.',
        security: [{ BearerAuth: [] }],
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'string' }, example: 'table-001' },
        ],
        responses: {
          '204': { description: 'Recurso eliminado (sin contenido)' },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '403': { $ref: '#/components/responses/Forbidden' },
          '404': { $ref: '#/components/responses/NotFound' },
        },
      },
    },

    '/api/resources/{id}/availability': {
      get: {
        tags: ['Resources'],
        summary: 'Comprobar disponibilidad',
        security: [{ BearerAuth: [] }],
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'startTime', in: 'query', required: true, schema: { type: 'string', format: 'date-time' }, example: '2026-07-25T21:00:00.000Z' },
          { name: 'endTime',   in: 'query', required: true, schema: { type: 'string', format: 'date-time' }, example: '2026-07-25T23:00:00.000Z' },
        ],
        responses: {
          '200': { description: 'Resultado de disponibilidad' },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '404': { $ref: '#/components/responses/NotFound' },
        },
      },
    },

    // -------------------------------------------------------------------------
    // Reservas
    // -------------------------------------------------------------------------
    '/api/reservations': {
      get: {
        tags: ['Reservations'],
        summary: 'Listar reservas',
        description: 'Accesible por todos los roles (ADMIN, RECEPTIONIST, WAITER).',
        security: [{ BearerAuth: [] }],
        responses: {
          '200': { description: 'Lista de reservas' },
          '401': { $ref: '#/components/responses/Unauthorized' },
        },
      },
      post: {
        tags: ['Reservations'],
        summary: 'Crear reserva',
        description: 'Requiere rol **ADMIN** o **RECEPTIONIST**.',
        security: [{ BearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/CreateReservation' },
              example: {
                resourceId: 'table-001',
                customer: { id: 'cust-001' },
                startTime: '2026-07-25T21:00:00.000Z',
                endTime:   '2026-07-25T23:00:00.000Z',
                details:   {},
              },
            },
          },
        },
        responses: {
          '201': { description: 'Reserva creada en estado PENDING' },
          '400': { $ref: '#/components/responses/ValidationError' },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '403': { $ref: '#/components/responses/Forbidden' },
          '409': { description: 'Recurso no disponible en el rango solicitado' },
        },
      },
    },
    '/api/reservations/{id}': {
      get: {
        tags: ['Reservations'],
        summary: 'Detalle de reserva',
        security: [{ BearerAuth: [] }],
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          '200': { description: 'Reserva encontrada' },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '404': { $ref: '#/components/responses/NotFound' },
        },
      },
    },
    '/api/reservations/{id}/confirm': {
      post: {
        tags: ['Reservations'],
        summary: 'Confirmar reserva (PENDING → CONFIRMED)',
        description: 'Requiere rol **ADMIN** o **RECEPTIONIST**.',
        security: [{ BearerAuth: [] }],
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          '200': { description: 'Reserva confirmada' },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '403': { $ref: '#/components/responses/Forbidden' },
          '404': { $ref: '#/components/responses/NotFound' },
          '409': { description: 'Transición de estado inválida' },
        },
      },
    },
    '/api/reservations/{id}/cancel': {
      post: {
        tags: ['Reservations'],
        summary: 'Cancelar reserva',
        description: 'Requiere rol **ADMIN** o **RECEPTIONIST**.',
        security: [{ BearerAuth: [] }],
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          '200': { description: 'Reserva cancelada' },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '403': { $ref: '#/components/responses/Forbidden' },
          '404': { $ref: '#/components/responses/NotFound' },
        },
      },
    },
    '/api/reservations/{id}/complete': {
      post: {
        tags: ['Reservations'],
        summary: 'Completar reserva (CONFIRMED → COMPLETED)',
        description: 'Accesible por **ADMIN**, **RECEPTIONIST** y **WAITER**.',
        security: [{ BearerAuth: [] }],
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          '200': { description: 'Reserva completada' },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '403': { $ref: '#/components/responses/Forbidden' },
          '404': { $ref: '#/components/responses/NotFound' },
        },
      },
    },

    // -------------------------------------------------------------------------
    // Reportes
    // -------------------------------------------------------------------------
    '/api/reports/occupancy': {
      get: {
        tags: ['Reports'],
        summary: 'Reporte diario de ocupación',
        security: [{ BearerAuth: [] }],
        parameters: [
          { name: 'startDate', in: 'query', required: true, schema: { type: 'string', format: 'date-time' }, example: '2026-07-01T00:00:00.000Z' },
          { name: 'endDate',   in: 'query', required: true, schema: { type: 'string', format: 'date-time' }, example: '2026-07-31T23:59:59.000Z' },
        ],
        responses: {
          '200': { description: 'Filas de ocupación' },
          '400': { $ref: '#/components/responses/ValidationError' },
          '401': { $ref: '#/components/responses/Unauthorized' },
        },
      },
    },
    '/api/reports/summary': {
      get: {
        tags: ['Reports'],
        summary: 'Resumen ejecutivo de ocupación',
        security: [{ BearerAuth: [] }],
        parameters: [
          { name: 'startDate', in: 'query', required: true, schema: { type: 'string', format: 'date-time' } },
          { name: 'endDate',   in: 'query', required: true, schema: { type: 'string', format: 'date-time' } },
          { name: 'limit',     in: 'query', schema: { type: 'integer', minimum: 1, maximum: 100, default: 5 }, description: 'Máximo de recursos en cada ranking' },
        ],
        responses: {
          '200': { description: 'Resumen ejecutivo' },
          '400': { $ref: '#/components/responses/ValidationError' },
          '401': { $ref: '#/components/responses/Unauthorized' },
        },
      },
    },
    '/api/reports/underutilized': {
      get: {
        tags: ['Reports'],
        summary: 'Recursos subutilizados',
        security: [{ BearerAuth: [] }],
        parameters: [
          { name: 'startDate', in: 'query', required: true, schema: { type: 'string', format: 'date-time' } },
          { name: 'endDate',   in: 'query', required: true, schema: { type: 'string', format: 'date-time' } },
          { name: 'threshold', in: 'query', schema: { type: 'number', minimum: 0, maximum: 100, default: 30 }, description: 'Umbral de ocupación en % (0–100)' },
        ],
        responses: {
          '200': { description: 'Recursos bajo el umbral indicado' },
          '400': { $ref: '#/components/responses/ValidationError' },
          '401': { $ref: '#/components/responses/Unauthorized' },
        },
      },
    },
  },

  components: {
    securitySchemes: {
      BearerAuth: {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
        description:
          'JWT obtenido desde `POST /api/login`. ' +
          'Pega solo el valor del campo `token`, sin el prefijo "Bearer".',
      },
    },

    responses: {
      Unauthorized: {
        description: 'No autenticado — falta el token o expiró',
        content: {
          'application/json': {
            schema: { $ref: '#/components/schemas/ErrorResponse' },
            examples: {
              missingToken: { summary: 'Sin token',      value: { code: 'UNAUTHORIZED',  message: 'Se requiere header Authorization: Bearer <token>' } },
              expiredToken: { summary: 'Token expirado', value: { code: 'TOKEN_EXPIRED', message: 'El token ha expirado' } },
            },
          },
        },
      },
      Forbidden: {
        description: 'Autenticado pero sin el rol requerido',
        content: {
          'application/json': {
            schema: { $ref: '#/components/schemas/ErrorResponse' },
            example: { code: 'FORBIDDEN', message: 'Acceso denegado. Roles permitidos: ADMIN' },
          },
        },
      },
      NotFound: {
        description: 'Recurso no encontrado',
        content: {
          'application/json': {
            schema: { $ref: '#/components/schemas/ErrorResponse' },
            example: { code: 'RESOURCE_NOT_FOUND', message: 'Recurso no encontrado: table-001' },
          },
        },
      },
      ValidationError: {
        description: 'Datos de entrada inválidos',
        content: {
          'application/json': {
            schema: { $ref: '#/components/schemas/ValidationErrorResponse' },
          },
        },
      },
    },

    schemas: {
      LoginRequest: {
        type: 'object',
        required: ['email', 'password'],
        properties: {
          email:    { type: 'string', format: 'email', example: 'admin@demo.com' },
          password: { type: 'string', minLength: 6,    example: 'Admin1234!' },
        },
      },

      LoginResponse: {
        type: 'object',
        properties: {
          token:     { type: 'string', description: 'JWT firmado con HS256. Cópialo en el botón Authorize 🔒.', example: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...' },
          tokenType: { type: 'string', enum: ['Bearer'] },
          expiresIn: { type: 'integer', description: 'Segundos hasta expiración', example: 86400 },
          user: {
            type: 'object',
            properties: {
              id:    { type: 'string', example: 'usr-admin-01' },
              email: { type: 'string', example: 'admin@demo.com' },
              role:  { type: 'string', enum: ['ADMIN', 'RECEPTIONIST', 'WAITER'] },
            },
          },
        },
      },

      ErrorResponse: {
        type: 'object',
        properties: {
          code:    { type: 'string',  example: 'RESOURCE_NOT_FOUND' },
          message: { type: 'string',  example: 'Recurso no encontrado: table-001' },
        },
      },

      ValidationErrorResponse: {
        type: 'object',
        properties: {
          code:    { type: 'string', example: 'VALIDATION_ERROR' },
          message: { type: 'string', example: 'Datos de entrada inválidos' },
          errors: {
            type: 'object',
            properties: {
              fieldErrors: { type: 'object', additionalProperties: { type: 'array', items: { type: 'string' } } },
              formErrors:  { type: 'array',  items: { type: 'string' } },
            },
          },
        },
      },

      // Usado por POST /api/resources y PUT /api/resources/{id}
      CreateResource: {
        type: 'object',
        required: ['name', 'categoryId', 'basePrice'],
        properties: {
          id:         { type: 'string', description: 'ID personalizado (opcional, se genera UUID si se omite)', example: 'table-005' },
          name:       { type: 'string', example: 'Mesa 5' },
          categoryId: { type: 'string', description: 'ID de la categoría del recurso', example: 'cat-restaurant-01' },
          basePrice:  { type: 'number', minimum: 0, example: 0 },
          visualData: {
            type: 'object',
            description: 'Posición y forma en el mapa visual (opcional)',
            required: ['shape', 'width', 'height', 'positionX', 'positionY', 'rotationDegrees'],
            properties: {
              shape:           { type: 'string', example: 'rect' },
              width:           { type: 'number', example: 80 },
              height:          { type: 'number', example: 60 },
              positionX:       { type: 'number', example: 120 },
              positionY:       { type: 'number', example: 200 },
              rotationDegrees: { type: 'number', example: 0 },
            },
          },
        },
      },

      // Usado por POST /api/reservations
      CreateReservation: {
        type: 'object',
        required: ['resourceId', 'customer', 'startTime', 'endTime'],
        properties: {
          resourceId: { type: 'string', example: 'table-001' },
          customer: {
            type: 'object',
            required: ['id'],
            properties: {
              id: { type: 'string', description: 'ID del cliente (debe existir previamente)', example: 'cust-001' },
            },
          },
          startTime: { type: 'string', format: 'date-time', example: '2026-07-25T21:00:00.000Z' },
          endTime:   { type: 'string', format: 'date-time', example: '2026-07-25T23:00:00.000Z' },
          details:   { type: 'object', description: 'Datos adicionales opcionales (ej. número de comensales)', example: {} },
        },
      },
    },
  },
} as const;
