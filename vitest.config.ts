import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // Los de integración corren un repositorio real y el golden set de prompts
    // llama a la API: los dos necesitan red y tienen su propia config
    // (`npm run test:integration`, `npm run test:prompts`).
    exclude: ['tests/integration/**', 'tests/golden-prompts/**'],
    environment: 'node',
  },
});
