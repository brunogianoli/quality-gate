import type { AuditContext, Decision, Finding, Verdict } from './types.js';

export const MARKER = '<!-- ai-quality-gate -->';

export interface ReportOctokit {
  issues: {
    listComments(args: { owner: string; repo: string; issue_number: number; per_page?: number }): Promise<{
      data: Array<{ id: number; body?: string | undefined }>;
    }>;
    createComment(args: { owner: string; repo: string; issue_number: number; body: string }): Promise<unknown>;
    updateComment(args: { owner: string; repo: string; comment_id: number; body: string }): Promise<unknown>;
  };
  checks: {
    create(args: Record<string, unknown>): Promise<unknown>;
  };
}

const ICON: Record<Verdict, string> = { PASS: '🟢', FAIL: '🔴', ERROR: '⚪' };
const LABEL: Record<Verdict, string> = { PASS: 'PASSED', FAIL: 'FAILED', ERROR: 'ERROR' };
const SEVERITY_ICON: Record<Finding['severity'], string> = {
  CRITICAL: '🔴',
  HIGH: '🔴',
  MEDIUM: '🟡',
  LOW: '🔵',
  INFO: '⚪',
};

function renderFinding(f: Finding): string {
  const location = f.line === null ? f.file : `${f.file}:${f.line}`;
  const lines = [
    `### ${SEVERITY_ICON[f.severity]} ${f.severity} · \`${location}\``,
    f.title,
    '',
    f.message,
  ];
  if (f.evidence) lines.push('', `> ${f.evidence}`);
  if (f.suggestedFix) lines.push('', `**Sugerencia:** ${f.suggestedFix}`);
  return lines.join('\n');
}

export interface RenderCommentDeps {
  ctx: AuditContext;
  decision: Decision;
  auditors: string[];
  errors: string[];
}

export function renderComment(deps: RenderCommentDeps): string {
  const { ctx, decision, auditors, errors } = deps;
  const parts: string[] = [
    MARKER,
    `## ${ICON[decision.verdict]} Quality Gate — ${LABEL[decision.verdict]} · commit ${ctx.commitSha}`,
    '',
    decision.reason,
    '',
  ];

  if (ctx.runner.install) parts.push(`**Install:** ${ctx.runner.install.ok ? 'ok' : 'falló'}`);
  if (ctx.runner.build) parts.push(`**Build:** ${ctx.runner.build.ok ? 'ok' : 'falló'}`);
  if (ctx.runner.test) parts.push(`**Tests:** ${ctx.runner.test.ok ? 'ok' : 'fallaron'}`);
  parts.push(`**Auditores:** ${auditors.length > 0 ? auditors.join(' · ') : 'ninguno'}`);

  if (ctx.criteriaSource === null) {
    parts.push('', '> `acceptance` no corrió: sin criterios declarados (la PR no cierra ningún issue y su descripción está vacía).');
  }

  if (errors.length > 0) {
    parts.push('', '> Algunos auditores **no pudieron ejecutarse**. El resultado es parcial:', ...errors.map((e) => `> - ${e}`));
  }

  if (decision.blocking.length > 0) {
    parts.push('', '---', '', ...decision.blocking.map(renderFinding));
  }

  if (decision.informational.length > 0) {
    parts.push('', '---', '', '<details><summary>Findings informativos (no bloquean)</summary>', '', ...decision.informational.map(renderFinding), '', '</details>');
  }

  // El paso que efectivamente falló es el que aporta información: el runner
  // corta en el primer fallo (install → build → test), así que a lo sumo uno
  // de los tres está en `!ok`. Volcar su output completo es lo que le permite
  // al agente que lee el comentario corregir sin adivinar.
  const failedStep = [ctx.runner.install, ctx.runner.build, ctx.runner.test].find(
    (step) => step !== null && !step.ok,
  );
  if (decision.verdict === 'FAIL' && failedStep) {
    parts.push('', '```', failedStep.output, '```');
  }

  return parts.join('\n');
}

export async function upsertComment(
  octokit: ReportOctokit,
  ctx: AuditContext,
  body: string,
): Promise<void> {
  const { data } = await octokit.issues.listComments({
    owner: ctx.owner,
    repo: ctx.repo,
    issue_number: ctx.prNumber,
    per_page: 100,
  });

  const existing = data.find((c) => c.body?.includes(MARKER));

  if (existing) {
    await octokit.issues.updateComment({
      owner: ctx.owner,
      repo: ctx.repo,
      comment_id: existing.id,
      body,
    });
    return;
  }

  await octokit.issues.createComment({
    owner: ctx.owner,
    repo: ctx.repo,
    issue_number: ctx.prNumber,
    body,
  });
}

const CONCLUSION: Record<Verdict, 'success' | 'failure' | 'neutral'> = {
  PASS: 'success',
  FAIL: 'failure',
  ERROR: 'neutral',
};

export async function publishCheck(
  octokit: ReportOctokit,
  ctx: AuditContext,
  decision: Decision,
): Promise<void> {
  await octokit.checks.create({
    owner: ctx.owner,
    repo: ctx.repo,
    name: 'AI Quality Gate',
    head_sha: ctx.commitSha,
    status: 'completed',
    conclusion: CONCLUSION[decision.verdict],
    output: {
      title: `${LABEL[decision.verdict]} — ${decision.reason}`,
      summary: decision.reason,
      annotations: decision.blocking.slice(0, 50).map((f) => ({
        path: f.file,
        start_line: f.line ?? 1,
        end_line: f.line ?? 1,
        annotation_level: 'failure',
        title: `${f.severity}: ${f.title}`,
        message: f.suggestedFix ? `${f.message}\n\nSugerencia: ${f.suggestedFix}` : f.message,
      })),
    },
  });
}
