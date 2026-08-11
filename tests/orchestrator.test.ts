import { describe, it, expect, vi } from 'vitest';
import { runAuditors } from '../src/orchestrator.js';
import type { AnthropicLike } from '../src/auditor.js';
import type { Policy } from '../src/types.js';

// Nota de implementación: runAuditor() (src/auditor.ts, tarea 7) construye el mensaje de
// usuario como `Tu campo "auditor" debe ser exactamente "${name}"`. La palabra literal
// "auditor" siempre aparece citada ANTES del nombre real, así que tomar la PRIMERA
// coincidencia entre comillas (como en el brief original) capturaría siempre "auditor" en
// vez del auditor real. Tomamos la ÚLTIMA coincidencia, que es la que corresponde a
// `${name}` en el mensaje real. Ver task-8-report.md para el detalle de esta desviación.

const policy: Policy = {
  model: 'claude-sonnet-5',
  required: ['build', 'tests'],
  blockOn: ['CRITICAL', 'HIGH'],
  minConfidence: 0.7,
  onTestFailure: { runAuditors: [] },
  auditors: { scope: { when: 'always' }, backend: { when: 'always' }, security: { when: 'always' } },
};

const prompts = { scope: 'p-scope', backend: 'p-backend', security: 'p-security' };

function clientReturning(status: 'PASS' | 'FAIL' = 'PASS'): { client: AnthropicLike; order: string[] } {
  const order: string[] = [];
  const client = {
    messages: {
      parse: vi.fn(async (args: Record<string, unknown>) => {
        const msgs = args['messages'] as Array<{ content: string }>;
        const matches = [...msgs[0]!.content.matchAll(/"([a-z]+)"/g)];
        const name = matches.at(-1)?.[1] ?? 'unknown';
        order.push(name);
        await new Promise((r) => setTimeout(r, 5));
        return { parsed_output: { auditor: name, status, findings: [] } };
      }),
    },
  } as unknown as AnthropicLike;
  return { client, order };
}

describe('runAuditors', () => {
  it('devuelve un resultado por auditor', async () => {
    const { client } = clientReturning();
    const { results, errors } = await runAuditors({
      client,
      names: ['scope', 'backend', 'security'],
      prompts,
      sharedContext: 'ctx',
      policy,
    });
    expect(results).toHaveLength(3);
    expect(errors).toHaveLength(0);
    expect(results.map((r) => r.auditor).sort()).toEqual(['backend', 'scope', 'security']);
  });

  it('ejecuta el primero en serie antes de lanzar el resto', async () => {
    const started: string[] = [];
    let firstDone = false;
    const client = {
      messages: {
        parse: vi.fn(async (args: Record<string, unknown>) => {
          const msgs = args['messages'] as Array<{ content: string }>;
          const matches = [...msgs[0]!.content.matchAll(/"([a-z]+)"/g)];
          const name = matches.at(-1)?.[1] ?? 'unknown';
          started.push(name);
          if (name !== 'scope') {
            expect(firstDone).toBe(true);
          }
          await new Promise((r) => setTimeout(r, 10));
          if (name === 'scope') firstDone = true;
          return { parsed_output: { auditor: name, status: 'PASS', findings: [] } };
        }),
      },
    } as unknown as AnthropicLike;

    await runAuditors({ client, names: ['scope', 'backend', 'security'], prompts, sharedContext: 'c', policy });
    expect(started[0]).toBe('scope');
  });

  it('acumula el error de un auditor sin perder los demás resultados', async () => {
    const client = {
      messages: {
        parse: vi.fn(async (args: Record<string, unknown>) => {
          const msgs = args['messages'] as Array<{ content: string }>;
          const matches = [...msgs[0]!.content.matchAll(/"([a-z]+)"/g)];
          const name = matches.at(-1)?.[1] ?? 'unknown';
          if (name === 'backend') throw new Error('503 overloaded');
          return { parsed_output: { auditor: name, status: 'PASS', findings: [] } };
        }),
      },
    } as unknown as AnthropicLike;

    const { results, errors } = await runAuditors({
      client,
      names: ['scope', 'backend', 'security'],
      prompts,
      sharedContext: 'c',
      policy,
    });

    expect(results).toHaveLength(2);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('backend');
    expect(errors[0]).toContain('503');
  });

  it('devuelve vacío sin auditores', async () => {
    const { client } = clientReturning();
    const { results } = await runAuditors({ client, names: [], prompts, sharedContext: 'c', policy });
    expect(results).toHaveLength(0);
  });

  it('registra un error si falta el prompt de un auditor', async () => {
    const { client } = clientReturning();
    const { results, errors } = await runAuditors({
      client,
      names: ['scope', 'fantasma'],
      prompts,
      sharedContext: 'c',
      policy,
    });
    expect(results).toHaveLength(1);
    expect(errors[0]).toContain('fantasma');
  });
});
