import tseslint from 'typescript-eslint';
export default tseslint.config(
  { ignores: ['**/dist/**', '**/node_modules/**', 'apps/north-university-food-automation/**'] },
  ...tseslint.configs.recommended,
  { rules: { 'no-console': ['warn', { allow: ['error', 'warn', 'log'] }], '@typescript-eslint/no-explicit-any': 'error' } },
);
