import { defineConfig } from 'vitest/config';

// Unit and integration tests for the shared logic and the Electron main process.
// (The Angular UI is checked by `npm run typecheck` and the Electron smoke test.)
export default defineConfig({
  test: {
    include: ['shared/**/*.spec.ts', 'electron/**/*.spec.ts'],
    environment: 'node',
    testTimeout: 120_000,
  },
});
