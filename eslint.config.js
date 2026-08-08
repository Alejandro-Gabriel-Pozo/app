// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  // Archivos ignorados — no lintear la salida del compilador
  { ignores: ['dist/**', 'coverage/**', 'node_modules/**'] },

  // Base JS recomendado
  js.configs.recommended,

  // TypeScript estricto
  ...tseslint.configs.recommended,

  {
    languageOptions: {
      parserOptions: {
        project: './tsconfig.json',
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // ----------------------------------------------------------------
      // Reglas derivadas de bugs reales encontrados en code review
      // ----------------------------------------------------------------

      // Prohíbe `any` explícito — obliga a tipar correctamente.
      // Detecta: parámetros sin tipo, retornos `any` en repositorios.
      '@typescript-eslint/no-explicit-any': 'error',

      // Obliga a usar `import type` para imports de solo tipos.
      // Detecta: imports de interfaz mezclados con imports de valor.
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'separate-type-imports' },
      ],

      // Prohíbe variables declaradas pero no usadas.
      // Detecta: imports muertos después de refactors.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],

      // Prohíbe llamar métodos en valores posiblemente undefined/null
      // sin chequeo previo.
      // Detecta: `repository.findById()` cuando findById no existe
      // en la interfaz (retorna undefined en TS strict).
      '@typescript-eslint/no-unsafe-call': 'warn',
      '@typescript-eslint/no-unsafe-member-access': 'warn',

      // Prohíbe promesas flotantes (sin await ni .catch).
      // Detecta: errores async silenciosos en middleware.
      '@typescript-eslint/no-floating-promises': 'error',

      // Requiere return consistente en funciones async.
      '@typescript-eslint/require-await': 'warn',
    },
  },
);
