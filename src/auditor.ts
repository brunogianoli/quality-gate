import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { AuditorResultSchema, type AuditContext, type AuditorResult, type Policy } from './types.js';

export interface AnthropicLike {
  messages: {
    parse(args: Record<string, unknown>): Promise<{ parsed_output: unknown }>;
  };
}

function renderCommand(label: string, result: { ok: boolean; output: string } | null): string {
  if (!result) return `### ${label}\nno se ejecutó\n`;
  return `### ${label}\n${result.ok ? 'PASÓ' : 'FALLÓ'}\n\n\`\`\`\n${result.output}\n\`\`\`\n`;
}

export function renderSharedContext(ctx: AuditContext): string {
  const criteria =
    ctx.criteria === null
      ? '(sin criterios declarados: la PR no cierra ningún issue y su descripción está vacía)'
      : `Fuente: ${ctx.criteriaSource}\n\n${ctx.criteria}`;

  const files = ctx.changedFiles
    .map((f) => `- ${f.path} (${f.status}, +${f.additions}/-${f.deletions})`)
    .join('\n');

  const diff = ctx.changedFiles
    .filter((f) => f.patch !== null)
    .map((f) => `--- ${f.path}\n${f.patch}`)
    .join('\n\n');

  return [
    `# Pull Request #${ctx.prNumber} — commit ${ctx.commitSha}`,
    '',
    '## Criterios de aceptación',
    criteria,
    '',
    '## Archivos modificados',
    files,
    '',
    '## Diff',
    '```diff',
    diff,
    '```',
    '',
    '## Ejecución real',
    renderCommand('Build', ctx.runner.build),
    renderCommand('Tests', ctx.runner.test),
  ].join('\n');
}

export interface RunAuditorDeps {
  client: AnthropicLike;
  name: string;
  prompt: string;
  sharedContext: string;
  policy: Policy;
}

export async function runAuditor(deps: RunAuditorDeps): Promise<AuditorResult> {
  const { client, name, prompt, sharedContext, policy } = deps;
  const cfg = policy.auditors[name];

  const response = await client.messages.parse({
    model: cfg?.model ?? policy.model,
    max_tokens: 16000,
    output_config: {
      effort: cfg?.effort ?? 'high',
      format: zodOutputFormat(AuditorResultSchema),
    },
    system: [
      { type: 'text', text: sharedContext, cache_control: { type: 'ephemeral' } },
      { type: 'text', text: prompt },
    ],
    messages: [
      {
        role: 'user',
        content: `Auditá este cambio siguiendo tu contrato. Tu campo "auditor" debe ser exactamente "${name}".`,
      },
    ],
  });

  const parsed = AuditorResultSchema.safeParse(response.parsed_output);
  if (!parsed.success) {
    throw new Error(`El auditor ${name} devolvió una respuesta inválida: ${parsed.error.message}`);
  }

  return { ...parsed.data, auditor: name };
}
