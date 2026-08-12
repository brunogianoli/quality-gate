import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // Los de integración corren un repositorio real y necesitan red: viven en
    // `vitest.integration.config.ts` y se disparan con `npm run test:integration`.
    exclude: ['tests/integration/**'],
    environment: 'node',
  },
});
