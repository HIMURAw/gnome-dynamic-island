import js from '@eslint/js';
import globals from 'globals';

// GNOME Shell extensions run in GJS: ES modules plus a few GJS globals.
export default [
    {ignores: ['node_modules/', 'locale/']},
    js.configs.recommended,
    {
        languageOptions: {
            ecmaVersion: 2024,
            sourceType: 'module',
            globals: {
                ...globals.es2021,
                global: 'readonly',
                imports: 'readonly',
                log: 'readonly',
                logError: 'readonly',
                print: 'readonly',
                printerr: 'readonly',
                console: 'readonly',
                TextEncoder: 'readonly',
                TextDecoder: 'readonly',
            },
        },
        rules: {
            'no-unused-vars': ['error', {argsIgnorePattern: '^_', varsIgnorePattern: '^_'}],
            'prefer-const': 'error',
            'no-var': 'error',
            eqeqeq: ['error', 'smart'],
        },
    },
];
