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
 */
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
