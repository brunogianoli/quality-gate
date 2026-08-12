import { defineConfig } from 'vitest/config';

// El golden set de prompts llama a la API de verdad: necesita DEEPSEEK_API_KEY,
// gasta tokens y tarda. Config propia para que `npm test` siga siendo rápido y
// offline, y para correrlo cuando se tocan los prompts.
//
// Sin hilos: los casos comparten el prefijo cacheado del proveedor, y en serie
// el primero lo escribe y el resto lo lee.
export default defineConfig({
  test: {
    include: ['tests/golden-prompts/**/*.test.ts'],
    environment: 'node',
    testTimeout: 3 * 60 * 1000,
    hookTimeout: 60 * 1000,
    fileParallelism: false,
    sequence: { concurrent: false },
  },
});
