import { describe, it, expect, vi, afterEach } from 'vitest';
import { runGate, input, requiredInput, type GateDeps } from '../src/cli.js';
import type { LlmClient } from '../src/auditor.js';
import type { Policy } from '../src/types.js';

const policy: Policy = {
  model: 'claude-sonnet-5',
  required: ['build', 'tests'],
  blockOn: ['CRITICAL', 'HIGH'],
  minConfidence: 0.7,
  timeoutMs: 5 * 60 * 1000,
  maxRetries: 1,
  onTestFailure: { runAuditors: ['scope', 'acceptance'] },
  auditors: {
    acceptance: { when: 'criteria_available' },
    scope: { when: 'always' },
    backend: { when: ['backend_changed'] },
  },
};

function deps(overrides: Partial<GateDeps> = {}): GateDeps {
  const anthropic = {
    messages: {
      create: vi.fn(async (args: Record<string, unknown>) => {
        const msgs = args['messages'] as Array<{ content: string }>;
        const name = /exactamente "([a-z]+)"/.exec(msgs[0]!.content)?.[1] ?? 'x';
        return { content: [{ type: 'tool_use', input: { auditor: name, status: 'PASS', findings: [] } }] };
      }),
    },
  } as unknown as LlmClient;

  return {
    owner: 'o',
    repo: 'r',
    prNumber: 1,
    commitSha: 'sha123',
    workspace: process.cwd(),
    anthropic,
    octokit: {
      pulls: {
        get: async () => ({ data: { body: 'Closes #9' } }),
        listFiles: async () => ({
          data: [{ filename: 'src/app.ts', status: 'modified', additions: 1, deletions: 0, patch: '@@ @@' }],
        }),
      },
      issues: {
        get: async () => ({ data: { body: 'Criterio: validar' } }),
        listComments: vi.fn().mockResolvedValue({ data: [] }),
        createComment: vi.fn().mockResolvedValue({}),
        updateComment: vi.fn().mockResolvedValue({}),
      },
      checks: { create: vi.fn().mockResolvedValue({}) },
    } as unknown as GateDeps['octokit'],
    loadPolicy: async () => policy,
    prompts: { acceptance: 'p', scope: 'p', backend: 'p' },
    detect: async () => ({ kind: 'node', install: null, build: 'true', test: 'true' }),
    run: async () => ({
      install: null,
      build: { ok: true, exitCode: 0, output: '' },
      test: { ok: true, exitCode: 0, output: '' },
    }),
    ...overrides,
  };
}

