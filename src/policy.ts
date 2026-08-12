import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { z } from 'zod';
import { SEVERITIES } from './types.js';
import type { Decision, Finding, Policy, RunnerResult } from './types.js';

const here = dirname(fileURLToPath(import.meta.url));

// Forma cruda del YAML — snake_case, todo opcional (se completa con
// `normalize`). `parse(...) as RawPolicy` no valida nada en runtime: un
// `.ai/policy.yaml` de un repo consumidor con `block_on: HIGH` (string en vez
// de array) pasaba el cast sin error, y `"HIGH".includes(f.severity)` es una
// llamada de JS perfectamente válida cuyo resultado no es el esperado. El
// Policy Engine tomaba decisiones silenciosamente incorrectas. Validar con
// zod convierte eso en un error visible en vez de un veredicto mal calculado.
const TriggerSchema = z.enum([
  'backend_changed',
  'database_changed',
  'infra_changed',
  'auth_changed',
  'deps_changed',
  'endpoints_changed',
]);

const AuditorPolicySchema = z.object({
  when: z.union([z.literal('always'), z.literal('criteria_available'), z.array(TriggerSchema)]),
  effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).optional(),
  model: z.string().optional(),
});

const RawPolicySchema = z.object({
  model: z.string().optional(),
  required: z.array(z.enum(['build', 'tests'])).optional(),
  block_on: z.array(z.enum(SEVERITIES)).optional(),
  min_confidence: z.number().min(0).max(1).optional(),
  on_test_failure: z.object({ run_auditors: z.array(z.string()).optional() }).optional(),
  auditors: z.record(z.string(), AuditorPolicySchema).optional(),
});

type RawPolicy = z.infer<typeof RawPolicySchema>;

function parsePolicy(source: string, label: string): RawPolicy {
  const yaml: unknown = parse(source);
  const result = RawPolicySchema.safeParse(yaml);
  if (!result.success) {
    const issue = result.error.issues[0];
    const field = issue && issue.path.length > 0 ? issue.path.join('.') : '(raíz del documento)';
    const detail = issue?.message ?? result.error.message;
    throw new Error(
      `Política inválida en ${label}: el campo "${field}" no cumple el esquema esperado (${detail}). Revisá el YAML.`,
    );
  }
  return result.data;
}

function normalize(raw: RawPolicy, base?: Policy): Policy {
  return {
    model: raw.model ?? base?.model ?? 'claude-sonnet-5',
    required: raw.required ?? base?.required ?? ['build', 'tests'],
    blockOn: raw.block_on ?? base?.blockOn ?? ['CRITICAL', 'HIGH'],
    minConfidence: raw.min_confidence ?? base?.minConfidence ?? 0.7,
    onTestFailure: {
      runAuditors: raw.on_test_failure?.run_auditors ?? base?.onTestFailure.runAuditors ?? [],
    },
    auditors: raw.auditors ?? base?.auditors ?? {},
  };
}

export async function loadPolicy(repoDir: string): Promise<Policy> {
  const defaultPath = join(here, '..', 'policies', 'default.yaml');
  const defaultRaw = parsePolicy(await readFile(defaultPath, 'utf8'), defaultPath);
  const defaults = normalize(defaultRaw);

  const overridePath = join(repoDir, '.ai', 'policy.yaml');
  let overrideSource: string;
  try {
    overrideSource = await readFile(overridePath, 'utf8');
  } catch (err) {
    // Sin override: el repo consumidor no pisó la política, no es un error.
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return defaults;
    throw err;
  }

  // A partir de acá el archivo existe: un YAML malformado o que no cumple el
  // esquema tiene que lanzar, no degradar en silencio a la política por
  // defecto — es mejor un ERROR visible que aprobar PRs con una política que
  // nadie escribió.
  const overrideRaw = parsePolicy(overrideSource, overridePath);
  return normalize(overrideRaw, defaults);
}

// `runner.X` es `null` en dos situaciones muy distintas: el paso no aplica
// para este stack (p. ej. Maven no tiene un `install` separado) o el stack
// nunca se reconoció (`detectStack` devuelve los tres pasos en null). Sólo la
// segunda es indistinguible de un stack conocido: ningún stack soportado deja
// los tres pasos en null a la vez, así que esta condición identifica
// exactamente ese caso sin necesitar el `StackInfo` original.
function nothingRan(runner: RunnerResult): boolean {
  return runner.install === null && runner.build === null && runner.test === null;
}

const UNVERIFIED_NOTE =
  ' El stack del repositorio no fue reconocido: no se instalaron dependencias, no se corrió build ni tests. Este veredicto no verifica nada — revisá `detectStack` o agregá el stack al orquestador.';

export function decide(policy: Policy, runner: RunnerResult, findings: Finding[]): Decision {
  const blocking = findings.filter(
    (f) => policy.blockOn.includes(f.severity) && f.confidence >= policy.minConfidence,
  );
  const informational = findings.filter((f) => !blocking.includes(f));
  const unverifiedNote = nothingRan(runner) ? UNVERIFIED_NOTE : '';

  if (runner.install && !runner.install.ok) {
    return { verdict: 'FAIL', blocking, informational, reason: 'La instalación de dependencias falló.' };
  }

  if (policy.required.includes('build') && runner.build && !runner.build.ok) {
    return { verdict: 'FAIL', blocking, informational, reason: 'El build falló.' };
  }

  if (policy.required.includes('tests') && runner.test && !runner.test.ok) {
    return { verdict: 'FAIL', blocking, informational, reason: 'Los tests fallaron.' };
  }

  if (blocking.length > 0) {
    return {
      verdict: 'FAIL',
      blocking,
      informational,
      reason: `${blocking.length} finding(s) bloqueante(s).${unverifiedNote}`,
    };
  }

  return { verdict: 'PASS', blocking, informational, reason: `Sin findings bloqueantes.${unverifiedNote}` };
}
