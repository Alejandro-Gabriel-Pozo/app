/**
 * Config real para dependency-cruiser — antes se corría con --no-config
 * (jscpd C8, docs/analysis/) porque el --init interactivo no podía
 * completarse sin Graphviz instalado. .cjs explícito porque package.json
 * tiene "type": "module" — un .dependency-cruiser.js se interpretaría
 * como ESM y rompería el require() de abajo.
 *
 * No incluye la generación del gráfico SVG (necesita el binario `dot` de
 * Graphviz, software de sistema — no se instaló acá). Esto sí corre las
 * reglas de verdad, que es lo que detecta problemas reales.
 *
 * ## Reglas de dominio (28/08/2026, Fase 0 de
 * docs/plan-separacion-dominios-multirubro-2026-08-28.md)
 *
 * Las 3 reglas de arriba (no-circular / no-orphans / not-to-unresolvable) son
 * genéricas: detectan higiene, no arquitectura. Las que siguen codifican los
 * límites entre bounded contexts que `docs/arquitectura-monolito-modular.md`
 * §4 y el `CLAUDE.md` de este repo ya declaran por escrito — hasta ahora solo
 * sostenidos por disciplina. Una regla que no corre en CI no es una regla:
 * van con `npm run lint:arch`, junto a `tsc` y `eslint`.
 *
 * **Las 5 reglas pasan hoy sin excepciones** — se midieron contra el código
 * real antes de escribirlas, no se dedujeron de un diagrama. No son deuda a
 * pagar: son la línea que ya está y que no se puede cruzar sin darse cuenta.
 *
 * ### Por qué `*.routes.ts` está exceptuado de la regla de repositorios
 * En este repo la **capa de rutas ES el composition root**: cada
 * `create<X>Router()` construye sus repositorios SQL por request desde
 * `req.db` (multi-tenant: el pool depende del negocio del token, no puede
 * resolverse al arrancar el proceso). Por eso `reservations.routes.ts`
 * importa `SqlCustomerRateRepository` de `clientes-finanzas/` — eso es
 * cableado, no acoplamiento de dominio. Lo que la regla prohíbe es que un
 * `*.service.ts` o una entidad haga lo mismo: ahí sí sería un dominio
 * leyendo la implementación privada de otro en vez de su puerto.
 */

/** Bounded contexts con carpeta propia en src/. `platform/` y `security/` no
 *  entran: son infraestructura transversal (tenancy, auth), no dominios. */
const DOMINIOS = 'reservas|pos-menu|pms-estadias|clientes-finanzas|facturacion|usuarios-roles';

