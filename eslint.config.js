import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';
import prettier from 'eslint-config-prettier';

/**
 * Flat ESLint config for the whole monorepo.
 * - apps/api, packages/shared, scripts, tools : Node + TypeScript (strict type-checked rules)
 * - apps/web                                  : browser + React TypeScript
 */
export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/build/**',
      '**/coverage/**',
      'apps/api/drizzle/meta/**',
      'apps/web/public/sw.js',
      '.husky/_/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx,mts,cts}'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.node, ...globals.es2021 },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports', fixStyle: 'inline-type-imports' }],
      'no-console': ['warn', { allow: ['warn', 'error', 'info'] }],
      eqeqeq: ['error', 'smart'],
      'no-var': 'error',
      'prefer-const': 'error',
    },
  },
  {
    // Backend + shared + scripts run in Node.
    files: ['apps/api/**/*.{ts,mts}', 'packages/shared/**/*.ts', 'scripts/**/*.{ts,mjs}', 'tools/**/*.{ts,mjs}'],
    languageOptions: { globals: { ...globals.node } },
    rules: {
      // Security: never ship secrets or timing-unsafe comparisons in server code.
      'no-restricted-properties': [
        'error',
        { object: 'process', property: 'exit', message: 'در کد سرویس از process.exit استفاده نکنید؛ فقط در اسکریپت‌های CLI مجاز است.' },
      ],
      'no-restricted-syntax': [
        'error',
        {
          selector: 'Literal[value=/zite/i]',
          message: 'وابستگی به Zite باید کاملاً حذف شود.',
        },
      ],
    },
  },
  {
    // CLI scripts and the worker entry point are allowed to exit the process.
    // `scripts/import-zite-export.ts` is the one place that legitimately names
    // Zite tables/fields (it migrates the old export), so the Zite guard is off there.
    files: [
      'scripts/**/*.{ts,mjs}',
      'apps/api/src/cli/**/*.{ts,mjs}',
      'apps/api/src/worker.ts',
      'apps/api/test/**/*.{ts,mts}',
      'apps/web/e2e/**/*.ts',
      'tools/**/*.{ts,mjs}',
    ],
    rules: { 'no-restricted-properties': 'off', 'no-console': 'off', 'no-restricted-syntax': 'off' },
  },
  {
    files: ['apps/web/**/*.{ts,tsx}'],
    languageOptions: {
      globals: { ...globals.browser },
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [{ group: ['zitejs', 'zitejs/*'], message: 'وابستگی به Zite حذف شده است؛ از lib/api استفاده کنید.' }],
        },
      ],
      'no-restricted-globals': [
        'error',
        { name: 'sessionStorage', message: 'نشست با کوکی HttpOnly مدیریت می‌شود؛ sessionStorage ممنوع است.' },
      ],
    },
  },
  {
    files: ['apps/web/**/*.tsx'],
    rules: { '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }] },
  },
  {
    // Config files run in Node without type information.
    files: ['**/*.{js,mjs,cjs}'],
    languageOptions: { globals: { ...globals.node } },
    rules: { '@typescript-eslint/no-require-imports': 'off' },
  },
  prettier,
);
