import { describe, it, expect, vi } from 'vitest';
import { runGate, type GateDeps } from '../src/cli.js';
import type { AnthropicLike } from '../src/auditor.js';
import type { Policy } from '../src/types.js';

const policy: Policy = {
  model: 'claude-sonnet-5',
  required: ['build', 'tests'],
  blockOn: ['CRITICAL', 'HIGH'],
  minConfidence: 0.7,
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
      parse: vi.fn(async (args: Record<string, unknown>) => {
        const msgs = args['messages'] as Array<{ content: string }>;
        const name = /exactamente "([a-z]+)"/.exec(msgs[0]!.content)?.[1] ?? 'x';
        return { parsed_output: { auditor: name, status: 'PASS', findings: [] } };
      }),
    },
  } as unknown as AnthropicLike;

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
    policy,
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
    const anthropic = { messages: { parse: vi.fn() } } as unknown as AnthropicLike;
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
    expect(anthropic.messages.parse).not.toHaveBeenCalled();
  });

  it('con tests fallando corre sólo scope y acceptance', async () => {
    const parse = vi.fn(async (args: Record<string, unknown>) => {
      const msgs = args['messages'] as Array<{ content: string }>;
      const name = /exactamente "([a-z]+)"/.exec(msgs[0]!.content)?.[1] ?? 'x';
      return { parsed_output: { auditor: name, status: 'PASS', findings: [] } };
    });
    const anthropic = { messages: { parse } } as unknown as AnthropicLike;

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
    const called = parse.mock.calls.map((c) => {
      const msgs = (c[0] as Record<string, unknown>)['messages'] as Array<{ content: string }>;
      return /exactamente "([a-z]+)"/.exec(msgs[0]!.content)?.[1];
    });
    expect(called.sort()).toEqual(['acceptance', 'scope']);
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
});
