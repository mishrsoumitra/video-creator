import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import tseslint from 'typescript-eslint';

const VENDOR_SDKS = [
  'openai',
  'openai/*',
  '@anthropic-ai/*',
  '@google/genai',
  '@google/generative-ai',
  '@google-cloud/*',
  'elevenlabs',
  '@elevenlabs/*',
  'microsoft-cognitiveservices-speech-sdk',
  'ai',
  '@ai-sdk/*',
  'kokoro-js',
];

export default defineConfig(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/build/**',
      '**/coverage/**',
      '**/out/**',
      '**/*.d.ts',
    ],
  },
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    languageOptions: { globals: { ...globals.node } },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'inline-type-imports' }],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-console': ['error', { allow: ['warn', 'error'] }],
    },
  },
  {
    // Type-aware rules for application source: catch dropped promises in async server/pipeline code.
    files: ['packages/*/src/**/*.{ts,tsx}', 'apps/*/src/**/*.{ts,tsx}'],
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': [
        'error',
        { checksVoidReturn: { attributes: false } },
      ],
      '@typescript-eslint/await-thenable': 'error',
    },
  },
  {
    files: ['apps/web/**/*.{ts,tsx}', 'packages/composition/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    languageOptions: { globals: { ...globals.browser } },
    rules: { ...reactHooks.configs.flat.recommended.rules },
  },
  {
    // The composition reports caption overflow through console.log, which the renderer collects.
    files: ['packages/composition/src/**/*.{ts,tsx}'],
    rules: { 'no-console': ['error', { allow: ['warn', 'error', 'log'] }] },
  },
  {
    // Spec: "The pipeline never imports a vendor SDK directly."
    files: ['packages/pipeline/src/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: VENDOR_SDKS,
              message: 'The pipeline talks to providers only through role interfaces.',
            },
            {
              group: ['@vc/providers', '@vc/providers/*'],
              message: 'Providers are injected; do not import them.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['**/*.test.{ts,tsx}', '**/test/**', 'scripts/**', '**/scripts/**'],
    rules: { 'no-console': 'off' },
  },
);
