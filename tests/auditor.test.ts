import { describe, it, expect, vi } from 'vitest';
import { renderSharedContext, runAuditor, type AnthropicLike } from '../src/auditor.js';
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
  model: 'claude-sonnet-5',
  required: ['build', 'tests'],
  blockOn: ['CRITICAL', 'HIGH'],
  minConfidence: 0.7,
  onTestFailure: { runAuditors: [] },
  auditors: { scope: { when: 'always', effort: 'low' } },
};

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
  it('devuelve el resultado parseado y marca el bloque compartido como cacheable', async () => {
    const parse = vi.fn().mockResolvedValue({
      parsed_output: { auditor: 'scope', status: 'PASS', findings: [] },
    });
    const client = { messages: { parse } } as unknown as AnthropicLike;

    const result = await runAuditor({
      client,
      name: 'scope',
      prompt: 'You are the scope auditor.',
      sharedContext: renderSharedContext(ctx),
      policy,
    });

    expect(result.auditor).toBe('scope');
    expect(result.status).toBe('PASS');

    const args = parse.mock.calls[0]?.[0];
    expect(args.model).toBe('claude-sonnet-5');
    expect(args.output_config.effort).toBe('low');
    expect(args.system[0].cache_control).toEqual({ type: 'ephemeral' });
    expect(args.system[1].text).toContain('scope auditor');
  });

  it('usa el modelo específico del auditor cuando la política lo define', async () => {
    const parse = vi.fn().mockResolvedValue({
      parsed_output: { auditor: 'scope', status: 'PASS', findings: [] },
    });
    const client = { messages: { parse } } as unknown as AnthropicLike;

    await runAuditor({
      client,
      name: 'scope',
      prompt: 'p',
      sharedContext: 'c',
      policy: { ...policy, auditors: { scope: { when: 'always', model: 'claude-opus-5' } } },
    });

    expect(parse.mock.calls[0]?.[0].model).toBe('claude-opus-5');
  });

  it('lanza si la respuesta no valida contra el esquema', async () => {
    const parse = vi.fn().mockResolvedValue({ parsed_output: null });
    const client = { messages: { parse } } as unknown as AnthropicLike;

    await expect(
      runAuditor({ client, name: 'scope', prompt: 'p', sharedContext: 'c', policy }),
    ).rejects.toThrow(/scope/);
  });

  it('fuerza el nombre del auditor aunque el modelo devuelva otro', async () => {
    const parse = vi.fn().mockResolvedValue({
      parsed_output: { auditor: 'inventado', status: 'FAIL', findings: [] },
    });
    const client = { messages: { parse } } as unknown as AnthropicLike;

    const result = await runAuditor({
      client,
      name: 'security',
      prompt: 'p',
      sharedContext: 'c',
      policy: { ...policy, auditors: { security: { when: 'always' } } },
    });

    expect(result.auditor).toBe('security');
  });
});
