import { describe, it, expect, vi } from 'vitest';
import { renderSharedContext, runAuditor, TOOL_NAME, type LlmClient } from '../src/auditor.js';
import type { AuditContext, Policy } from '../src/types.js';

const ctx: AuditContext = {
  owner: 'o',
  repo: 'r',
  prNumber: 7,
  commitSha: 'abc1234',
  changedFiles: [
    { path: 'src/a.ts', status: 'modified', additions: 3, deletions: 1, patch: '@@ -1 +1 @@\n-old\n+new' },
  ],
  criteria: 'Debe validar el DNI',
  criteriaSource: 'issue',
  runner: {
    install: null,
    build: { ok: true, exitCode: 0, output: 'built' },
    test: { ok: false, exitCode: 1, output: 'shouldRejectNullDni FAILED' },
  },
};

const policy: Policy = {
  model: 'deepseek-chat',
  required: ['build', 'tests'],
  blockOn: ['CRITICAL', 'HIGH'],
  minConfidence: 0.7,
  timeoutMs: 5 * 60 * 1000,
  maxRetries: 1,
  onTestFailure: { runAuditors: [] },
  auditors: { scope: { when: 'always' } },
};

// El modelo reporta usando la herramienta: el resultado viaja en `input`, no
// como texto. Es lo que garantiza la estructura sin depender de que obedezca
// una instrucción de formato.
function conHerramienta(input: unknown) {
  return { content: [{ type: 'tool_use', id: 'tu_1', name: TOOL_NAME, input }] };
}

const resultadoOk = { auditor: 'scope', status: 'PASS', findings: [] };

describe('renderSharedContext', () => {
  it('incluye criterios, archivos y salida de tests', () => {
    const text = renderSharedContext(ctx);
    expect(text).toContain('Debe validar el DNI');
    expect(text).toContain('src/a.ts');
    expect(text).toContain('shouldRejectNullDni FAILED');
  });

  it('dice explícitamente cuando no hay criterios', () => {
    const text = renderSharedContext({ ...ctx, criteria: null, criteriaSource: null });
    expect(text).toContain('sin criterios declarados');
  });
});

