import eslint from '@eslint/js'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/coverage/**',
      'temp/**',
      'data/**',
      '**/dist/**',
      '**/build/**',
      '**/output/**',
      '**/captures/**',
    ],
  },
  {
    linterOptions: {
      reportUnusedDisableDirectives: 'error',
    },
  },
  {
    ...eslint.configs.recommended,
    files: ['**/*.{js,mjs,cjs,ts,tsx}'],
  },
  {
    files: ['src/**/*.{ts,tsx}', 'test/**/*.{ts,tsx}', 'types/**/*.ts'],
    extends: tseslint.configs.recommendedTypeChecked,
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-floating-promises': [
        'error',
        {
          allowForKnownSafeCalls: [
            {
              from: 'package',
              name: 'test',
              package: 'node:test',
            },
          ],
        },
      ],
      '@typescript-eslint/no-unsafe-type-assertion': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
          ignoreRestSiblings: true,
        },
      ],
      '@typescript-eslint/require-await': 'off',
      '@typescript-eslint/switch-exhaustiveness-check': 'error',
    },
  },
  {
    // These modules intentionally match control and ANSI characters.
    files: [
      'src/cli-commands/commands/command-job.ts',
      'src/skills/skill-download.ts',
      'src/skills/skill-github-download.ts',
      'src/skills/skill-hub-download.ts',
      'src/terminal-ui/terminal-screen.tsx',
      'test/cli-commands/commands/command-job.test.ts',
      'test/terminal-ui/terminal-screen.test.ts',
    ],
    rules: {
      'no-control-regex': 'off',
    },
  }
)
