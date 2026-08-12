import { describe, it, expect, beforeAll } from 'vitest';
import Anthropic from '@anthropic-ai/sdk';
import { renderSharedContext, runAuditor, type LlmClient } from '../../src/auditor.js';
import { loadPrompts } from '../../src/prompts.js';
import { decide, loadPolicy } from '../../src/policy.js';
import { DEEPSEEK_BASE_URL } from '../../src/cli.js';
import type { Finding, Policy } from '../../src/types.js';
import { GOLDEN_PROMPT_CASES } from './cases.js';

// El golden set de los prompts: la única red que protege la calibración de
// severidad. `tests/golden/cases.ts` prueba `decide()` con findings escritos a
// mano, así que un cambio en `agents/*.md` que reintroduzca ruido no rompe nada
// ahí. Estos casos llaman a la API de verdad, por eso viven fuera de `npm test`
// y corren con `npm run test:prompts`.
//
// Se afirma sobre bloquear o no bloquear, nunca sobre el texto: la redacción
// cambia en cada corrida y un test atado a ella sería ruido propio.

const apiKey = process.env['DEEPSEEK_API_KEY'];

function describirFindings(findings: Finding[]): string {
  if (findings.length === 0) return '(ninguno)';
  return findings
    .map((f) => `    ${f.severity} conf=${f.confidence} — ${f.title} [${f.file}:${f.line ?? '?'}]`)
    .join('\n');
}

describe.skipIf(!apiKey)('golden set de prompts', () => {
  let prompts: Record<string, string>;
  let policy: Policy;
  let client: LlmClient;

  beforeAll(async () => {
    prompts = await loadPrompts();
    policy = await loadPolicy(process.cwd());
    client = new Anthropic({ apiKey, baseURL: DEEPSEEK_BASE_URL }) as unknown as LlmClient;
  });

  for (const caso of GOLDEN_PROMPT_CASES) {
    it(
      `${caso.auditor}: ${caso.nombre} → ${caso.espera}`,
      async () => {
        const prompt = prompts[caso.auditor];
        expect(prompt, `no existe agents/${caso.auditor}.md`).toBeDefined();

        const result = await runAuditor({
          client,
          name: caso.auditor,
          prompt: prompt!,
          sharedContext: renderSharedContext(caso.ctx),
          policy,
        });

        // `decide` aplica la misma regla que en producción (blockOn +
        // minConfidence). Sólo se mira `blocking`: el veredicto depende también
        // del runner, y algunos casos traen tests en rojo a propósito.
        const { blocking } = decide(policy, caso.ctx.runner, result.findings);

        const detalle = [
          '',
          `  por qué este caso: ${caso.porque}`,
          `  findings devueltos (${result.findings.length}):`,
          describirFindings(result.findings),
          `  bloqueantes: ${blocking.length}`,
        ].join('\n');

        if (caso.espera === 'sin bloqueantes') {
          expect(blocking.length, `debería no bloquear y bloqueó${detalle}`).toBe(0);
        } else {
          expect(blocking.length, `debería bloquear y no bloqueó${detalle}`).toBeGreaterThan(0);
        }
      },
      3 * 60 * 1000,
    );
  }
});
