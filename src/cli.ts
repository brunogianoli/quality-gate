import Anthropic from '@anthropic-ai/sdk';
import { Octokit } from '@octokit/rest';
import { readFile } from 'node:fs/promises';
import { selectAuditors } from './analyzer.js';
import { renderSharedContext, type AnthropicLike } from './auditor.js';
import { buildContext, type OctokitLike } from './context.js';
import { runAuditors } from './orchestrator.js';
import { decide, loadPolicy } from './policy.js';
import { loadPrompts } from './prompts.js';
import { publishCheck, renderComment, upsertComment, type ReportOctokit } from './report.js';
import { detectStack } from './stack.js';
import { runStack } from './runner.js';
import type { AuditContext, Decision, Policy, RunnerResult, StackInfo } from './types.js';

export interface GateDeps {
  owner: string;
  repo: string;
  prNumber: number;
  commitSha: string;
  workspace: string;
  anthropic: AnthropicLike;
  octokit: OctokitLike & ReportOctokit;
  policy: Policy;
  prompts: Record<string, string>;
  detect: (dir: string) => Promise<StackInfo>;
  run: (stack: StackInfo, dir: string) => Promise<RunnerResult>;
}

export async function runGate(deps: GateDeps): Promise<Decision> {
  let ctx: AuditContext | null = null;

  try {
    const stack = await deps.detect(deps.workspace);
    const runner = await deps.run(stack, deps.workspace);

    ctx = await buildContext({
      octokit: deps.octokit,
      owner: deps.owner,
      repo: deps.repo,
      prNumber: deps.prNumber,
      commitSha: deps.commitSha,
      runner,
    });

    const buildFailed = Boolean(
      (runner.install && !runner.install.ok) || (runner.build && !runner.build.ok),
    );
    const testsFailed = Boolean(runner.test && !runner.test.ok);

    let names: string[] = [];
    let results: Awaited<ReturnType<typeof runAuditors>> = { results: [], errors: [] };

    // Corte total ante un build roto: el error del compilador ya es el mensaje.
    if (!buildFailed) {
      names = selectAuditors(deps.policy, ctx.changedFiles, {
        criteriaAvailable: ctx.criteria !== null,
        testsFailed,
      });

      if (names.length > 0) {
        results = await runAuditors({
          client: deps.anthropic,
          names,
          prompts: deps.prompts,
          sharedContext: renderSharedContext(ctx),
          policy: deps.policy,
        });
      }
    }

    const findings = results.results.flatMap((r) => r.findings);
    const decision = decide(deps.policy, runner, findings);

    await upsertComment(
      deps.octokit,
      ctx,
      renderComment({ ctx, decision, auditors: names, errors: results.errors }),
    );
    await publishCheck(deps.octokit, ctx, decision);

    return decision;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const decision: Decision = {
      verdict: 'ERROR',
      blocking: [],
      informational: [],
      reason: `El quality gate no pudo completarse: ${message}`,
    };

    const fallback: AuditContext = ctx ?? {
      owner: deps.owner,
      repo: deps.repo,
      prNumber: deps.prNumber,
      commitSha: deps.commitSha,
      changedFiles: [],
      criteria: null,
      criteriaSource: null,
      runner: { install: null, build: null, test: null },
    };

    try {
      await upsertComment(
        deps.octokit,
        fallback,
        renderComment({ ctx: fallback, decision, auditors: [], errors: [message] }),
      );
      await publishCheck(deps.octokit, fallback, decision);
    } catch {
      // Si tampoco se puede reportar, no hay nada más que hacer.
    }

    return decision;
  }
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Falta la variable de entorno ${name}`);
  return value;
}

export async function main(): Promise<void> {
  const eventPath = required('GITHUB_EVENT_PATH');
  const event = JSON.parse(await readFile(eventPath, 'utf8')) as {
    pull_request?: { number: number; head: { sha: string } };
  };

  if (!event.pull_request) {
    console.log('No es un evento de pull_request; no hay nada que auditar.');
    return;
  }

  const [owner, repo] = required('GITHUB_REPOSITORY').split('/');
  if (!owner || !repo) throw new Error('GITHUB_REPOSITORY mal formado');

  const workspace = required('GITHUB_WORKSPACE');

  const decision = await runGate({
    owner,
    repo,
    prNumber: event.pull_request.number,
    commitSha: event.pull_request.head.sha,
    workspace,
    anthropic: new Anthropic({ apiKey: required('ANTHROPIC_API_KEY') }) as unknown as AnthropicLike,
    octokit: new Octokit({ auth: required('GITHUB_TOKEN') }) as unknown as OctokitLike & ReportOctokit,
    policy: await loadPolicy(workspace),
    prompts: await loadPrompts(),
    detect: detectStack,
    run: runStack,
  });

  console.log(`Quality Gate: ${decision.verdict} — ${decision.reason}`);
}

if (process.env['GITHUB_ACTIONS'] === 'true') {
  await main();
}
