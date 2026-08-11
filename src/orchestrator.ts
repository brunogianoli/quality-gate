import { runAuditor, type AnthropicLike } from './auditor.js';
import type { AuditorResult, Policy } from './types.js';

export interface RunAuditorsDeps {
  client: AnthropicLike;
  names: string[];
  prompts: Record<string, string>;
  sharedContext: string;
  policy: Policy;
}

export interface RunAuditorsOutcome {
  results: AuditorResult[];
  errors: string[];
}

export async function runAuditors(deps: RunAuditorsDeps): Promise<RunAuditorsOutcome> {
  const { client, names, prompts, sharedContext, policy } = deps;
  const results: AuditorResult[] = [];
  const errors: string[] = [];

  const attempt = async (name: string): Promise<void> => {
    const prompt = prompts[name];
    if (!prompt) {
      errors.push(`No se encontró el prompt del auditor "${name}" en agents/.`);
      return;
    }
    try {
      results.push(await runAuditor({ client, name, prompt, sharedContext, policy }));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      errors.push(`El auditor "${name}" falló: ${message}`);
    }
  };

  const [first, ...rest] = names;
  if (first === undefined) return { results, errors };

  // El primero corre solo: escribe el caché del contexto compartido.
  // Los demás sólo pueden leerlo una vez que esta llamada terminó.
  await attempt(first);

  await Promise.all(rest.map(attempt));

  return { results, errors };
}