module.exports = {
  forbidden: [
    {
      name: 'no-circular',
      severity: 'error',
      comment:
        'Dependencia circular entre módulos — dificulta razonar sobre el orden de carga y suele esconder un problema de diseño (dos módulos que deberían ser uno, o una responsabilidad mal ubicada).',
      from: {},
      to: { circular: true },
    },
    {
      name: 'no-orphans',
      severity: 'warn',
      comment:
        'Archivo que nada importa — candidato a dead code. Puede haber falsos positivos legítimos (entry points, tipos usados solo por el compilador).',
      from: {
        orphan: true,
        pathNot: [
          '(^|/)\\.[^/]+\\.(js|cjs|mjs|ts|json)$', // dotfiles de config
          '\\.d\\.ts$',
          'tsconfig\\.json$',
          '(^|/)tests?/', // helpers de test, entry points de test
          '\\.test\\.ts$',
        ],
      },
      to: {},
    },
    {
      name: 'not-to-unresolvable',
      severity: 'error',
      comment: 'Import que no resuelve a ningún módulo real — típicamente una ruta rota o un typo.',
      from: {},
      to: { couldNotResolve: true },
    },

    // -------------------------------------------------------------------------
    // Reglas de dominio — ver el docblock de arriba
    // -------------------------------------------------------------------------
    {
      name: 'no-repo-concreto-de-otro-dominio',
      severity: 'error',
      comment:
        'Un dominio no puede importar la implementación de repositorio (sql.* / in-memory.*) de OTRO dominio: eso es leer la tabla privada del vecino. Se consume su PUERTO (la interfaz, `<entidad>.repository.ts`) o su service. Excepción: `*.routes.ts`, que es el composition root de este repo (construye repos por request desde req.db, ver docblock).',
      from: {
        path: `^src/(${DOMINIOS})/`,
        pathNot: '\\.routes\\.ts$',
      },
      to: {
        path: `^src/(${DOMINIOS})/(sql|in-memory)\\.`,
        pathNot: '^src/$1/',
      },
    },
    {
      name: 'reservas-y-pos-no-se-mezclan',
      severity: 'error',
      comment:
        'Reservas y POS no se conocen entre sí — hoy no hay un solo import en ninguna dirección (verificado 28/08/2026) y es la separación más valiosa del repo: son los dos dominios que un rubro puede tener por separado (una barbería sin POS, un restaurante sin reservas). Lo que los une son eventos (order.*/reservation.*) y la capa de rutas/facturación, no un import directo.',
      from: { path: '^src/(reservas|pos-menu)/' },
      to: { path: '^src/(reservas|pos-menu)/', pathNot: '^src/$1/' },
    },
    {
      name: 'entidades-sin-express-ni-pg',
      severity: 'error',
      comment:
        'Una entidad o un tipo de dominio (*.entities.ts / *.types.ts) no conoce el transporte (express) ni el driver (pg). Si necesita uno de los dos, no es dominio: es una ruta o un repositorio mal ubicado.',
      // `to.path` de un paquete npm es la ruta RESUELTA
      // (`node_modules/express/index.js`), no el especificador del import —
      // un `path: '^express$'` acá no matchea nunca y la regla queda muerta.
      // Verificado con una violación de prueba antes de dejarla (28/08/2026).
      from: { path: '^src/[^/]+/[^/]*\\.(entities|types)\\.ts$' },
      to: { dependencyTypes: ['npm'], path: '^node_modules/(express|pg)/' },
    },
    {
      name: 'reportes-es-hoja-de-solo-lectura',
      severity: 'error',
      comment:
        'Reportes lee de todos los dominios a propósito (docs/arquitectura-monolito-modular.md §4: es un read model, no un dominio de escritura). Lo que no puede pasar es la flecha inversa: ningún dominio depende de Reportes. Si un dominio necesita un número calculado, lo calcula él o lo recibe por evento.',
      from: { path: `^src/(${DOMINIOS}|platform)/` },
      to: { path: '^src/services/report\\.service\\.ts$' },
    },
    {
      name: 'platform-no-depende-de-dominios-de-negocio',
      severity: 'error',
      comment:
        'src/platform/ es multi-tenant, provisioning y superadmin: infraestructura que TODOS los dominios usan. Si empieza a importar reservas/POS/facturación, deja de poder resolver el tenant sin arrastrar medio negocio, y el Business Context de la Fase 3 (que vive acá) heredaría ese acoplamiento. Hoy pasa limpio: cero imports.',
      from: { path: '^src/platform/' },
      to: { path: `^src/(${DOMINIOS})/` },
    },
    {
      name: 'business-context-no-toca-lo-transaccional',
      severity: 'error',
      comment:
        'Preventiva — la carpeta todavía no existe (Fase 3 del plan). Business Context resuelve configuración por tenant (rubro, capacidades, terminología); no decide disponibilidad, precios ni facturación. Si algún día importa un dominio transaccional, la cascada de configuración pasó a ser lógica de negocio y hay que rediscutirlo, no dejarlo entrar.',
      from: { path: '^src/business-context/' },
      to: { path: `^src/(${DOMINIOS})/` },
    },
  ],
  options: {
    tsPreCompilationDeps: true,
    tsConfig: { fileName: 'tsconfig.json' },
    doNotFollow: {
      path: 'node_modules',
    },
    exclude: {
      path: '\\.test\\.ts$',
    },
  },
};
