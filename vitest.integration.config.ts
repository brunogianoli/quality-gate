import { defineConfig } from 'vitest/config';

// Los tests de integración instalan dependencias y compilan un repositorio de
// verdad: necesitan red y minutos, no milisegundos. Van en su propia config
// para que `npm test` siga siendo rápido y offline.
export default defineConfig({
  test: {
    include: ['tests/integration/**/*.test.ts'],
    environment: 'node',
    testTimeout: 10 * 60 * 1000,
    hookTimeout: 10 * 60 * 1000,
  },
});
