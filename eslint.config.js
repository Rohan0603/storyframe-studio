import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'node_modules/**',
      '.tmp/**',
      'projects/**',
      '**/.venv/**',
      '**/venv/**',
      'attempts/**',
      'receipts/**',
      'output/**',
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
);
