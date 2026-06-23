export const openApiSpec = {
  openapi: '3.0.3',
  info: {
    title: 'Reservations API — Multi-resource booking',
    version: '1.0.0',
    description:
      'API de reservas multi-recurso: cabañas, mesas, spa y asientos de tour.',
  },
  servers: [{ url: 'http://localhost:3000', description: 'Demo local' }],
  tags: [
    { name: 'Resources', description: 'Recursos reservables' },
    { name: 'Reservations', description: 'Gestión de reservas' },
    { name: 'Reports', description: 'Reportes de ocupación' },
  ],
  paths: {
    '/health': {
      get: {
        summary: 'Health check',
        responses: { '200': { description: 'Servicio operativo' } },
      },
    },
    '/api/resources': {
      get: {
        tags: ['Resources'],
        summary: 'Listar todos los recursos',
        responses: { '200': { description: 'Lista de recursos' } },
      },
    },
    '/api/resources/type/{type}': {
      get: {
        tags: ['Resources'],
        summary: 'Listar recursos por tipo',
        parameters: [
          {
            name: 'type',
            in: 'path',
            required: true,
            schema: {
              type: 'string',
              enum: ['CABIN', 'RESTAURANT_TABLE', 'SPA', 'TOUR_SEAT'],
            },
          },
        ],
        responses: { '200': { description: 'Lista filtrada' } },
      },
    },
    '/api/resources/{id}': {
      get: {
        tags: ['Resources'],
        summary: 'Obtener recurso por ID',
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
        ],
        responses: {
          '200': { description: 'Recurso encontrado' },
          '404': { description: 'No encontrado' },
        },
      },
    },
    '/api/resources/{id}/availability': {
      get: {
        tags: ['Resources'],
        summary: 'Comprobar disponibilidad',
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
          {
            name: 'startTime',
            in: 'query',
            required: true,
            schema: { type: 'string', format: 'date-time' },
          },
          {
            name: 'endTime',
            in: 'query',
            required: true,
            schema: { type: 'string', format: 'date-time' },
          },
        ],
        responses: { '200': { description: 'Resultado de disponibilidad' } },
      },
    },
    '/api/reservations': {
      get: {
        tags: ['Reservations'],
        summary: 'Listar reservas',
        responses: { '200': { description: 'Lista de reservas' } },
      },
      post: {
        tags: ['Reservations'],
        summary: 'Crear reserva',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/CreateReservation' },
              example: {
                resourceType: 'RESTAURANT_TABLE',
                resourceId: 'table-terrace',
                customer: {
                  id: 'cust-new',
                  fullName: 'Ana Demo',
                  email: 'ana@demo.com',
                },
                startTime: '2026-07-25T21:00:00.000Z',
                endTime: '2026-07-25T23:00:00.000Z',
                details: {
                  allergies: [],
                  tableLocation: 'TERRACE',
                },
              },
            },
          },
        },
        responses: {
          '201': { description: 'Reserva creada' },
          '409': { description: 'Sin disponibilidad' },
        },
      },
    },
    '/api/reservations/{id}': {
      get: {
        tags: ['Reservations'],
        summary: 'Obtener reserva',
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
        ],
        responses: {
          '200': { description: 'Reserva encontrada' },
          '404': { description: 'No encontrada' },
        },
      },
    },
    '/api/reservations/{id}/confirm': {
      post: {
        tags: ['Reservations'],
        summary: 'Confirmar reserva',
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
        ],
        responses: { '200': { description: 'Reserva confirmada' } },
      },
    },
    '/api/reservations/{id}/cancel': {
      post: {
        tags: ['Reservations'],
        summary: 'Cancelar reserva',
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
        ],
        responses: { '200': { description: 'Reserva cancelada' } },
      },
    },
    '/api/reservations/{id}/complete': {
      post: {
        tags: ['Reservations'],
        summary: 'Completar reserva',
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
        ],
        responses: { '200': { description: 'Reserva completada' } },
      },
    },
    '/api/reports/occupancy': {
      get: {
        tags: ['Reports'],
        summary: 'Reporte diario de ocupación',
        parameters: [
          {
            name: 'startDate',
            in: 'query',
            required: true,
            schema: { type: 'string', format: 'date-time' },
          },
          {
            name: 'endDate',
            in: 'query',
            required: true,
            schema: { type: 'string', format: 'date-time' },
          },
        ],
        responses: { '200': { description: 'Filas de ocupación' } },
      },
    },
    '/api/reports/summary': {
      get: {
        tags: ['Reports'],
        summary: 'Resumen ejecutivo de ocupación',
        parameters: [
          {
            name: 'startDate',
            in: 'query',
            required: true,
            schema: { type: 'string', format: 'date-time' },
          },
          {
            name: 'endDate',
            in: 'query',
            required: true,
            schema: { type: 'string', format: 'date-time' },
          },
          {
            name: 'limit',
            in: 'query',
            schema: { type: 'integer', default: 5 },
          },
        ],
        responses: { '200': { description: 'Resumen' } },
      },
    },
    '/api/reports/underutilized': {
      get: {
        tags: ['Reports'],
        summary: 'Recursos subutilizados',
        parameters: [
          {
            name: 'startDate',
            in: 'query',
            required: true,
            schema: { type: 'string', format: 'date-time' },
          },
          {
            name: 'endDate',
            in: 'query',
            required: true,
            schema: { type: 'string', format: 'date-time' },
          },
          {
            name: 'threshold',
            in: 'query',
            schema: { type: 'number', default: 30 },
          },
        ],
        responses: { '200': { description: 'Recursos bajo umbral' } },
      },
    },
  },
  components: {
    schemas: {
      CreateReservation: {
        type: 'object',
        required: [
          'resourceType',
          'resourceId',
          'customer',
          'startTime',
          'endTime',
          'details',
        ],
        properties: {
          resourceType: {
            type: 'string',
            enum: ['CABIN', 'RESTAURANT_TABLE', 'SPA', 'TOUR_SEAT'],
          },
          resourceId: { type: 'string' },
          customer: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              fullName: { type: 'string' },
              email: { type: 'string', format: 'email' },
            },
          },
          startTime: { type: 'string', format: 'date-time' },
          endTime: { type: 'string', format: 'date-time' },
          details: { type: 'object' },
        },
      },
    },
  },
} as const;
