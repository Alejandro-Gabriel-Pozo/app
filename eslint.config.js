// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/**', 'coverage/**', 'node_modules/**'] },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    rules: {
      // ----------------------------------------------------------------
      // Reglas derivadas de bugs reales encontrados en code review
      // ----------------------------------------------------------------

      // warn (no error): el codebase preexistente tiene 113 ocurrencias.
      // Corregir con `npm run lint:fix` en una pasada dedicada.
      // Cuando ese PR se mergee, subir esto a 'error'.
      '@typescript-eslint/consistent-type-imports': [
        'warn',
        { prefer: 'type-imports', fixStyle: 'separate-type-imports' },
      ],

      // Prohibe `any` explicito. Detecta retornos sin tipo en repositorios.
      '@typescript-eslint/no-explicit-any': 'error',

      // Prohibe variables declaradas pero no usadas.
      // Prefijo _ para ignorar intencionalmente: _myVar.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],

      // Prohibe require() en modulos ESM.
      '@typescript-eslint/no-require-imports': 'error',

      // Desactivadas hasta que haya tsconfig dedicado para ESLint
      // (type-aware rules requieren parserOptions.project).
      // TODO: activar en PR siguiente con eslint.tsconfig.json.
      '@typescript-eslint/no-floating-promises': 'off',
      '@typescript-eslint/require-await': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
    },
  },
);
