import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const projectRoot = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
    root: projectRoot,
    test: {
        include: ['tests/**/*_spec.js'],
        exclude: ['tests/integration/acceptance_ledger_spec.js'],
        environment: 'node',
        coverage: {
            provider: 'v8',
            reporter: ['text', 'json-summary'],
            include: ['extension/**/*.js'],
            thresholds: {
                lines: 93,
                branches: 80,
                functions: 94,
                statements: 93,
                'extension/background.js': {
                    lines: 66,
                    branches: 65,
                },
                'extension/lib/run-state.js': {
                    lines: 94,
                    branches: 71,
                },
                'extension/lib/secure-close.js': {
                    lines: 97,
                    branches: 81,
                },
            },
        },
    },
});
