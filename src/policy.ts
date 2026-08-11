import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import type { Decision, Finding, Policy, RunnerResult } from './types.js';

const here = dirname(fileURLToPath(import.meta.url));

interface RawPolicy {
  model?: string;
  required?: Array<'build' | 'tests'>;
  block_on?: Policy['blockOn'];
  min_confidence?: number;
  on_test_failure?: { run_auditors?: string[] };
  auditors?: Policy['auditors'];
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
  const defaultRaw = parse(
    await readFile(join(here, '..', 'policies', 'default.yaml'), 'utf8'),
  ) as RawPolicy;
  const defaults = normalize(defaultRaw);

  try {
    const overrideRaw = parse(
      await readFile(join(repoDir, '.ai', 'policy.yaml'), 'utf8'),
    ) as RawPolicy;
    return normalize(overrideRaw, defaults);
  } catch {
    return defaults;
  }
}

export function decide(policy: Policy, runner: RunnerResult, findings: Finding[]): Decision {
  const blocking = findings.filter(
    (f) => policy.blockOn.includes(f.severity) && f.confidence >= policy.minConfidence,
  );
  const informational = findings.filter((f) => !blocking.includes(f));

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
      reason: `${blocking.length} finding(s) bloqueante(s).`,
    };
  }

  return { verdict: 'PASS', blocking, informational, reason: 'Sin findings bloqueantes.' };
}