describe('runGate', () => {
  it('devuelve PASS con todo verde y sin findings', async () => {
    const d = await runGate(deps());
    expect(d.verdict).toBe('PASS');
  });

  it('corta sin llamar a la IA cuando el build falla', async () => {
    const anthropic = { messages: { create: vi.fn() } } as unknown as LlmClient;
    const d = await runGate(
      deps({
        anthropic,
        run: async () => ({
          install: null,
          build: { ok: false, exitCode: 1, output: 'compile error' },
          test: null,
        }),
      }),
    );
    expect(d.verdict).toBe('FAIL');
    expect(anthropic.messages.create).not.toHaveBeenCalled();
  });

  it('con tests fallando corre sólo scope y acceptance', async () => {
    const create = vi.fn(async (args: Record<string, unknown>) => {
      const msgs = args['messages'] as Array<{ content: string }>;
      const name = /exactamente "([a-z]+)"/.exec(msgs[0]!.content)?.[1] ?? 'x';
      return { content: [{ type: 'tool_use', input: { auditor: name, status: 'PASS', findings: [] } }] };
    });
    const anthropic = { messages: { create } } as unknown as LlmClient;

    const d = await runGate(
      deps({
        anthropic,
        run: async () => ({
          install: null,
          build: { ok: true, exitCode: 0, output: '' },
          test: { ok: false, exitCode: 1, output: '2 failed' },
        }),
      }),
    );

    expect(d.verdict).toBe('FAIL');
    const called = create.mock.calls.map((c) => {
      const msgs = (c[0] as Record<string, unknown>)['messages'] as Array<{ content: string }>;
      return /exactamente "([a-z]+)"/.exec(msgs[0]!.content)?.[1];
    });
    expect(called.sort()).toEqual(['acceptance', 'scope']);
  });

  it('no aprueba cuando ningún auditor pudo correr', async () => {
    // Encontrado corriendo el gate de verdad: con la API rechazando la key,
    // los cuatro auditores fallaron y el veredicto salió PASS en verde. Nadie
    // miró el código y el sistema habilitó el merge — exactamente lo que este
    // producto existe para impedir. Un outage tiene que degradar a ERROR
    // (neutral, no bloquea), nunca a PASS.
    const anthropic = {
      messages: {
        create: vi.fn(async () => {
          throw new Error('401 invalid x-api-key');
        }),
      },
    } as unknown as LlmClient;

    const d = await runGate(deps({ anthropic }));

    expect(d.verdict).toBe('ERROR');
    expect(d.reason).toMatch(/auditor/i);
  });

  it('sigue dando un veredicto real si al menos un auditor corrió', async () => {
    // Degradación parcial: con uno vivo hay verificación real, así que el
    // veredicto se calcula y el comentario informa a los que fallaron.
    const anthropic = {
      messages: {
        create: vi.fn(async (args: Record<string, unknown>) => {
          const msgs = args['messages'] as Array<{ content: string }>;
          const name = /exactamente "([a-z]+)"/.exec(msgs[0]!.content)?.[1] ?? 'x';
          if (name !== 'scope') throw new Error('503 overloaded');
          return { content: [{ type: 'tool_use', input: { auditor: name, status: 'PASS', findings: [] } }] };
        }),
      },
    } as unknown as LlmClient;

    const d = await runGate(deps({ anthropic }));

    expect(d.verdict).toBe('PASS');
  });

  it('devuelve ERROR sin lanzar cuando GitHub falla', async () => {
    const d = await runGate(
      deps({
        octokit: {
          pulls: {
            get: async () => {
              throw new Error('502 bad gateway');
            },
            listFiles: async () => ({ data: [] }),
          },
          issues: {
            get: async () => ({ data: { body: '' } }),
            listComments: vi.fn().mockResolvedValue({ data: [] }),
            createComment: vi.fn().mockResolvedValue({}),
            updateComment: vi.fn().mockResolvedValue({}),
          },
          checks: { create: vi.fn().mockResolvedValue({}) },
        } as unknown as GateDeps['octokit'],
      }),
    );
    expect(d.verdict).toBe('ERROR');
    expect(d.reason).toContain('502');
  });

  it('publica siempre comentario y check', async () => {
    const d = deps();
    await runGate(d);
    expect(d.octokit.issues.createComment).toHaveBeenCalledOnce();
    expect(d.octokit.checks.create).toHaveBeenCalledOnce();
  });

  // Regresión del fix del Problema 4 (loadPolicy ahora valida con zod y
  // lanza ante un .ai/policy.yaml inválido): esa excepción tiene que
  // resolverse en el mismo camino que cualquier otro fallo del gate —
  // ERROR + check neutral + comentario — no escapar de runGate. Si alguien
  // volviera a sacar `deps.loadPolicy(...)` de adentro del try/catch (p. ej.
  // reintroduciendo `policy: Policy` ya resuelta en GateDeps), este test
  // falla: la promesa de runGate rechazaría en vez de resolver con un
  // veredicto ERROR.
  it('con un .ai/policy.yaml inválido, devuelve ERROR con check neutral y comentario en vez de lanzar', async () => {
    const invalidPolicyMessage =
      'Política inválida en /repo/.ai/policy.yaml: el campo "block_on" no cumple el esquema esperado (Invalid input: expected array, received string). Revisá el YAML.';

    const createComment = vi.fn().mockResolvedValue({});
    const checksCreate = vi.fn().mockResolvedValue({});
    const octokit = {
      pulls: {
        get: async () => ({ data: { body: 'Closes #9' } }),
        listFiles: async () => ({ data: [] }),
      },
      issues: {
        get: async () => ({ data: { body: '' } }),
        listComments: vi.fn().mockResolvedValue({ data: [] }),
        createComment,
        updateComment: vi.fn().mockResolvedValue({}),
      },
      checks: { create: checksCreate },
    } as unknown as GateDeps['octokit'];

    const d = await runGate(
      deps({
        octokit,
        loadPolicy: async () => {
          throw new Error(invalidPolicyMessage);
        },
      }),
    );

    expect(d.verdict).toBe('ERROR');
    expect(d.reason).toContain('block_on');
    expect(d.reason).toContain('policy.yaml');

    expect(createComment).toHaveBeenCalledOnce();
    const commentBody = createComment.mock.calls[0]?.[0].body as string;
    expect(commentBody).toContain('block_on');

    expect(checksCreate).toHaveBeenCalledOnce();
    expect(checksCreate.mock.calls[0]?.[0].conclusion).toBe('neutral');
  });
});

// Regresión: GitHub Actions expone los inputs declarados en action.yml como
// `INPUT_<NOMBRE-EN-MAYUSCULAS>` (guiones preservados, no convertidos a guión
// bajo) — nunca como la variable "a secas". `main()` construía el Anthropic y
// el Octokit leyendo `ANTHROPIC_API_KEY` y `GITHUB_TOKEN` directamente, que el
// runner nunca inyecta así. Siguiendo el propio snippet del README, la Action
// moría en el primer `required()`.
describe('input() / requiredInput() — lectura de inputs de la Action', () => {
  const ENV_KEYS = [
    'INPUT_ANTHROPIC-API-KEY',
    'INPUT_GITHUB-TOKEN',
    'ANTHROPIC_API_KEY',
    'GITHUB_TOKEN',
  ];

  afterEach(() => {
    for (const key of ENV_KEYS) delete process.env[key];
  });

  it('lee anthropic-api-key y github-token desde INPUT_<NOMBRE>, con los guiones intactos', () => {
    process.env['INPUT_ANTHROPIC-API-KEY'] = 'sk-ant-from-input';
    process.env['INPUT_GITHUB-TOKEN'] = 'ghp-from-input';

    expect(input('anthropic-api-key')).toBe('sk-ant-from-input');
    expect(input('github-token')).toBe('ghp-from-input');
    expect(requiredInput('anthropic-api-key')).toBe('sk-ant-from-input');
    expect(requiredInput('github-token')).toBe('ghp-from-input');
  });

  it('no encuentra el input si sólo existe la variable a secas (el bug original)', () => {
    // Sin el prefijo INPUT_: exactamente lo que exponía el runner antes del
    // fix. Si `input()` volviera a leer `process.env[name]` en vez de
    // `process.env['INPUT_' + name...]`, esta aserción pasaría a ver
    // 'bare-value' en vez de `undefined` y el test fallaría.
    process.env['ANTHROPIC_API_KEY'] = 'bare-value';
    process.env['GITHUB_TOKEN'] = 'bare-value';

    expect(input('anthropic-api-key')).toBeUndefined();
    expect(input('github-token')).toBeUndefined();
    expect(() => requiredInput('anthropic-api-key')).toThrow('Falta el input anthropic-api-key');
    expect(() => requiredInput('github-token')).toThrow('Falta el input github-token');
  });
});
