import Anthropic from '@anthropic-ai/sdk';
import { Octokit } from '@octokit/rest';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { selectAuditors } from './analyzer.js';
import { renderSharedContext, type LlmClient } from './auditor.js';
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
  anthropic: LlmClient;
  octokit: OctokitLike & ReportOctokit;
  loadPolicy: (dir: string) => Promise<Policy>;
  prompts: Record<string, string>;
  detect: (dir: string) => Promise<StackInfo>;
  run: (stack: StackInfo, dir: string) => Promise<RunnerResult>;
}

export async function runGate(deps: GateDeps): Promise<Decision> {
  let ctx: AuditContext | null = null;

  try {
    // Carga la política adentro del try/catch a propósito: desde que
    // loadPolicy() valida el YAML con zod (ver policy.ts), un
    // .ai/policy.yaml malformado lanza en vez de degradar en silencio. Si
    // esa llamada quedara afuera —como GateDeps recibía la política ya
    // construida—, la excepción escaparía de runGate entero y el proceso
    // moriría con un stack trace en el log en vez del veredicto ERROR con
    // check neutral y comentario que el spec define para cualquier fallo
    // del gate (§8).
    const policy = await deps.loadPolicy(deps.workspace);

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
      names = selectAuditors(policy, ctx.changedFiles, {
        criteriaAvailable: ctx.criteria !== null,
        testsFailed,
      });

      if (names.length > 0) {
        results = await runAuditors({
          client: deps.anthropic,
          names,
          prompts: deps.prompts,
          sharedContext: renderSharedContext(ctx),
          policy,
        });
      }
    }

    const findings = results.results.flatMap((r) => r.findings);
    let decision = decide(policy, runner, findings);

    // Un veredicto verde afirma que alguien miró el cambio. Si se seleccionaron
    // auditores y ninguno pudo ejecutarse, nadie lo miró: aprobar ahí es
    // exactamente el "APPROVED sin verificar" que el gate existe para impedir.
    // Degrada a ERROR, que deja el check neutral y no bloquea el merge — un
    // outage del proveedor no puede frenar al equipo, pero tampoco puede
    // hacerse pasar por una aprobación.
    //
    // Sólo se degrada un PASS: un FAIL por build, tests o findings se sostiene
    // con evidencia propia y perderlo desbloquearía un merge que debía frenarse.
    if (decision.verdict === 'PASS' && names.length > 0 && results.results.length === 0) {
      decision = {
        ...decision,
        verdict: 'ERROR',
        reason: `Ningún auditor pudo ejecutarse (fallaron los ${names.length} seleccionados). El gate no verificó este cambio.`,
      };
    }

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

// Endpoint de DeepSeek que habla el formato de la API de Anthropic. Se puede
// pisar con el input `api-base-url` para apuntar a otro proveedor compatible.
export const DEEPSEEK_BASE_URL = 'https://api.deepseek.com/anthropic';

// GitHub Actions expone cada input declarado en action.yml como una variable
// de entorno `INPUT_<NOMBRE>`, en mayúsculas, con los espacios convertidos en
// guiones bajos — pero los guiones se preservan tal cual. Es el mismo
// comportamiento que implementa @actions/core.getInput().
export function input(name: string): string | undefined {
  return process.env[`INPUT_${name.replace(/ /g, '_').toUpperCase()}`];
}

export function requiredInput(name: string): string {
  const value = input(name);
  if (!value) throw new Error(`Falta el input ${name}`);
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
    // El SDK es el de Anthropic porque DeepSeek expone su API con ese mismo
    // formato. Lo que no cubre son los structured outputs por esquema: por eso
    // `runAuditor` pide el resultado con una herramienta forzada.
    anthropic: new Anthropic({
      apiKey: requiredInput('deepseek-api-key'),
      baseURL: input('api-base-url') ?? DEEPSEEK_BASE_URL,
    }) as unknown as LlmClient,
    octokit: new Octokit({
      auth: requiredInput('github-token'),
    }) as unknown as OctokitLike & ReportOctokit,
    loadPolicy,
    prompts: await loadPrompts(),
    detect: detectStack,
    run: runStack,
  });

  console.log(`Quality Gate: ${decision.verdict} — ${decision.reason}`);
}

// GitHub Actions define GITHUB_ACTIONS=true en todos los jobs siempre, no
// sólo cuando este bundle corre como la Action — así que no sirve para
// distinguir "me importaron" de "me ejecutaron directamente". El patrón
// correcto en ESM es comparar la URL de este módulo con el argumento que
// lanzó el proceso: sólo coinciden cuando node ejecutó este archivo como
// entrypoint (`node dist/index.js`), no cuando otro módulo (p. ej. un test)
// lo importa.
const isEntrypoint =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isEntrypoint) {
  await main();
}
