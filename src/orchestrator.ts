import { runAuditor, type LlmClient } from './auditor.js';
import type { AuditorResult, Policy } from './types.js';

export interface RunAuditorsDeps {
  client: LlmClient;
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

  // Un auditor sin prompt no llega a llamar a la API, así que no puede cebar
  // nada. Se descarta acá para que el turno de cebado le toque a alguien que
  // sí va a escribir el caché.
  const runnable: Array<{ name: string; prompt: string }> = [];
  for (const name of names) {
    const prompt = prompts[name];
    if (prompt) {
      runnable.push({ name, prompt });
    } else {
      errors.push(`No se encontró el prompt del auditor "${name}" en agents/.`);
    }
  }

  const attempt = async ({ name, prompt }: { name: string; prompt: string }): Promise<void> => {
    try {
      results.push(await runAuditor({ client, name, prompt, sharedContext, policy }));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      errors.push(`El auditor "${name}" falló: ${message}`);
    }
  };

  const [primer, ...rest] = runnable;
  if (primer === undefined) return { results, errors };

  // El primero corre solo: escribe el caché del contexto compartido.
  // Los demás sólo pueden leerlo una vez que esta llamada terminó.
  await attempt(primer);

  await Promise.all(rest.map(attempt));

  return { results, errors };
}
