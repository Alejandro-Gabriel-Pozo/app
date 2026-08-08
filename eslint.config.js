// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  // Archivos ignorados — no lintear la salida del compilador
  { ignores: ['dist/**', 'coverage/**', 'node_modules/**'] },

  // Base JS recomendado
  js.configs.recommended,

  // TypeScript recomendado (sin type-aware rules — no requiere tsconfig)
  // Las reglas type-aware (no-unsafe-*) se agregan cuando el CI tenga
  // un tsconfig dedicado para ESLint que incluya tests y todos los archivos.
  ...tseslint.configs.recommended,

  {
    rules: {
      // ----------------------------------------------------------------
      // Reglas derivadas de bugs reales encontrados en code review
      // ----------------------------------------------------------------

      // Prohibe `any` explícito — obliga a tipar correctamente.
      // Detecta: parámetros sin tipo, retornos `any` en repositorios.
      '@typescript-eslint/no-explicit-any': 'error',

      // Obliga a usar `import type` para imports de solo tipos.
      // Detecta: imports de interfaz mezclados con imports de valor.
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'separate-type-imports' },
      ],

      // Prohibe variables declaradas pero no usadas.
      // Detecta: imports muertos después de refactors.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],

      // Prohibe promesas flotantes (sin await ni .catch).
      // Detecta: errores async silenciosos en middleware.
      '@typescript-eslint/no-floating-promises': 'off', // requiere type-aware — activar en próximo PR

      // Requiere return consistente en funciones async.
      '@typescript-eslint/require-await': 'off', // requiere type-aware — activar en próximo PR
    },
  },
);
