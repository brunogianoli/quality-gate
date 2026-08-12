import { z } from 'zod';

export const SEVERITIES = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO'] as const;
export type Severity = (typeof SEVERITIES)[number];

export const FindingSchema = z.object({
  severity: z.enum(SEVERITIES),
  confidence: z.number().min(0).max(1),
  title: z.string(),
  file: z.string(),
  line: z.number().int().nullable(),
  message: z.string(),
  evidence: z.string().nullable(),
  suggestedFix: z.string().nullable(),
});
export type Finding = z.infer<typeof FindingSchema>;

export const AuditorResultSchema = z.object({
  auditor: z.string(),
  status: z.enum(['PASS', 'FAIL']),
  findings: z.array(FindingSchema),
});
export type AuditorResult = z.infer<typeof AuditorResultSchema>;

export type StackKind = 'node' | 'java-maven' | 'python' | 'unknown';

export interface StackInfo {
  kind: StackKind;
  install: string | null;
  build: string | null;
  test: string | null;
}

export interface CommandResult {
  ok: boolean;
  exitCode: number;
  output: string;
}

export interface RunnerResult {
  install: CommandResult | null;
  build: CommandResult | null;
  test: CommandResult | null;
}

export type FileStatus = 'added' | 'modified' | 'removed' | 'renamed';

export interface ChangedFile {
  path: string;
  status: FileStatus;
  additions: number;
  deletions: number;
  patch: string | null;
}

export interface AuditContext {
  owner: string;
  repo: string;
  prNumber: number;
  commitSha: string;
  changedFiles: ChangedFile[];
  criteria: string | null;
  criteriaSource: 'issue' | 'pull_request' | null;
  runner: RunnerResult;
}

export type Verdict = 'PASS' | 'FAIL' | 'ERROR';

export type Trigger =
  | 'backend_changed'
  | 'database_changed'
  | 'infra_changed'
  | 'auth_changed'
  | 'deps_changed'
  | 'endpoints_changed';

export interface AuditorPolicy {
  when: 'always' | 'criteria_available' | Trigger[];
  // No hay equivalente de `effort`: para que un auditor razone más, se le
  // asigna un modelo más capaz con `model`.
  model?: string;
  timeoutMs?: number;
  maxRetries?: number;
}

export interface Policy {
  model: string;
  required: Array<'build' | 'tests'>;
  blockOn: Severity[];
  minConfidence: number;
  // Milisegundos por auditor. Un auditor colgado no puede quedarse con el
  // presupuesto del job entero: al vencer, la llamada falla y el auditor
  // aporta un error, que degrada a ERROR y no bloquea el merge.
  timeoutMs: number;
  // Reintentos ante 429 y 5xx, con backoff exponencial del SDK. Uno alcanza:
  // absorbe un pico de rate limit sin multiplicar el gasto si la API está caída.
  maxRetries: number;
  onTestFailure: { runAuditors: string[] };
  auditors: Record<string, AuditorPolicy>;
}

export interface Decision {
  verdict: Verdict;
  blocking: Finding[];
  informational: Finding[];
  reason: string;
}
