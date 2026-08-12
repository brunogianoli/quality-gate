import { describe, it, expect, afterEach } from 'vitest';

// Regresión: GitHub Actions define GITHUB_ACTIONS=true en TODOS los jobs,
// siempre — no sólo cuando este bundle corre como la Action. El guard viejo
// (`if (process.env['GITHUB_ACTIONS'] === 'true') { await main(); }`)
// disparaba main() al sólo IMPORTAR src/cli.ts dentro de cualquier test que
// corriera en el CI real, que muere enseguida por falta de
// GITHUB_EVENT_PATH — reventando la suite entera antes de que corriera un
// solo `it`, y con ella el paso `git diff --exit-code dist/` que protege el
// bundle commiteado.
//
// El fix compara `import.meta.url` con `pathToFileURL(process.argv[1])`, así
// que main() sólo corre cuando node ejecuta este archivo directamente, nunca
// cuando otro módulo lo importa. Este test lo prueba de la única forma que
// importa: importando el módulo con GITHUB_ACTIONS=true seteado y sin
// GITHUB_EVENT_PATH — si el guard viejo volviera, la importación en sí
// lanzaría antes de que el test pudiera hacer ninguna aserción.
describe('el guard de entrypoint no dispara main() al importar el módulo', () => {
  const hadGithubActions = 'GITHUB_ACTIONS' in process.env;
  const prevGithubActions = process.env['GITHUB_ACTIONS'];
  const hadEventPath = 'GITHUB_EVENT_PATH' in process.env;
  const prevEventPath = process.env['GITHUB_EVENT_PATH'];

  afterEach(() => {
    if (hadGithubActions) process.env['GITHUB_ACTIONS'] = prevGithubActions;
    else delete process.env['GITHUB_ACTIONS'];
    if (hadEventPath) process.env['GITHUB_EVENT_PATH'] = prevEventPath;
    else delete process.env['GITHUB_EVENT_PATH'];
  });

  it('importar src/cli.js con GITHUB_ACTIONS=true no ejecuta main() (no lanza)', async () => {
    process.env['GITHUB_ACTIONS'] = 'true';
    delete process.env['GITHUB_EVENT_PATH'];

    // Si el guard volviera a ser `GITHUB_ACTIONS === 'true'`, esta misma
    // importación dispararía `main()` a nivel de módulo y el `await main()`
    // top-level lanzaría "Falta la variable de entorno GITHUB_EVENT_PATH",
    // haciendo que la promesa del import rechace.
    const mod = await import('../src/cli.js');
    expect(mod.main).toBeTypeOf('function');
    expect(mod.runGate).toBeTypeOf('function');
    // Importa cli.ts de verdad, lo que arrastra el SDK de Anthropic y Octokit
    // por su cadena de imports. Aislado tarda ~1,6s, pero corriendo junto al
    // resto de la suite se pasó de los 5s por defecto y falló sin que nada
    // estuviera roto. El margen es para la carga de la máquina, no para el test.
  }, 30_000);
});
