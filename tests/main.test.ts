import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../src/cli.js';

// Regresión del hallazgo crítico de la Tarea 12 (fix round 1 y 2): `main()`
// construye `Anthropic`/`Octokit` leyendo los inputs de la Action, no
// variables de entorno a secas. El fix round 1 sólo probó el helper
// `input()`/`requiredInput()` en aislamiento — nunca el punto de uso real
// dentro de `main()` — así que una mutación quirúrgica que revirtiera
// `main()` a `required('ANTHROPIC_API_KEY')`/`required('GITHUB_TOKEN')`
// pasaba la suite igual. Este test ejercita `main()` de punta a punta,
// mockeando `@anthropic-ai/sdk` y `@octokit/rest` para capturar exactamente
// qué credenciales reciben sus constructores.
//
// `vi.mock` se hoistea al principio del archivo; `vi.hoisted` expone las
// variables que la factory necesita capturar.
const { anthropicCtor, octokitCtor, parseAuditor } = vi.hoisted(() => {
  return {
    anthropicCtor: vi.fn(),
    octokitCtor: vi.fn(),
    parseAuditor: vi.fn(async (args: Record<string, unknown>) => {
      const msgs = args['messages'] as Array<{ content: string }>;
      const name = /exactamente "([a-z]+)"/.exec(msgs[0]!.content)?.[1] ?? 'x';
      return { parsed_output: { auditor: name, status: 'PASS', findings: [] } };
    }),
  };
});

vi.mock('@anthropic-ai/sdk', () => ({
  default: class MockAnthropic {
    messages = { parse: parseAuditor };
    constructor(opts: Record<string, unknown>) {
      anthropicCtor(opts);
    }
  },
}));

vi.mock('@octokit/rest', () => ({
  Octokit: class MockOctokit {
    pulls = {
      get: vi.fn().mockResolvedValue({ data: { body: '' } }),
      listFiles: vi.fn().mockResolvedValue({ data: [] }),
    };
    issues = {
      get: vi.fn().mockResolvedValue({ data: { body: '' } }),
      listComments: vi.fn().mockResolvedValue({ data: [] }),
      createComment: vi.fn().mockResolvedValue({}),
      updateComment: vi.fn().mockResolvedValue({}),
    };
    checks = { create: vi.fn().mockResolvedValue({}) };
    constructor(opts: Record<string, unknown>) {
      octokitCtor(opts);
    }
  },
}));

const ENV_KEYS = [
  'INPUT_DEEPSEEK-API-KEY',
  'INPUT_API-BASE-URL',
  'INPUT_GITHUB-TOKEN',
  'GITHUB_EVENT_PATH',
  'GITHUB_REPOSITORY',
  'GITHUB_WORKSPACE',
];

describe('main() — construye Anthropic/Octokit con los inputs reales de la Action', () => {
  let workspace: string;
  let eventPath: string;

  beforeEach(async () => {
    anthropicCtor.mockClear();
    octokitCtor.mockClear();

    // Directorio vacío: detectStack() no encuentra package.json/pom.xml/etc,
    // devuelve kind 'unknown' con install/build/test en null, así que
    // runStack() no dispara ningún comando real — main() corre rápido y sin
    // tocar la red ni el proceso.
    workspace = await mkdtemp(join(tmpdir(), 'qg-main-test-'));
    eventPath = join(workspace, 'event.json');
    await writeFile(
      eventPath,
      JSON.stringify({ pull_request: { number: 7, head: { sha: 'deadbeef' } } }),
      'utf8',
    );

    process.env['INPUT_DEEPSEEK-API-KEY'] = 'sk-deepseek-from-input';
    process.env['INPUT_GITHUB-TOKEN'] = 'ghp-from-input';
    process.env['GITHUB_EVENT_PATH'] = eventPath;
    process.env['GITHUB_REPOSITORY'] = 'acme/widgets';
    process.env['GITHUB_WORKSPACE'] = workspace;
  });

  afterEach(async () => {
    for (const key of ENV_KEYS) delete process.env[key];
    await rm(workspace, { recursive: true, force: true });
  });

  it('pasa INPUT_DEEPSEEK-API-KEY como apiKey e INPUT_GITHUB-TOKEN como auth', async () => {
    await main();

    expect(anthropicCtor).toHaveBeenCalledTimes(1);
    expect(anthropicCtor.mock.calls[0]?.[0]).toMatchObject({ apiKey: 'sk-deepseek-from-input' });

    expect(octokitCtor).toHaveBeenCalledTimes(1);
    expect(octokitCtor.mock.calls[0]?.[0]).toMatchObject({ auth: 'ghp-from-input' });
  });

  it('apunta el cliente al endpoint de DeepSeek, no al de Anthropic', async () => {
    // El SDK es el de Anthropic: sin baseURL las llamadas irían a api.anthropic.com
    // y fallarían con la key de DeepSeek.
    await main();

    expect(anthropicCtor.mock.calls[0]?.[0]).toMatchObject({
      baseURL: 'https://api.deepseek.com/anthropic',
    });
  });

  it('permite apuntar a otro proveedor compatible con el input api-base-url', async () => {
    process.env['INPUT_API-BASE-URL'] = 'https://ejemplo.interno/anthropic';
    await main();

    expect(anthropicCtor.mock.calls[0]?.[0]).toMatchObject({
      baseURL: 'https://ejemplo.interno/anthropic',
    });
  });
});
