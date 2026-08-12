import { z } from 'zod';
import { AuditorResultSchema, type AuditContext, type AuditorResult, type Policy } from './types.js';

export interface RequestOptions {
  timeout: number;
  maxRetries: number;
}

interface ContentBlock {
  type: string;
  input?: unknown;
}

// El SDK es el de Anthropic, pero apuntado al endpoint compatible de DeepSeek:
// de ahí que el tipo describa la forma de la API y no al proveedor.
export interface LlmClient {
  messages: {
    create(
      args: Record<string, unknown>,
      options?: RequestOptions,
    ): Promise<{ content: ContentBlock[] }>;
  };
}

export const TOOL_NAME = 'reportar_auditoria';

// El esquema de la herramienta sale del mismo zod que después valida la
// respuesta: si divergieran, el modelo podría cumplir el contrato declarado y
// fallar igual la validación. `$schema` se quita porque describe al documento,
// no al parámetro, y la API no lo espera.
function toolInputSchema(): Record<string, unknown> {
  const { $schema: _descartado, ...schema } = z.toJSONSchema(AuditorResultSchema) as Record<
    string,
    unknown
  >;
  return schema;
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
  client: LlmClient;
  name: string;
  prompt: string;
  sharedContext: string;
  policy: Policy;
}

export async function runAuditor(deps: RunAuditorDeps): Promise<AuditorResult> {
  const { client, name, prompt, sharedContext, policy } = deps;
  const cfg = policy.auditors[name];

  const response = await client.messages.create(
    {
      model: cfg?.model ?? policy.model,
      max_tokens: 16000,
      tools: [
        {
          name: TOOL_NAME,
          description:
            'Reporta el resultado de tu auditoría. Es la única forma de responder: todo hallazgo va acá, no en texto libre.',
          input_schema: toolInputSchema(),
        },
      ],
      // Forzada, no sugerida. Pedirle el esquema por prompt hace que a veces
      // conteste en prosa, y entonces no hay resultado que leer.
      tool_choice: { type: 'tool', name: TOOL_NAME },
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
    },
    // El SDK reintenta 429 y 5xx con backoff exponencial; declararlo acá hace
    // que los valores salgan de la política y no de sus defaults.
    {
      timeout: cfg?.timeoutMs ?? policy.timeoutMs,
      maxRetries: cfg?.maxRetries ?? policy.maxRetries,
    },
  );

  const reporte = response.content.find((block) => block.type === 'tool_use');
  if (!reporte) {
    const tipos = response.content.map((block) => block.type).join(', ') || 'ninguno';
    throw new Error(
      `El auditor ${name} no usó la herramienta para reportar: la respuesta trajo ${tipos}.`,
    );
  }

  const parsed = AuditorResultSchema.safeParse(reporte.input);
  if (!parsed.success) {
    throw new Error(`El auditor ${name} devolvió una respuesta inválida: ${parsed.error.message}`);
  }

  return { ...parsed.data, auditor: name };
}