describe('runAuditor', () => {
  it('fuerza el reporte por herramienta y marca el bloque compartido como cacheable', async () => {
    const create = vi.fn().mockResolvedValue(conHerramienta(resultadoOk));
    const client = { messages: { create } } as unknown as LlmClient;

    const result = await runAuditor({
      client,
      name: 'scope',
      prompt: 'You are the scope auditor.',
      sharedContext: renderSharedContext(ctx),
      policy,
    });

    expect(result.auditor).toBe('scope');
    expect(result.status).toBe('PASS');

    const args = create.mock.calls[0]?.[0];
    expect(args.model).toBe('deepseek-chat');
    // Sin tool_choice apuntado a la herramienta, el modelo puede contestar en
    // prosa — que es exactamente lo que hace cuando se le pide un esquema.
    expect(args.tool_choice).toEqual({ type: 'tool', name: TOOL_NAME });
    expect(args.tools).toHaveLength(1);
    expect(args.tools[0].name).toBe(TOOL_NAME);
    expect(args.system[0].cache_control).toEqual({ type: 'ephemeral' });
    expect(args.system[1].text).toContain('scope auditor');
  });

  it('describe el esquema del resultado en la herramienta', async () => {
    const create = vi.fn().mockResolvedValue(conHerramienta(resultadoOk));
    const client = { messages: { create } } as unknown as LlmClient;

    await runAuditor({ client, name: 'scope', prompt: 'p', sharedContext: 'c', policy });

    const schema = create.mock.calls[0]?.[0].tools[0].input_schema;
    expect(schema.type).toBe('object');
    expect(Object.keys(schema.properties)).toEqual(
      expect.arrayContaining(['auditor', 'status', 'findings']),
    );
  });

  it('usa el modelo específico del auditor cuando la política lo define', async () => {
    const create = vi.fn().mockResolvedValue(conHerramienta(resultadoOk));
    const client = { messages: { create } } as unknown as LlmClient;

    await runAuditor({
      client,
      name: 'scope',
      prompt: 'p',
      sharedContext: 'c',
      policy: { ...policy, auditors: { scope: { when: 'always', model: 'deepseek-reasoner' } } },
    });

    expect(create.mock.calls[0]?.[0].model).toBe('deepseek-reasoner');
  });

  it('lanza si el modelo contestó en prosa en vez de usar la herramienta', async () => {
    // El modo de falla real del proveedor: ignora el pedido de estructura y
    // devuelve texto. Tiene que ser un error legible, no un crash de parseo.
    const create = vi.fn().mockResolvedValue({
      content: [{ type: 'text', text: 'Para devolver el resultado necesito más contexto...' }],
    });
    const client = { messages: { create } } as unknown as LlmClient;

    await expect(
      runAuditor({ client, name: 'scope', prompt: 'p', sharedContext: 'c', policy }),
    ).rejects.toThrow(/scope/);
  });

  it('lanza si lo que reportó la herramienta no valida contra el esquema', async () => {
    const create = vi.fn().mockResolvedValue(conHerramienta({ auditor: 'scope', status: 'QUIZAS' }));
    const client = { messages: { create } } as unknown as LlmClient;

    await expect(
      runAuditor({ client, name: 'scope', prompt: 'p', sharedContext: 'c', policy }),
    ).rejects.toThrow(/scope/);
  });

  it('fuerza el nombre del auditor aunque el modelo devuelva otro', async () => {
    const create = vi.fn().mockResolvedValue(
      conHerramienta({ auditor: 'inventado', status: 'FAIL', findings: [] }),
    );
    const client = { messages: { create } } as unknown as LlmClient;

    const result = await runAuditor({
      client,
      name: 'security',
      prompt: 'p',
      sharedContext: 'c',
      policy: { ...policy, auditors: { security: { when: 'always' } } },
    });

    expect(result.auditor).toBe('security');
  });

  it('reintenta cuando el modelo contesta sin usar la herramienta', async () => {
    // Visto en el golden set: cada tanto el proveedor devuelve un 200 con la
    // estructura incompleta. El SDK reintenta errores HTTP, pero esto no lo es,
    // así que sin reintento acá se pierde el aporte de ese auditor entero.
    const create = vi
      .fn()
      .mockResolvedValueOnce({ content: [{ type: 'text', text: 'Para auditar necesito más...' }] })
      .mockResolvedValueOnce(conHerramienta(resultadoOk));
    const client = { messages: { create } } as unknown as LlmClient;

    const result = await runAuditor({ client, name: 'scope', prompt: 'p', sharedContext: 'c', policy });

    expect(result.status).toBe('PASS');
    expect(create).toHaveBeenCalledTimes(2);
  });

  it('reintenta cuando lo reportado no valida contra el esquema', async () => {
    const create = vi
      .fn()
      .mockResolvedValueOnce(conHerramienta({}))
      .mockResolvedValueOnce(conHerramienta(resultadoOk));
    const client = { messages: { create } } as unknown as LlmClient;

    const result = await runAuditor({ client, name: 'scope', prompt: 'p', sharedContext: 'c', policy });

    expect(result.status).toBe('PASS');
    expect(create).toHaveBeenCalledTimes(2);
  });

  it('se rinde después de agotar los reintentos de la política', async () => {
    const create = vi.fn().mockResolvedValue(conHerramienta({}));
    const client = { messages: { create } } as unknown as LlmClient;

    await expect(
      runAuditor({ client, name: 'scope', prompt: 'p', sharedContext: 'c', policy }),
    ).rejects.toThrow(/scope/);

    // maxRetries: 1 en la política → un intento más el reintento.
    expect(create).toHaveBeenCalledTimes(2);
  });

  it('no reintenta si la política no lo permite', async () => {
    const create = vi.fn().mockResolvedValue(conHerramienta({}));
    const client = { messages: { create } } as unknown as LlmClient;

    await expect(
      runAuditor({
        client,
        name: 'scope',
        prompt: 'p',
        sharedContext: 'c',
        policy: { ...policy, maxRetries: 0 },
      }),
    ).rejects.toThrow(/scope/);

    expect(create).toHaveBeenCalledTimes(1);
  });

  it('pasa el timeout y los reintentos como opciones de la llamada', async () => {
    const create = vi.fn().mockResolvedValue(conHerramienta(resultadoOk));
    const client = { messages: { create } } as unknown as LlmClient;

    await runAuditor({ client, name: 'scope', prompt: 'p', sharedContext: 'c', policy });

    expect(create.mock.calls[0]?.[1]).toEqual({ timeout: 5 * 60 * 1000, maxRetries: 1 });
  });

  it('un auditor puede pisar el timeout y los reintentos de la política', async () => {
    const create = vi.fn().mockResolvedValue(
      conHerramienta({ auditor: 'backend', status: 'PASS', findings: [] }),
    );
    const client = { messages: { create } } as unknown as LlmClient;

    await runAuditor({
      client,
      name: 'backend',
      prompt: 'p',
      sharedContext: 'c',
      policy: {
        ...policy,
        auditors: { backend: { when: 'always', timeoutMs: 60_000, maxRetries: 3 } },
      },
    });

    expect(create.mock.calls[0]?.[1]).toEqual({ timeout: 60_000, maxRetries: 3 });
  });
});
