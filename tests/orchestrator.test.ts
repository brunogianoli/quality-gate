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
    // La aserción vive ACÁ, en el cuerpo del test, después del await — no dentro del
    // mock. Si viviera dentro del mock (como en una versión anterior de este test), un
    // throw ahí adentro viaja como rechazo de promesa a través de runAuditor y lo
    // absorbe el try/catch de attempt() en orchestrator.ts, que lo convierte en una
    // entrada de `errors` en vez de tumbar el test. El test nunca inspeccionaba
    // `errors`, así que una implementación totalmente paralela
    // (`Promise.all(names.map(attempt))`, sin serializar nada) pasaba igual: la única
    // aserción que sí llegaba al nivel del test (`started[0] === 'scope'`) se cumplía
    // por el orden síncrono de Array.prototype.map(), estuviera o no serializada la
    // ejecución real. Confirmado con mutation testing — ver task-8-report.md.
    const events: Array<{ auditor: string; fase: 'inicio' | 'fin' }> = [];
    const client = {
      messages: {
        parse: vi.fn(async (args: Record<string, unknown>) => {
          const msgs = args['messages'] as Array<{ content: string }>;
          const matches = [...msgs[0]!.content.matchAll(/"([a-z]+)"/g)];
          const name = matches.at(-1)?.[1] ?? 'unknown';
          events.push({ auditor: name, fase: 'inicio' });
          await new Promise((r) => setTimeout(r, 10));
          events.push({ auditor: name, fase: 'fin' });
          return { parsed_output: { auditor: name, status: 'PASS', findings: [] } };
        }),
      },
    } as unknown as AnthropicLike;

    await runAuditors({ client, names: ['scope', 'backend', 'security'], prompts, sharedContext: 'c', policy });

    const firstFinIndex = events.findIndex((e) => e.auditor === 'scope' && e.fase === 'fin');
    const otherStartIndexes = events
      .map((e, i) => ({ ...e, i }))
      .filter((e) => e.auditor !== 'scope' && e.fase === 'inicio')
      .map((e) => e.i);

    // El primer auditor tiene que existir y haber terminado.
    expect(firstFinIndex).toBeGreaterThanOrEqual(0);
    // Los otros dos auditores tienen que haber arrancado.
    expect(otherStartIndexes).toHaveLength(2);
    // Y ninguno de ellos puede haber arrancado antes de que el primero terminara.
    for (const startIndex of otherStartIndexes) {
      expect(startIndex).toBeGreaterThan(firstFinIndex);
    }
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

  it('documenta qué pasa si el PRIMER auditor no tiene prompt: el caché no se cebó y el resto igual se lanza, pero en paralelo', async () => {
    // Si `names[0]` no tiene prompt, `attempt(first)` retorna temprano sin invocar
    // runAuditor: no hay llamada a la API, así que el bloque de contexto compartido
    // nunca se escribe en el caché de Anthropic. Acto seguido `Promise.all(rest.map(attempt))`
    // lanza a todos los demás auditores en paralelo de todas formas — exactamente el
    // escenario económico (todos pagan la escritura completa del caché) que el módulo
    // existe para evitar. Este test no arregla nada: documenta el comportamiento actual.
    const events: Array<{ auditor: string; fase: 'inicio' | 'fin' }> = [];
    const client = {
      messages: {
        parse: vi.fn(async (args: Record<string, unknown>) => {
          const msgs = args['messages'] as Array<{ content: string }>;
          const matches = [...msgs[0]!.content.matchAll(/"([a-z]+)"/g)];
          const name = matches.at(-1)?.[1] ?? 'unknown';
          events.push({ auditor: name, fase: 'inicio' });
          await new Promise((r) => setTimeout(r, 10));
          events.push({ auditor: name, fase: 'fin' });
          return { parsed_output: { auditor: name, status: 'PASS', findings: [] } };
        }),
      },
    } as unknown as AnthropicLike;

    const { results, errors } = await runAuditors({
      client,
      names: ['fantasma', 'backend', 'security'],
      prompts,
      sharedContext: 'c',
      policy,
    });

    // El auditor sin prompt no llega a invocar a la API: solo hay 2 resultados y 1 error.
    expect(results).toHaveLength(2);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('fantasma');

    // Comportamiento observado: backend y security arrancan los dos ANTES de que
    // cualquiera termine — es decir, corren en paralelo, sin haber cebado el caché.
    const startIndexes = events
      .map((e, i) => ({ ...e, i }))
      .filter((e) => e.fase === 'inicio')
      .map((e) => e.i);
    const firstFinIndex = events.findIndex((e) => e.fase === 'fin');
    expect(startIndexes).toHaveLength(2);
    for (const startIndex of startIndexes) {
      expect(startIndex).toBeLessThan(firstFinIndex);
    }
  });
});
