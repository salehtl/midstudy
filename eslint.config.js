// ESLint for the v2 TypeScript (docs/REFACTOR.md §3, check:lint): typescript-eslint strict-type-checked and
// stylistic-type-checked, typed through the tsconfig areas (tsconfig.json references them). The rules REFACTOR.md
// names are errors: no `any`, no non-null `!`, no `as` casts except `as const`, no @ts-ignore/@ts-expect-error/@ts-nocheck.
// Legacy JavaScript (planner/*.js until it is ported, evals, fixtures, scripts) and generated or built files are not
// linted.
import { defineConfig, globalIgnores } from 'eslint/config'
import tseslint from 'typescript-eslint'

export default defineConfig(
  globalIgnores([
    'build/',
    'planner/dist/',
    'contract/gen/',
    'node_modules/',
    'evals/out/',
    'core/target/',
    'proofs/.lake/',
    '.upstream/',
    '.claude/',
    // TScert's experiments vary their forms on purpose (tscert/README.md); TScert, not lint, is their judge.
    'tscert/',
    '**/*.js',
    '**/*.mjs',
    '**/*.cjs',
  ]),
  {
    files: ['**/*.ts', '**/*.mts', '**/*.cts'],
    extends: [tseslint.configs.strictTypeChecked, tseslint.configs.stylisticTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    linterOptions: { reportUnusedDisableDirectives: 'error' },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-non-null-assertion': 'error',
      '@typescript-eslint/consistent-type-assertions': ['error', { assertionStyle: 'never' }],
      '@typescript-eslint/ban-ts-comment': ['error', { 'ts-expect-error': true, 'ts-ignore': true, 'ts-nocheck': true, 'ts-check': false }],
    },
  },
)
