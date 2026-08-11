# AI Quality Gate — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Construir una GitHub Action que, en cada Pull Request, ejecute el build y los tests del proyecto, audite el cambio con auditores de IA especializados, y publique un veredicto que bloquee o habilite el merge.

**Architecture:** Un paquete TypeScript que se empaqueta como composite Action. `cli.ts` orquesta un pipeline lineal: detectar stack → correr build y tests → armar contexto (diff + criterios) → resolver qué auditores aplican → ejecutarlos en paralelo contra la API de Anthropic con salida JSON forzada por esquema → aplicar una política determinista → publicar comentario y check run. Cada módulo es una función pura o casi pura, testeable sin red.

**Tech Stack:** Node 24, TypeScript (ESM), Vitest, `@octokit/rest`, `@anthropic-ai/sdk`, `zod`, `yaml`, `esbuild` para el bundle de la Action.

## Global Constraints

- **El sistema nunca escribe en el repositorio auditado.** Sin commits, sin push, sin fixes. Sólo comentarios y check runs.
- **El veredicto es determinista.** `policy.ts` decide con una regla fija; ningún LLM emite el veredicto final.
- **`ERROR` no bloquea.** Fallo de API, timeout o rate limit → check `neutral`, nunca `failure`.
- **Modelo por defecto:** `claude-sonnet-5`. Configurable por auditor vía `policy.yaml`.
- **Salida de los auditores por structured outputs** (`output_config.format` con esquema Zod), nunca parseo de texto libre.
- Todo el código en TypeScript ESM estricto (`"type": "module"`, `strict: true`).
- Los archivos de `agents/*.md` se escriben en **inglés** (son prompts para el modelo). El resto de la documentación en español.
- Ningún test de la suite hace peticiones de red reales. La API de Anthropic y Octokit se mockean.

## Desviación respecto del spec (intencional)

El spec describe el Task Analyzer como "una llamada barata" al modelo. Este plan lo implementa **determinista**, por patrones de path (`resolveTriggers`). Motivo: la política ya expresa activación como `when: backend_changed`, que es un mapeo de paths a triggers; resolverlo con globs es gratis, instantáneo, y testeable sin red. Se puede sumar un analyzer con LLM más adelante si los patrones resultan insuficientes.

## File Structure

| Archivo | Responsabilidad |
|---|---|
| `src/types.ts` | Tipos compartidos. Sin lógica. |
| `src/stack.ts` | Detecta el stack del repo y devuelve sus comandos. |
| `src/runner.ts` | Ejecuta comandos de shell y captura resultado truncado. |
| `src/policy.ts` | Carga `policy.yaml` y decide PASS/FAIL. |
| `src/analyzer.ts` | Resuelve triggers desde archivos cambiados y elige auditores. |
| `src/context.ts` | Arma el `AuditContext`: diff, archivos, criterios de aceptación. |
| `src/auditor.ts` | Ejecuta **un** auditor contra la API de Anthropic. |
| `src/orchestrator.ts` | Ejecuta **N** auditores con la secuencia caché-primero. |
| `src/report.ts` | Renderiza el comentario y publica comentario + check run. |
| `src/cli.ts` | Punto de entrada: encadena todo, traduce errores a `ERROR`. |
| `agents/*.md` | Contratos de los auditores (datos, no código). |
| `policies/default.yaml` | Política por defecto. |
| `fixture/` | Repo Node/TS de prueba con casos deterministas. |

---

### Task 1: Scaffolding y tipos compartidos

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `.gitignore`
- Create: `src/types.ts`
- Test: `tests/types.test.ts`

**Interfaces:**
- Consumes: nada.
- Produces: todos los tipos que el resto del plan usa. Los nombres exactos definidos acá son los que aparecen en las tareas siguientes.

- [ ] **Step 1: Crear `package.json`**

```json
{
  "name": "quality-gate",
  "version": "0.1.0",
  "type": "module",
  "private": true,
  "engines": { "node": ">=24" },
  "scripts": {
    "build": "esbuild src/cli.ts --bundle --platform=node --target=node24 --format=esm --outfile=dist/index.js --banner:js=\"import{createRequire}from'module';const require=createRequire(import.meta.url);\"",
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@anthropic-ai/sdk": "^0.68.0",
    "@octokit/rest": "^21.1.1",
    "yaml": "^2.7.0",
    "zod": "^3.24.1"
  },
  "devDependencies": {
    "@types/node": "^24.0.0",
    "esbuild": "^0.25.0",
    "typescript": "^5.7.0",
    "vitest": "^3.0.0"
  }
}
```

- [ ] **Step 2: Crear `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "types": ["node"],
    "noEmit": true
  },
  "include": ["src/**/*.ts", "tests/**/*.ts"]
}
```

- [ ] **Step 3: Crear `vitest.config.ts`**

```typescript
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
  },
});
```

- [ ] **Step 4: Crear `.gitignore`**

```
node_modules/
dist/
*.log
```

- [ ] **Step 5: Instalar dependencias**

Run: `npm install`
Expected: se crea `node_modules/` y `package-lock.json` sin errores.

- [ ] **Step 6: Escribir el test de tipos**

`tests/types.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { FindingSchema, AuditorResultSchema } from '../src/types.js';

describe('FindingSchema', () => {
  it('acepta un finding completo', () => {
    const parsed = FindingSchema.parse({
      severity: 'HIGH',
      confidence: 0.9,
      title: 'Null DNI causes 500',
      file: 'src/a.ts',
      line: 84,
      message: 'El endpoint no valida DNI nulo.',
      evidence: 'test shouldRejectNullDni: expected 400, got 500',
      suggestedFix: 'Validar en el DTO.',
    });
    expect(parsed.severity).toBe('HIGH');
  });

  it('rechaza una severidad desconocida', () => {
    expect(() =>
      FindingSchema.parse({
        severity: 'CATASTROPHIC',
        confidence: 0.9,
        title: 't',
        file: 'f',
        line: null,
        message: 'm',
        evidence: null,
        suggestedFix: null,
      }),
    ).toThrow();
  });

  it('rechaza confidence fuera de rango', () => {
    expect(() =>
      FindingSchema.parse({
        severity: 'LOW',
        confidence: 1.5,
        title: 't',
        file: 'f',
        line: null,
        message: 'm',
        evidence: null,
        suggestedFix: null,
      }),
    ).toThrow();
  });
});

describe('AuditorResultSchema', () => {
  it('acepta un resultado sin findings', () => {
    const parsed = AuditorResultSchema.parse({
      auditor: 'scope',
      status: 'PASS',
      findings: [],
    });
    expect(parsed.findings).toHaveLength(0);
  });
});
```

- [ ] **Step 7: Correr el test para verificar que falla**

Run: `npx vitest run tests/types.test.ts`
Expected: FAIL — `Cannot find module '../src/types.js'`

- [ ] **Step 8: Escribir `src/types.ts`**

```typescript
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
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  model?: string;
}

export interface Policy {
  model: string;
  required: Array<'build' | 'tests'>;
  blockOn: Severity[];
  minConfidence: number;
  onTestFailure: { runAuditors: string[] };
  auditors: Record<string, AuditorPolicy>;
}

export interface Decision {
  verdict: Verdict;
  blocking: Finding[];
  informational: Finding[];
  reason: string;
}
```

- [ ] **Step 9: Correr el test para verificar que pasa**

Run: `npx vitest run tests/types.test.ts`
Expected: PASS — 4 tests.

- [ ] **Step 10: Verificar tipos**

Run: `npm run typecheck`
Expected: sin errores.

- [ ] **Step 11: Commit**

```bash
git add package.json package-lock.json tsconfig.json vitest.config.ts .gitignore src/types.ts tests/types.test.ts
git commit -m "feat: scaffold TypeScript package and shared types"
```

---

### Task 2: Detección de stack

**Files:**
- Create: `src/stack.ts`
- Test: `tests/stack.test.ts`

**Interfaces:**
- Consumes: `StackInfo`, `StackKind` de `src/types.ts`.
- Produces: `detectStack(dir: string): Promise<StackInfo>`.

- [ ] **Step 1: Escribir el test que falla**

`tests/stack.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detectStack } from '../src/stack.js';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'stack-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('detectStack', () => {
  it('detecta Node cuando hay package.json con script de test', async () => {
    await writeFile(
      join(dir, 'package.json'),
      JSON.stringify({ scripts: { build: 'tsc', test: 'vitest run' } }),
    );
    const stack = await detectStack(dir);
    expect(stack.kind).toBe('node');
    expect(stack.install).toBe('npm ci');
    expect(stack.build).toBe('npm run build');
    expect(stack.test).toBe('npm test');
  });

  it('omite el build cuando package.json no define ese script', async () => {
    await writeFile(join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'vitest run' } }));
    const stack = await detectStack(dir);
    expect(stack.build).toBeNull();
    expect(stack.test).toBe('npm test');
  });

  it('detecta Maven cuando hay pom.xml', async () => {
    await writeFile(join(dir, 'pom.xml'), '<project/>');
    const stack = await detectStack(dir);
    expect(stack.kind).toBe('java-maven');
    expect(stack.build).toBe('./mvnw -B compile');
    expect(stack.test).toBe('./mvnw -B test');
  });

  it('detecta Python cuando hay pyproject.toml', async () => {
    await writeFile(join(dir, 'pyproject.toml'), '[project]');
    const stack = await detectStack(dir);
    expect(stack.kind).toBe('python');
    expect(stack.test).toBe('pytest');
  });

  it('devuelve unknown cuando no hay marcadores', async () => {
    const stack = await detectStack(dir);
    expect(stack.kind).toBe('unknown');
    expect(stack.test).toBeNull();
  });
});
```

- [ ] **Step 2: Correr el test para verificar que falla**

Run: `npx vitest run tests/stack.test.ts`
Expected: FAIL — `Cannot find module '../src/stack.js'`

- [ ] **Step 3: Escribir `src/stack.ts`**

```typescript
import { readFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import type { StackInfo } from './types.js';

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export async function detectStack(dir: string): Promise<StackInfo> {
  if (await exists(join(dir, 'package.json'))) {
    const raw = await readFile(join(dir, 'package.json'), 'utf8');
    const pkg = JSON.parse(raw) as { scripts?: Record<string, string> };
    const scripts = pkg.scripts ?? {};
    return {
      kind: 'node',
      install: 'npm ci',
      build: scripts['build'] ? 'npm run build' : null,
      test: scripts['test'] ? 'npm test' : null,
    };
  }

  if (await exists(join(dir, 'pom.xml'))) {
    return {
      kind: 'java-maven',
      install: null,
      build: './mvnw -B compile',
      test: './mvnw -B test',
    };
  }

  if (
    (await exists(join(dir, 'pyproject.toml'))) ||
    (await exists(join(dir, 'requirements.txt')))
  ) {
    return {
      kind: 'python',
      install: (await exists(join(dir, 'requirements.txt')))
        ? 'pip install -r requirements.txt'
        : 'pip install -e .',
      build: null,
      test: 'pytest',
    };
  }

  return { kind: 'unknown', install: null, build: null, test: null };
}
```

- [ ] **Step 4: Correr el test para verificar que pasa**

Run: `npx vitest run tests/stack.test.ts`
Expected: PASS — 5 tests.

- [ ] **Step 5: Commit**

```bash
git add src/stack.ts tests/stack.test.ts
git commit -m "feat: detect project stack and its build/test commands"
```

---

### Task 3: Ejecución de comandos

**Files:**
- Create: `src/runner.ts`
- Test: `tests/runner.test.ts`

**Interfaces:**
- Consumes: `StackInfo`, `CommandResult`, `RunnerResult` de `src/types.ts`.
- Produces: `runCommand(cmd, cwd, timeoutMs?): Promise<CommandResult>` y `runStack(stack, cwd): Promise<RunnerResult>`.

`runStack` corta en el primer fallo: si `install` falla no corre `build`; si `build` falla no corre `test`.

- [ ] **Step 1: Escribir el test que falla**

`tests/runner.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { runCommand, runStack, MAX_OUTPUT_CHARS } from '../src/runner.js';

describe('runCommand', () => {
  it('captura stdout de un comando exitoso', async () => {
    const result = await runCommand('node -e "console.log(\'hola\')"', process.cwd());
    expect(result.ok).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('hola');
  });

  it('marca ok=false y captura stderr de un comando fallido', async () => {
    const result = await runCommand('node -e "console.error(\'boom\');process.exit(3)"', process.cwd());
    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(3);
    expect(result.output).toContain('boom');
  });

  it('trunca salidas muy largas conservando el final', async () => {
    const script = `node -e "console.log('x'.repeat(${MAX_OUTPUT_CHARS + 5000}));console.log('THE_END')"`;
    const result = await runCommand(script, process.cwd());
    expect(result.output.length).toBeLessThanOrEqual(MAX_OUTPUT_CHARS + 200);
    expect(result.output).toContain('THE_END');
    expect(result.output).toContain('[truncado]');
  });

  it('falla por timeout sin colgarse', async () => {
    const result = await runCommand('node -e "setTimeout(()=>{},5000)"', process.cwd(), 300);
    expect(result.ok).toBe(false);
  });
});

describe('runStack', () => {
  it('no corre build ni test si install falla', async () => {
    const result = await runStack(
      { kind: 'node', install: 'node -e "process.exit(1)"', build: 'node -e "0"', test: 'node -e "0"' },
      process.cwd(),
    );
    expect(result.install?.ok).toBe(false);
    expect(result.build).toBeNull();
    expect(result.test).toBeNull();
  });

  it('no corre test si build falla', async () => {
    const result = await runStack(
      { kind: 'node', install: null, build: 'node -e "process.exit(1)"', test: 'node -e "0"' },
      process.cwd(),
    );
    expect(result.build?.ok).toBe(false);
    expect(result.test).toBeNull();
  });

  it('corre los tres pasos cuando todos pasan', async () => {
    const result = await runStack(
      { kind: 'node', install: 'node -e "0"', build: 'node -e "0"', test: 'node -e "0"' },
      process.cwd(),
    );
    expect(result.install?.ok).toBe(true);
    expect(result.build?.ok).toBe(true);
    expect(result.test?.ok).toBe(true);
  });
});
```

- [ ] **Step 2: Correr el test para verificar que falla**

Run: `npx vitest run tests/runner.test.ts`
Expected: FAIL — `Cannot find module '../src/runner.js'`

- [ ] **Step 3: Escribir `src/runner.ts`**

```typescript
import { spawn } from 'node:child_process';
import type { CommandResult, RunnerResult, StackInfo } from './types.js';

export const MAX_OUTPUT_CHARS = 30_000;
export const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;

function truncate(text: string): string {
  if (text.length <= MAX_OUTPUT_CHARS) return text;
  const keep = MAX_OUTPUT_CHARS - 100;
  return `[truncado: se omitieron ${text.length - keep} caracteres del principio]\n` + text.slice(-keep);
}

export function runCommand(
  cmd: string,
  cwd: string,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<CommandResult> {
  return new Promise((resolve) => {
    const child = spawn(cmd, { cwd, shell: true });
    const chunks: string[] = [];
    let settled = false;

    const finish = (exitCode: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: exitCode === 0, exitCode, output: truncate(chunks.join('')) });
    };

    const timer = setTimeout(() => {
      chunks.push(`\n[el comando excedió el timeout de ${timeoutMs}ms y fue interrumpido]\n`);
      child.kill('SIGKILL');
      finish(124);
    }, timeoutMs);

    child.stdout.on('data', (d: Buffer) => chunks.push(d.toString()));
    child.stderr.on('data', (d: Buffer) => chunks.push(d.toString()));
    child.on('error', (err) => {
      chunks.push(`\n[no se pudo ejecutar el comando: ${err.message}]\n`);
      finish(127);
    });
    child.on('close', (code) => finish(code ?? 1));
  });
}

export async function runStack(stack: StackInfo, cwd: string): Promise<RunnerResult> {
  const result: RunnerResult = { install: null, build: null, test: null };

  if (stack.install) {
    result.install = await runCommand(stack.install, cwd);
    if (!result.install.ok) return result;
  }

  if (stack.build) {
    result.build = await runCommand(stack.build, cwd);
    if (!result.build.ok) return result;
  }

  if (stack.test) {
    result.test = await runCommand(stack.test, cwd);
  }

  return result;
}
```

- [ ] **Step 4: Correr el test para verificar que pasa**

Run: `npx vitest run tests/runner.test.ts`
Expected: PASS — 7 tests.

- [ ] **Step 5: Commit**

```bash
git add src/runner.ts tests/runner.test.ts
git commit -m "feat: run stack commands with truncation and timeout"
```

---

### Task 4: Política y motor de decisión

**Files:**
- Create: `policies/default.yaml`
- Create: `src/policy.ts`
- Test: `tests/policy.test.ts`

**Interfaces:**
- Consumes: `Policy`, `Decision`, `Finding`, `RunnerResult`, `Severity` de `src/types.ts`.
- Produces: `loadPolicy(repoDir: string): Promise<Policy>` y `decide(policy, runner, findings): Decision`.

Reglas de `decide`, en orden:

1. Si `build` está en `required` y falló → `FAIL`.
2. Si `tests` está en `required` y falló → `FAIL`.
3. Un finding es bloqueante si su `severity` está en `blockOn` **y** su `confidence >= minConfidence`.
4. Si hay bloqueantes → `FAIL`. Si no → `PASS`.

`decide` nunca devuelve `ERROR`: ese estado lo produce `cli.ts` al capturar una excepción.

- [ ] **Step 1: Crear `policies/default.yaml`**

```yaml
model: claude-sonnet-5

required:
  - build
  - tests

block_on: [CRITICAL, HIGH]
comment_only: [MEDIUM, LOW, INFO]

min_confidence: 0.7

on_test_failure:
  run_auditors: [scope, acceptance]

auditors:
  acceptance:
    when: criteria_available
  scope:
    when: always
    effort: low
  backend:
    when: [backend_changed]
  database:
    when: [database_changed]
  security:
    when: [auth_changed, deps_changed, endpoints_changed]
  infrastructure:
    when: [infra_changed]
```

- [ ] **Step 2: Escribir el test que falla**

`tests/policy.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { decide, loadPolicy } from '../src/policy.js';
import type { Finding, Policy, RunnerResult } from '../src/types.js';

const policy: Policy = {
  model: 'claude-sonnet-5',
  required: ['build', 'tests'],
  blockOn: ['CRITICAL', 'HIGH'],
  minConfidence: 0.7,
  onTestFailure: { runAuditors: ['scope', 'acceptance'] },
  auditors: {},
};

const green: RunnerResult = {
  install: { ok: true, exitCode: 0, output: '' },
  build: { ok: true, exitCode: 0, output: '' },
  test: { ok: true, exitCode: 0, output: '' },
};

function finding(severity: Finding['severity'], confidence: number): Finding {
  return {
    severity,
    confidence,
    title: 't',
    file: 'src/a.ts',
    line: 1,
    message: 'm',
    evidence: null,
    suggestedFix: null,
  };
}

describe('decide', () => {
  it('devuelve PASS sin findings y con todo verde', () => {
    const d = decide(policy, green, []);
    expect(d.verdict).toBe('PASS');
    expect(d.blocking).toHaveLength(0);
  });

  it('devuelve FAIL cuando el build falló', () => {
    const d = decide(policy, { ...green, build: { ok: false, exitCode: 1, output: '' }, test: null }, []);
    expect(d.verdict).toBe('FAIL');
    expect(d.reason).toContain('build');
  });

  it('devuelve FAIL cuando los tests fallaron', () => {
    const d = decide(policy, { ...green, test: { ok: false, exitCode: 1, output: '' } }, []);
    expect(d.verdict).toBe('FAIL');
    expect(d.reason).toContain('tests');
  });

  it('bloquea con un HIGH de alta confianza', () => {
    const d = decide(policy, green, [finding('HIGH', 0.9)]);
    expect(d.verdict).toBe('FAIL');
    expect(d.blocking).toHaveLength(1);
  });

  it('no bloquea con un HIGH de baja confianza, pero lo informa', () => {
    const d = decide(policy, green, [finding('HIGH', 0.5)]);
    expect(d.verdict).toBe('PASS');
    expect(d.blocking).toHaveLength(0);
    expect(d.informational).toHaveLength(1);
  });

  it('no bloquea con un MEDIUM aunque tenga confianza alta', () => {
    const d = decide(policy, green, [finding('MEDIUM', 0.99)]);
    expect(d.verdict).toBe('PASS');
    expect(d.informational).toHaveLength(1);
  });

  it('bloquea exactamente en el umbral de confianza', () => {
    const d = decide(policy, green, [finding('CRITICAL', 0.7)]);
    expect(d.verdict).toBe('FAIL');
  });
});

describe('loadPolicy', () => {
  it('carga la política por defecto cuando el repo no tiene .ai/policy.yaml', async () => {
    const p = await loadPolicy(process.cwd());
    expect(p.model).toBe('claude-sonnet-5');
    expect(p.minConfidence).toBe(0.7);
    expect(p.blockOn).toEqual(['CRITICAL', 'HIGH']);
    expect(p.auditors['scope']?.when).toBe('always');
  });
});
```

- [ ] **Step 3: Correr el test para verificar que falla**

Run: `npx vitest run tests/policy.test.ts`
Expected: FAIL — `Cannot find module '../src/policy.js'`

- [ ] **Step 4: Escribir `src/policy.ts`**

```typescript
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
```

- [ ] **Step 5: Correr el test para verificar que pasa**

Run: `npx vitest run tests/policy.test.ts`
Expected: PASS — 8 tests.

- [ ] **Step 6: Commit**

```bash
git add policies/default.yaml src/policy.ts tests/policy.test.ts
git commit -m "feat: load policy and decide verdict deterministically"
```

---

### Task 5: Resolución de triggers y selección de auditores

**Files:**
- Create: `src/analyzer.ts`
- Test: `tests/analyzer.test.ts`

**Interfaces:**
- Consumes: `ChangedFile`, `Policy`, `Trigger` de `src/types.ts`.
- Produces: `resolveTriggers(files: ChangedFile[]): Set<Trigger>` y `selectAuditors(policy, files, opts): string[]`, con `opts: { criteriaAvailable: boolean; testsFailed: boolean }`.

Cuando `testsFailed` es `true`, `selectAuditors` devuelve **sólo** la intersección entre `policy.onTestFailure.runAuditors` y los auditores que hubieran corrido igual.

- [ ] **Step 1: Escribir el test que falla**

`tests/analyzer.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { resolveTriggers, selectAuditors } from '../src/analyzer.js';
import type { ChangedFile, Policy } from '../src/types.js';

function file(path: string): ChangedFile {
  return { path, status: 'modified', additions: 1, deletions: 0, patch: '@@ -1 +1 @@' };
}

const policy: Policy = {
  model: 'claude-sonnet-5',
  required: ['build', 'tests'],
  blockOn: ['CRITICAL', 'HIGH'],
  minConfidence: 0.7,
  onTestFailure: { runAuditors: ['scope', 'acceptance'] },
  auditors: {
    acceptance: { when: 'criteria_available' },
    scope: { when: 'always' },
    backend: { when: ['backend_changed'] },
    database: { when: ['database_changed'] },
    security: { when: ['auth_changed', 'deps_changed', 'endpoints_changed'] },
    infrastructure: { when: ['infra_changed'] },
  },
};

describe('resolveTriggers', () => {
  it('marca backend_changed para código de servidor', () => {
    expect(resolveTriggers([file('src/services/ReclamoService.java')])).toContain('backend_changed');
  });

  it('marca database_changed para migraciones', () => {
    expect(resolveTriggers([file('migrations/V42__payments.sql')])).toContain('database_changed');
  });

  it('marca infra_changed para Dockerfile y workflows', () => {
    expect(resolveTriggers([file('Dockerfile')])).toContain('infra_changed');
    expect(resolveTriggers([file('.github/workflows/ci.yml')])).toContain('infra_changed');
  });

  it('marca deps_changed para lockfiles y manifiestos', () => {
    expect(resolveTriggers([file('package-lock.json')])).toContain('deps_changed');
    expect(resolveTriggers([file('pom.xml')])).toContain('deps_changed');
  });

  it('marca auth_changed para archivos de autenticación', () => {
    expect(resolveTriggers([file('src/auth/login.ts')])).toContain('auth_changed');
  });

  it('marca endpoints_changed para controllers y rutas', () => {
    expect(resolveTriggers([file('src/routes/users.ts')])).toContain('endpoints_changed');
    expect(resolveTriggers([file('src/api/PaymentController.java')])).toContain('endpoints_changed');
  });

  it('no marca nada para un README', () => {
    expect(resolveTriggers([file('README.md')]).size).toBe(0);
  });
});

describe('selectAuditors', () => {
  it('incluye scope siempre y acceptance sólo con criterios', () => {
    const withCriteria = selectAuditors(policy, [file('README.md')], {
      criteriaAvailable: true,
      testsFailed: false,
    });
    expect(withCriteria).toContain('scope');
    expect(withCriteria).toContain('acceptance');

    const without = selectAuditors(policy, [file('README.md')], {
      criteriaAvailable: false,
      testsFailed: false,
    });
    expect(without).toContain('scope');
    expect(without).not.toContain('acceptance');
  });

  it('activa backend y endpoints ante un controller', () => {
    const selected = selectAuditors(policy, [file('src/api/PaymentController.java')], {
      criteriaAvailable: true,
      testsFailed: false,
    });
    expect(selected).toContain('backend');
    expect(selected).toContain('security');
  });

  it('con tests fallando devuelve sólo los auditores del corte parcial', () => {
    const selected = selectAuditors(policy, [file('src/api/PaymentController.java')], {
      criteriaAvailable: true,
      testsFailed: true,
    });
    expect(selected.sort()).toEqual(['acceptance', 'scope']);
  });

  it('con tests fallando y sin criterios no incluye acceptance', () => {
    const selected = selectAuditors(policy, [file('src/api/PaymentController.java')], {
      criteriaAvailable: false,
      testsFailed: true,
    });
    expect(selected).toEqual(['scope']);
  });
});
```

- [ ] **Step 2: Correr el test para verificar que falla**

Run: `npx vitest run tests/analyzer.test.ts`
Expected: FAIL — `Cannot find module '../src/analyzer.js'`

- [ ] **Step 3: Escribir `src/analyzer.ts`**

```typescript
import type { ChangedFile, Policy, Trigger } from './types.js';

const PATTERNS: Array<{ trigger: Trigger; test: RegExp }> = [
  { trigger: 'backend_changed', test: /(^|\/)(src|app|lib)\/.*\.(ts|js|java|py|go|rb|cs)$/i },
  { trigger: 'backend_changed', test: /(service|repository|usecase|handler)s?\//i },
  { trigger: 'database_changed', test: /(^|\/)(migrations?|db|database)\//i },
  { trigger: 'database_changed', test: /\.sql$/i },
  { trigger: 'database_changed', test: /(entity|entities|model|schema)s?\//i },
  { trigger: 'infra_changed', test: /(^|\/)Dockerfile/i },
  { trigger: 'infra_changed', test: /docker-compose\.ya?ml$/i },
  { trigger: 'infra_changed', test: /^\.github\/workflows\// },
  { trigger: 'infra_changed', test: /\.(tf|tfvars)$/i },
  { trigger: 'infra_changed', test: /(^|\/)k8s\//i },
  { trigger: 'auth_changed', test: /(auth|login|session|permission|role|token|jwt)/i },
  { trigger: 'deps_changed', test: /(package(-lock)?\.json|yarn\.lock|pnpm-lock\.yaml|pom\.xml|build\.gradle|requirements\.txt|pyproject\.toml|go\.(mod|sum)|Cargo\.(toml|lock))$/ },
  { trigger: 'endpoints_changed', test: /(controller|route|endpoint|resource)s?/i },
  { trigger: 'endpoints_changed', test: /openapi|swagger/i },
];

export function resolveTriggers(files: ChangedFile[]): Set<Trigger> {
  const triggers = new Set<Trigger>();
  for (const f of files) {
    for (const { trigger, test } of PATTERNS) {
      if (test.test(f.path)) triggers.add(trigger);
    }
  }
  return triggers;
}

export interface SelectOptions {
  criteriaAvailable: boolean;
  testsFailed: boolean;
}

export function selectAuditors(
  policy: Policy,
  files: ChangedFile[],
  opts: SelectOptions,
): string[] {
  const triggers = resolveTriggers(files);

  const applicable = Object.entries(policy.auditors)
    .filter(([, cfg]) => {
      if (cfg.when === 'always') return true;
      if (cfg.when === 'criteria_available') return opts.criteriaAvailable;
      return cfg.when.some((t) => triggers.has(t));
    })
    .map(([name]) => name);

  if (!opts.testsFailed) return applicable;

  const allowed = new Set(policy.onTestFailure.runAuditors);
  return applicable.filter((name) => allowed.has(name));
}
```

- [ ] **Step 4: Correr el test para verificar que pasa**

Run: `npx vitest run tests/analyzer.test.ts`
Expected: PASS — 11 tests.

- [ ] **Step 5: Verificar tipos**

Run: `npm run typecheck`
Expected: sin errores.

- [ ] **Step 6: Commit**

```bash
git add src/analyzer.ts tests/analyzer.test.ts
git commit -m "feat: resolve change triggers and select applicable auditors"
```

---

### Task 6: Contexto de la PR desde GitHub

**Files:**
- Create: `src/context.ts`
- Test: `tests/context.test.ts`

**Interfaces:**
- Consumes: `AuditContext`, `ChangedFile`, `RunnerResult` de `src/types.ts`.
- Produces: `extractIssueNumber(body: string | null): number | null`, `buildContext(deps): Promise<AuditContext>`.

`buildContext` recibe sus dependencias por parámetro para poder testearse sin red:

```typescript
interface ContextDeps {
  octokit: OctokitLike;
  owner: string;
  repo: string;
  prNumber: number;
  commitSha: string;
  runner: RunnerResult;
}
```

- [ ] **Step 1: Escribir el test que falla**

`tests/context.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { extractIssueNumber, buildContext, type OctokitLike } from '../src/context.js';
import type { RunnerResult } from '../src/types.js';

const runner: RunnerResult = {
  install: null,
  build: { ok: true, exitCode: 0, output: '' },
  test: { ok: true, exitCode: 0, output: '' },
};

describe('extractIssueNumber', () => {
  it('reconoce Closes #42', () => {
    expect(extractIssueNumber('Closes #42')).toBe(42);
  });

  it('reconoce fixes y resolves sin distinguir mayúsculas', () => {
    expect(extractIssueNumber('this FIXES #7 finally')).toBe(7);
    expect(extractIssueNumber('resolves #123')).toBe(123);
  });

  it('devuelve null si no hay palabra clave de cierre', () => {
    expect(extractIssueNumber('ver #42 para contexto')).toBeNull();
  });

  it('devuelve null con body vacío', () => {
    expect(extractIssueNumber(null)).toBeNull();
  });
});

function fakeOctokit(prBody: string | null, issueBody?: string): OctokitLike {
  return {
    pulls: {
      get: async () => ({ data: { body: prBody } }),
      listFiles: async () => ({
        data: [
          { filename: 'src/a.ts', status: 'modified', additions: 3, deletions: 1, patch: '@@ x @@' },
          { filename: 'README.md', status: 'added', additions: 1, deletions: 0, patch: undefined },
        ],
      }),
    },
    issues: {
      get: async () => ({ data: { body: issueBody ?? '' } }),
    },
  };
}

describe('buildContext', () => {
  const base = { owner: 'o', repo: 'r', prNumber: 1, commitSha: 'abc123', runner };

  it('mapea los archivos cambiados', async () => {
    const ctx = await buildContext({ ...base, octokit: fakeOctokit('sin issue') });
    expect(ctx.changedFiles).toHaveLength(2);
    expect(ctx.changedFiles[0]?.path).toBe('src/a.ts');
    expect(ctx.changedFiles[1]?.patch).toBeNull();
  });

  it('toma los criterios del issue vinculado', async () => {
    const ctx = await buildContext({
      ...base,
      octokit: fakeOctokit('Closes #42', 'Criterios:\n- crear reclamo'),
    });
    expect(ctx.criteriaSource).toBe('issue');
    expect(ctx.criteria).toContain('crear reclamo');
  });

  it('cae al cuerpo de la PR si no hay issue vinculado', async () => {
    const ctx = await buildContext({ ...base, octokit: fakeOctokit('Agrega validación de DNI') });
    expect(ctx.criteriaSource).toBe('pull_request');
    expect(ctx.criteria).toBe('Agrega validación de DNI');
  });

  it('deja criteria en null si no hay issue ni cuerpo', async () => {
    const ctx = await buildContext({ ...base, octokit: fakeOctokit(null) });
    expect(ctx.criteriaSource).toBeNull();
    expect(ctx.criteria).toBeNull();
  });
});
```

- [ ] **Step 2: Correr el test para verificar que falla**

Run: `npx vitest run tests/context.test.ts`
Expected: FAIL — `Cannot find module '../src/context.js'`

- [ ] **Step 3: Escribir `src/context.ts`**

```typescript
import type { AuditContext, ChangedFile, FileStatus, RunnerResult } from './types.js';

export interface OctokitLike {
  pulls: {
    get(args: { owner: string; repo: string; pull_number: number }): Promise<{
      data: { body?: string | null };
    }>;
    listFiles(args: { owner: string; repo: string; pull_number: number; per_page?: number }): Promise<{
      data: Array<{
        filename: string;
        status: string;
        additions: number;
        deletions: number;
        patch?: string | undefined;
      }>;
    }>;
  };
  issues: {
    get(args: { owner: string; repo: string; issue_number: number }): Promise<{
      data: { body?: string | null };
    }>;
  };
}

const CLOSING_KEYWORD = /\b(clos(e|es|ed)|fix(es|ed)?|resolv(e|es|ed))\s+#(\d+)\b/i;

export function extractIssueNumber(body: string | null): number | null {
  if (!body) return null;
  const match = CLOSING_KEYWORD.exec(body);
  if (!match?.[5]) return null;
  return Number.parseInt(match[5], 10);
}

function normalizeStatus(status: string): FileStatus {
  if (status === 'added' || status === 'removed' || status === 'renamed') return status;
  return 'modified';
}

export interface ContextDeps {
  octokit: OctokitLike;
  owner: string;
  repo: string;
  prNumber: number;
  commitSha: string;
  runner: RunnerResult;
}

export async function buildContext(deps: ContextDeps): Promise<AuditContext> {
  const { octokit, owner, repo, prNumber, commitSha, runner } = deps;

  const pr = await octokit.pulls.get({ owner, repo, pull_number: prNumber });
  const prBody = pr.data.body ?? null;

  const filesResponse = await octokit.pulls.listFiles({
    owner,
    repo,
    pull_number: prNumber,
    per_page: 300,
  });

  const changedFiles: ChangedFile[] = filesResponse.data.map((f) => ({
    path: f.filename,
    status: normalizeStatus(f.status),
    additions: f.additions,
    deletions: f.deletions,
    patch: f.patch ?? null,
  }));

  let criteria: string | null = null;
  let criteriaSource: AuditContext['criteriaSource'] = null;

  const issueNumber = extractIssueNumber(prBody);
  if (issueNumber !== null) {
    const issue = await octokit.issues.get({ owner, repo, issue_number: issueNumber });
    const issueBody = issue.data.body?.trim();
    if (issueBody) {
      criteria = issueBody;
      criteriaSource = 'issue';
    }
  }

  if (criteria === null && prBody?.trim()) {
    criteria = prBody.trim();
    criteriaSource = 'pull_request';
  }

  return { owner, repo, prNumber, commitSha, changedFiles, criteria, criteriaSource, runner };
}
```

- [ ] **Step 4: Correr el test para verificar que pasa**

Run: `npx vitest run tests/context.test.ts`
Expected: PASS — 8 tests.

- [ ] **Step 5: Commit**

```bash
git add src/context.ts tests/context.test.ts
git commit -m "feat: build audit context from PR diff and linked issue"
```

---

### Task 7: Ejecución de un auditor

**Files:**
- Create: `src/auditor.ts`
- Test: `tests/auditor.test.ts`

**Interfaces:**
- Consumes: `AuditContext`, `AuditorResult`, `AuditorResultSchema`, `Policy` de `src/types.ts`.
- Produces: `renderSharedContext(ctx): string`, `runAuditor(deps): Promise<AuditorResult>` con `deps: { client: AnthropicLike; name: string; prompt: string; sharedContext: string; policy: Policy }`.

El `system` lleva **dos** bloques en este orden: el contexto compartido con `cache_control` (idéntico para todos los auditores de la misma PR, lo que permite el caché), y después el prompt propio del auditor.

- [ ] **Step 1: Escribir el test que falla**

`tests/auditor.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { renderSharedContext, runAuditor, type AnthropicLike } from '../src/auditor.js';
import type { AuditContext, Policy } from '../src/types.js';

const ctx: AuditContext = {
  owner: 'o',
  repo: 'r',
  prNumber: 7,
  commitSha: 'abc1234',
  changedFiles: [
    { path: 'src/a.ts', status: 'modified', additions: 3, deletions: 1, patch: '@@ -1 +1 @@\n-old\n+new' },
  ],
  criteria: 'Debe validar el DNI',
  criteriaSource: 'issue',
  runner: {
    install: null,
    build: { ok: true, exitCode: 0, output: 'built' },
    test: { ok: false, exitCode: 1, output: 'shouldRejectNullDni FAILED' },
  },
};

const policy: Policy = {
  model: 'claude-sonnet-5',
  required: ['build', 'tests'],
  blockOn: ['CRITICAL', 'HIGH'],
  minConfidence: 0.7,
  onTestFailure: { runAuditors: [] },
  auditors: { scope: { when: 'always', effort: 'low' } },
};

describe('renderSharedContext', () => {
  it('incluye criterios, archivos y salida de tests', () => {
    const text = renderSharedContext(ctx);
    expect(text).toContain('Debe validar el DNI');
    expect(text).toContain('src/a.ts');
    expect(text).toContain('shouldRejectNullDni FAILED');
  });

  it('dice explícitamente cuando no hay criterios', () => {
    const text = renderSharedContext({ ...ctx, criteria: null, criteriaSource: null });
    expect(text).toContain('sin criterios declarados');
  });
});

describe('runAuditor', () => {
  it('devuelve el resultado parseado y marca el bloque compartido como cacheable', async () => {
    const parse = vi.fn().mockResolvedValue({
      parsed_output: { auditor: 'scope', status: 'PASS', findings: [] },
    });
    const client = { messages: { parse } } as unknown as AnthropicLike;

    const result = await runAuditor({
      client,
      name: 'scope',
      prompt: 'You are the scope auditor.',
      sharedContext: renderSharedContext(ctx),
      policy,
    });

    expect(result.auditor).toBe('scope');
    expect(result.status).toBe('PASS');

    const args = parse.mock.calls[0]?.[0];
    expect(args.model).toBe('claude-sonnet-5');
    expect(args.output_config.effort).toBe('low');
    expect(args.system[0].cache_control).toEqual({ type: 'ephemeral' });
    expect(args.system[1].text).toContain('scope auditor');
  });

  it('usa el modelo específico del auditor cuando la política lo define', async () => {
    const parse = vi.fn().mockResolvedValue({
      parsed_output: { auditor: 'scope', status: 'PASS', findings: [] },
    });
    const client = { messages: { parse } } as unknown as AnthropicLike;

    await runAuditor({
      client,
      name: 'scope',
      prompt: 'p',
      sharedContext: 'c',
      policy: { ...policy, auditors: { scope: { when: 'always', model: 'claude-opus-5' } } },
    });

    expect(parse.mock.calls[0]?.[0].model).toBe('claude-opus-5');
  });

  it('lanza si la respuesta no valida contra el esquema', async () => {
    const parse = vi.fn().mockResolvedValue({ parsed_output: null });
    const client = { messages: { parse } } as unknown as AnthropicLike;

    await expect(
      runAuditor({ client, name: 'scope', prompt: 'p', sharedContext: 'c', policy }),
    ).rejects.toThrow(/scope/);
  });

  it('fuerza el nombre del auditor aunque el modelo devuelva otro', async () => {
    const parse = vi.fn().mockResolvedValue({
      parsed_output: { auditor: 'inventado', status: 'FAIL', findings: [] },
    });
    const client = { messages: { parse } } as unknown as AnthropicLike;

    const result = await runAuditor({
      client,
      name: 'security',
      prompt: 'p',
      sharedContext: 'c',
      policy: { ...policy, auditors: { security: { when: 'always' } } },
    });

    expect(result.auditor).toBe('security');
  });
});
```

- [ ] **Step 2: Correr el test para verificar que falla**

Run: `npx vitest run tests/auditor.test.ts`
Expected: FAIL — `Cannot find module '../src/auditor.js'`

- [ ] **Step 3: Escribir `src/auditor.ts`**

```typescript
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
```

- [ ] **Step 4: Correr el test para verificar que pasa**

Run: `npx vitest run tests/auditor.test.ts`
Expected: PASS — 6 tests.

- [ ] **Step 5: Commit**

```bash
git add src/auditor.ts tests/auditor.test.ts
git commit -m "feat: run one auditor with schema-forced JSON output and prompt caching"
```

---

### Task 8: Orquestación de auditores (caché-primero)

**Files:**
- Create: `src/orchestrator.ts`
- Test: `tests/orchestrator.test.ts`

**Interfaces:**
- Consumes: `runAuditor`, `AnthropicLike` de `src/auditor.ts`; `AuditorResult`, `Policy` de `src/types.ts`.
- Produces: `runAuditors(deps): Promise<{ results: AuditorResult[]; errors: string[] }>` con `deps: { client; names: string[]; prompts: Record<string,string>; sharedContext: string; policy: Policy }`.

Secuencia obligatoria: se ejecuta **el primer auditor solo**, se espera a que termine, y recién entonces se lanzan los demás en paralelo. Sin eso, las llamadas concurrentes escriben el mismo caché en vez de leerlo. Un auditor que falla no tumba el conjunto: su error se acumula en `errors`.

- [ ] **Step 1: Escribir el test que falla**

`tests/orchestrator.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { runAuditors } from '../src/orchestrator.js';
import type { AnthropicLike } from '../src/auditor.js';
import type { Policy } from '../src/types.js';

const policy: Policy = {
  model: 'claude-sonnet-5',
  required: ['build', 'tests'],
  blockOn: ['CRITICAL', 'HIGH'],
  minConfidence: 0.7,
  onTestFailure: { runAuditors: [] },
  auditors: { scope: { when: 'always' }, backend: { when: 'always' }, security: { when: 'always' } },
};

const prompts = { scope: 'p-scope', backend: 'p-backend', security: 'p-security' };

function clientReturning(status: 'PASS' | 'FAIL' = 'PASS'): { client: AnthropicLike; order: string[] } {
  const order: string[] = [];
  const client = {
    messages: {
      parse: vi.fn(async (args: Record<string, unknown>) => {
        const msgs = args['messages'] as Array<{ content: string }>;
        const name = /"([a-z]+)"/.exec(msgs[0]!.content)?.[1] ?? 'unknown';
        order.push(name);
        await new Promise((r) => setTimeout(r, 5));
        return { parsed_output: { auditor: name, status, findings: [] } };
      }),
    },
  } as unknown as AnthropicLike;
  return { client, order };
}

describe('runAuditors', () => {
  it('devuelve un resultado por auditor', async () => {
    const { client } = clientReturning();
    const { results, errors } = await runAuditors({
      client,
      names: ['scope', 'backend', 'security'],
      prompts,
      sharedContext: 'ctx',
      policy,
    });
    expect(results).toHaveLength(3);
    expect(errors).toHaveLength(0);
    expect(results.map((r) => r.auditor).sort()).toEqual(['backend', 'scope', 'security']);
  });

  it('ejecuta el primero en serie antes de lanzar el resto', async () => {
    const started: string[] = [];
    let firstDone = false;
    const client = {
      messages: {
        parse: vi.fn(async (args: Record<string, unknown>) => {
          const msgs = args['messages'] as Array<{ content: string }>;
          const name = /"([a-z]+)"/.exec(msgs[0]!.content)?.[1] ?? 'unknown';
          started.push(name);
          if (name !== 'scope') {
            expect(firstDone).toBe(true);
          }
          await new Promise((r) => setTimeout(r, 10));
          if (name === 'scope') firstDone = true;
          return { parsed_output: { auditor: name, status: 'PASS', findings: [] } };
        }),
      },
    } as unknown as AnthropicLike;

    await runAuditors({ client, names: ['scope', 'backend', 'security'], prompts, sharedContext: 'c', policy });
    expect(started[0]).toBe('scope');
  });

  it('acumula el error de un auditor sin perder los demás resultados', async () => {
    const client = {
      messages: {
        parse: vi.fn(async (args: Record<string, unknown>) => {
          const msgs = args['messages'] as Array<{ content: string }>;
          const name = /"([a-z]+)"/.exec(msgs[0]!.content)?.[1] ?? 'unknown';
          if (name === 'backend') throw new Error('503 overloaded');
          return { parsed_output: { auditor: name, status: 'PASS', findings: [] } };
        }),
      },
    } as unknown as AnthropicLike;

    const { results, errors } = await runAuditors({
      client,
      names: ['scope', 'backend', 'security'],
      prompts,
      sharedContext: 'c',
      policy,
    });

    expect(results).toHaveLength(2);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('backend');
    expect(errors[0]).toContain('503');
  });

  it('devuelve vacío sin auditores', async () => {
    const { client } = clientReturning();
    const { results } = await runAuditors({ client, names: [], prompts, sharedContext: 'c', policy });
    expect(results).toHaveLength(0);
  });

  it('registra un error si falta el prompt de un auditor', async () => {
    const { client } = clientReturning();
    const { results, errors } = await runAuditors({
      client,
      names: ['scope', 'fantasma'],
      prompts,
      sharedContext: 'c',
      policy,
    });
    expect(results).toHaveLength(1);
    expect(errors[0]).toContain('fantasma');
  });
});
```

- [ ] **Step 2: Correr el test para verificar que falla**

Run: `npx vitest run tests/orchestrator.test.ts`
Expected: FAIL — `Cannot find module '../src/orchestrator.js'`

- [ ] **Step 3: Escribir `src/orchestrator.ts`**

```typescript
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
```

- [ ] **Step 4: Correr el test para verificar que pasa**

Run: `npx vitest run tests/orchestrator.test.ts`
Expected: PASS — 5 tests.

- [ ] **Step 5: Commit**

```bash
git add src/orchestrator.ts tests/orchestrator.test.ts
git commit -m "feat: orchestrate auditors with cache-priming serial first call"
```

---

### Task 9: Comentario y check run

**Files:**
- Create: `src/report.ts`
- Test: `tests/report.test.ts`

**Interfaces:**
- Consumes: `AuditContext`, `Decision`, `Verdict` de `src/types.ts`.
- Produces: `MARKER`, `renderComment(deps): string`, `upsertComment(octokit, ctx, body): Promise<void>`, `publishCheck(octokit, ctx, decision): Promise<void>`.

- [ ] **Step 1: Escribir el test que falla**

`tests/report.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { MARKER, renderComment, upsertComment, publishCheck, type ReportOctokit } from '../src/report.js';
import type { AuditContext, Decision, Finding } from '../src/types.js';

const ctx: AuditContext = {
  owner: 'o',
  repo: 'r',
  prNumber: 7,
  commitSha: 'abc1234',
  changedFiles: [],
  criteria: null,
  criteriaSource: null,
  runner: {
    install: null,
    build: { ok: true, exitCode: 0, output: '' },
    test: { ok: false, exitCode: 1, output: '127 passed, 2 failed' },
  },
};

const blocking: Finding = {
  severity: 'HIGH',
  confidence: 0.9,
  title: 'El endpoint puede devolver 500 con DNI nulo',
  file: 'src/ReclamoController.java',
  line: 84,
  message: 'No hay validación.',
  evidence: 'shouldRejectNullDni: expected 400, got 500',
  suggestedFix: 'Validar en el DTO.',
};

const decision: Decision = {
  verdict: 'FAIL',
  blocking: [blocking],
  informational: [],
  reason: 'Los tests fallaron.',
};

describe('renderComment', () => {
  it('empieza con el marcador oculto', () => {
    const body = renderComment({ ctx, decision, auditors: ['scope'], errors: [] });
    expect(body.startsWith(MARKER)).toBe(true);
  });

  it('incluye veredicto, commit, archivo y línea', () => {
    const body = renderComment({ ctx, decision, auditors: ['scope', 'backend'], errors: [] });
    expect(body).toContain('FAILED');
    expect(body).toContain('abc1234');
    expect(body).toContain('src/ReclamoController.java:84');
    expect(body).toContain('Validar en el DTO.');
  });

  it('muestra los auditores ejecutados', () => {
    const body = renderComment({ ctx, decision, auditors: ['scope', 'backend'], errors: [] });
    expect(body).toContain('scope');
    expect(body).toContain('backend');
  });

  it('avisa cuando no hubo criterios declarados', () => {
    const body = renderComment({ ctx, decision, auditors: [], errors: [] });
    expect(body).toContain('sin criterios declarados');
  });

  it('lista los errores de auditores como degradación, no como fallo', () => {
    const body = renderComment({
      ctx,
      decision,
      auditors: ['scope'],
      errors: ['El auditor "backend" falló: 503'],
    });
    expect(body).toContain('503');
    expect(body).toContain('no pudieron ejecutarse');
  });
});

describe('upsertComment', () => {
  it('crea el comentario si no existe uno con el marcador', async () => {
    const create = vi.fn().mockResolvedValue({});
    const update = vi.fn().mockResolvedValue({});
    const octokit = {
      issues: {
        listComments: vi.fn().mockResolvedValue({ data: [{ id: 1, body: 'otro comentario' }] }),
        createComment: create,
        updateComment: update,
      },
      checks: { create: vi.fn() },
    } as unknown as ReportOctokit;

    await upsertComment(octokit, ctx, 'cuerpo');
    expect(create).toHaveBeenCalledOnce();
    expect(update).not.toHaveBeenCalled();
  });

  it('edita el comentario existente en vez de crear otro', async () => {
    const create = vi.fn().mockResolvedValue({});
    const update = vi.fn().mockResolvedValue({});
    const octokit = {
      issues: {
        listComments: vi.fn().mockResolvedValue({ data: [{ id: 55, body: `${MARKER}\nviejo` }] }),
        createComment: create,
        updateComment: update,
      },
      checks: { create: vi.fn() },
    } as unknown as ReportOctokit;

    await upsertComment(octokit, ctx, 'nuevo');
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ comment_id: 55, body: 'nuevo' }));
    expect(create).not.toHaveBeenCalled();
  });
});

describe('publishCheck', () => {
  const octokitWith = (create: ReturnType<typeof vi.fn>) =>
    ({
      issues: { listComments: vi.fn(), createComment: vi.fn(), updateComment: vi.fn() },
      checks: { create },
    }) as unknown as ReportOctokit;

  it('mapea PASS a success', async () => {
    const create = vi.fn().mockResolvedValue({});
    await publishCheck(octokitWith(create), ctx, { ...decision, verdict: 'PASS' });
    expect(create.mock.calls[0]?.[0].conclusion).toBe('success');
  });

  it('mapea FAIL a failure', async () => {
    const create = vi.fn().mockResolvedValue({});
    await publishCheck(octokitWith(create), ctx, decision);
    expect(create.mock.calls[0]?.[0].conclusion).toBe('failure');
  });

  it('mapea ERROR a neutral para no bloquear el merge', async () => {
    const create = vi.fn().mockResolvedValue({});
    await publishCheck(octokitWith(create), ctx, { ...decision, verdict: 'ERROR' });
    expect(create.mock.calls[0]?.[0].conclusion).toBe('neutral');
  });

  it('adjunta una anotación por finding bloqueante', async () => {
    const create = vi.fn().mockResolvedValue({});
    await publishCheck(octokitWith(create), ctx, decision);
    const annotations = create.mock.calls[0]?.[0].output.annotations;
    expect(annotations).toHaveLength(1);
    expect(annotations[0].path).toBe('src/ReclamoController.java');
    expect(annotations[0].start_line).toBe(84);
  });
});
```

- [ ] **Step 2: Correr el test para verificar que falla**

Run: `npx vitest run tests/report.test.ts`
Expected: FAIL — `Cannot find module '../src/report.js'`

- [ ] **Step 3: Escribir `src/report.ts`**

```typescript
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

  if (decision.verdict === 'FAIL' && !ctx.runner.test?.ok && ctx.runner.test) {
    parts.push('', '```', ctx.runner.test.output, '```');
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
```

- [ ] **Step 4: Correr el test para verificar que pasa**

Run: `npx vitest run tests/report.test.ts`
Expected: PASS — 11 tests.

- [ ] **Step 5: Commit**

```bash
git add src/report.ts tests/report.test.ts
git commit -m "feat: render updatable PR comment and publish check run"
```

---

### Task 10: Contratos de los auditores

**Files:**
- Create: `agents/acceptance.md`, `agents/scope.md`, `agents/backend.md`, `agents/security.md`, `agents/database.md`, `agents/infrastructure.md`
- Create: `src/prompts.ts`
- Test: `tests/prompts.test.ts`

**Interfaces:**
- Consumes: nada.
- Produces: `loadPrompts(): Promise<Record<string, string>>` — lee `agents/*.md` y devuelve un mapa `nombre → contenido`.

Los seis prompts comparten estructura: ROLE, WHAT TO CHECK, WHAT YOU CANNOT APPROVE, CONFIDENCE. Escritos en inglés.

- [ ] **Step 1: Escribir `agents/acceptance.md`**

```markdown
# ROLE

You are the acceptance auditor. You judge one thing: does this change do what the
task asked for?

# WHAT TO CHECK

- Every acceptance criterion in the task: is it implemented, and does the code
  actually satisfy it — not merely mention it?
- Criteria that are silently unimplemented, partially implemented, or implemented
  with different behavior than described.
- Behavior that contradicts a stated criterion.

# WHAT YOU CANNOT APPROVE

- A criterion with no corresponding implementation.
- An implementation that does something materially different from what was asked.
- A change that satisfies the letter of a criterion while defeating its purpose.

# WHAT IS NOT YOUR JOB

Code style, architecture, performance, and security belong to other auditors.
Do not report them. If the code is ugly but does exactly what was asked, you PASS.

# CONFIDENCE

Set `confidence` above 0.7 only when the criteria are explicit enough that you
could point to the exact line that satisfies or violates them. When the criteria
are vague, report the finding with low confidence rather than guessing.
```

- [ ] **Step 2: Escribir `agents/scope.md`**

```markdown
# ROLE

You are the scope auditor. You judge one thing: does this change touch only what
it needed to touch?

# WHAT TO CHECK

- Files modified that have no connection to the stated task.
- Refactors, renames, or reformatting bundled into a change that did not ask for them.
- New abstractions, helpers, or configuration introduced without being required.
- Unrelated dependency additions or version bumps.
- Deleted code that the task did not call for removing.

# WHAT YOU CANNOT APPROVE

- A diff whose majority of changed files is unrelated to the task.
- Opportunistic cleanup mixed into a functional change, which makes review harder
  and rollback riskier.

# WHAT IS NOT YOUR JOB

Whether the in-scope code is correct. Another auditor handles that. A change can
be perfectly scoped and still be wrong; that is not your finding.

# CONFIDENCE

You are judging the diff, not the domain, so you can be decisive. Report a
`MEDIUM` finding when the extra work is defensible (e.g. a rename the change made
unavoidable) and `HIGH` when it is plainly unrelated.
```

- [ ] **Step 3: Escribir `agents/backend.md`**

```markdown
# ROLE

You are the backend auditor. You review server-side logic for defects that will
cause incorrect behavior in production.

# WHAT TO CHECK

- Input validation: missing, wrong, or applied after the value is already used.
- Error handling: swallowed exceptions, errors that surface as the wrong status
  code, failure paths that leave state half-written.
- Null and boundary handling on values that can legitimately be absent.
- Concurrency: shared mutable state, non-atomic read-modify-write, retries without
  idempotency.
- Responsibilities in the wrong layer: business rules in a controller, HTTP
  concerns in a repository.
- Contradictions between the code and the test evidence you were given.

# WHAT YOU CANNOT APPROVE

- Code that fails one of the tests included in the evidence, when the cause is in
  the code under review.
- An unhandled path that returns a server error for input a user can legitimately send.
- Validation that can be bypassed through another entry point in the same diff.

# WHAT IS NOT YOUR JOB

Authorization and injection belong to the security auditor. Migrations and query
plans belong to the database auditor. Naming and formatting belong to nobody —
do not report them.

# CONFIDENCE

Anchor every finding to a specific line. If you cannot name the input that triggers
the defect, your confidence is below 0.7 — say so rather than inflating it.
```

- [ ] **Step 4: Escribir `agents/security.md`**

```markdown
# ROLE

You are the security auditor. You look for ways this change lets someone do
something they should not be able to do.

# WHAT TO CHECK

- Authentication and authorization: endpoints without a check, checks that verify
  authentication but not ownership, roles compared incorrectly.
- Injection: SQL, command, template, or path traversal built from user input.
- Secrets: credentials, tokens, or keys committed in code, config, or fixtures.
- Information exposure: stack traces, internal identifiers, or other users' data in
  responses or logs.
- Dependencies: newly added packages, and version changes that pull in known-vulnerable code.
- Unsafe defaults: permissive CORS, disabled TLS verification, wildcard permissions.

# WHAT YOU CANNOT APPROVE

- A hardcoded secret, in any file, including tests and examples.
- An endpoint that reads or writes another user's data without an ownership check.
- User input reaching a query, command, or path without escaping or parameterization.

# WHAT IS NOT YOUR JOB

General code quality and performance. Report a security finding only when you can
describe how it is exploited.

# CONFIDENCE

State the attack in one sentence: who does what, and what they get. If you cannot,
the finding is speculative — report it below 0.7 confidence or not at all. False
alarms here are expensive: they train people to ignore this auditor.
```

- [ ] **Step 5: Escribir `agents/database.md`**

```markdown
# ROLE

You are the database auditor. You review schema changes and data access for
problems that are expensive to discover in production.

# WHAT TO CHECK

- Migrations: destructive operations (dropping columns or tables, narrowing types),
  and whether they are reversible.
- Migrations that lock a large table, or that will not apply cleanly against
  existing data.
- Missing indexes on columns used for filtering, joining, or ordering.
- N+1 access patterns: a query inside a loop over a result set.
- Transaction boundaries: multi-step writes that can leave inconsistent state if
  interrupted.
- Constraints and foreign keys that the change should have added and did not.

# WHAT YOU CANNOT APPROVE

- A destructive migration with no stated plan for existing data.
- A new foreign key or filter column with no supporting index.
- A write sequence that must be atomic and is not.

# WHAT IS NOT YOUR JOB

Application logic above the data layer. Report on the schema, the queries, and the
migrations.

# CONFIDENCE

You can be decisive about missing indexes and destructive migrations — they are
visible in the diff. Be less certain about N+1 patterns when you cannot see the
calling code; report those below 0.7.
```

- [ ] **Step 6: Escribir `agents/infrastructure.md`**

```markdown
# ROLE

You are the infrastructure auditor. You review Docker, CI, and deployment
configuration for problems that are invisible in normal code review.

# WHAT TO CHECK

- Secrets: credentials in Dockerfiles, compose files, workflow YAML, or committed
  environment files.
- Image hygiene: unpinned `latest` tags, running as root, unnecessary build context,
  secrets baked into layers.
- CI workflows: excessive permissions, untrusted input reaching a privileged step,
  actions pinned loosely.
- Health checks and readiness probes: missing, or checking something that does not
  indicate readiness.
- Networking: ports exposed wider than needed, services reachable that should not be.
- Resource limits missing where a runaway process would affect neighbors.

# WHAT YOU CANNOT APPROVE

- A secret in any committed infrastructure file.
- A CI workflow that grants write permissions it does not use, or that runs
  untrusted code with access to secrets.
- A container that runs as root when the workload does not require it.

# WHAT IS NOT YOUR JOB

Application code. Stay in configuration, build, and deployment files.

# CONFIDENCE

These files are small and explicit, so you can usually be certain. If a setting
looks wrong but might be intentional for this environment, report it at MEDIUM
with your reasoning rather than asserting a defect.
```

- [ ] **Step 7: Escribir el test que falla**

`tests/prompts.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { loadPrompts } from '../src/prompts.js';

describe('loadPrompts', () => {
  it('carga los seis auditores de v1', async () => {
    const prompts = await loadPrompts();
    expect(Object.keys(prompts).sort()).toEqual([
      'acceptance',
      'backend',
      'database',
      'infrastructure',
      'scope',
      'security',
    ]);
  });

  it('cada prompt define rol y lo que no puede aprobar', async () => {
    const prompts = await loadPrompts();
    for (const [name, text] of Object.entries(prompts)) {
      expect(text, `${name} debe declarar ROLE`).toContain('# ROLE');
      expect(text, `${name} debe declarar qué no puede aprobar`).toContain('WHAT YOU CANNOT APPROVE');
      expect(text, `${name} debe dar guía de confianza`).toContain('# CONFIDENCE');
    }
  });
});
```

- [ ] **Step 8: Correr el test para verificar que falla**

Run: `npx vitest run tests/prompts.test.ts`
Expected: FAIL — `Cannot find module '../src/prompts.js'`

- [ ] **Step 9: Escribir `src/prompts.ts`**

```typescript
import { readdir, readFile } from 'node:fs/promises';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

export async function loadPrompts(): Promise<Record<string, string>> {
  const dir = join(here, '..', 'agents');
  const files = (await readdir(dir)).filter((f) => f.endsWith('.md'));

  const entries = await Promise.all(
    files.map(async (f) => [basename(f, '.md'), await readFile(join(dir, f), 'utf8')] as const),
  );

  return Object.fromEntries(entries);
}
```

- [ ] **Step 10: Correr el test para verificar que pasa**

Run: `npx vitest run tests/prompts.test.ts`
Expected: PASS — 2 tests.

- [ ] **Step 11: Commit**

```bash
git add agents/ src/prompts.ts tests/prompts.test.ts
git commit -m "feat: add the six v1 auditor contracts and their loader"
```

---

### Task 11: CLI y encadenado completo

**Files:**
- Create: `src/cli.ts`
- Test: `tests/cli.test.ts`

**Interfaces:**
- Consumes: todo lo anterior.
- Produces: `runGate(deps): Promise<Decision>` — la función testeable — y un `main()` que lee el entorno de Actions y llama a `runGate`.

`runGate` nunca lanza: cualquier excepción se convierte en `Decision` con `verdict: 'ERROR'`, que publica un check neutral.

- [ ] **Step 1: Escribir el test que falla**

`tests/cli.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { runGate, type GateDeps } from '../src/cli.js';
import type { AnthropicLike } from '../src/auditor.js';
import type { Policy } from '../src/types.js';

const policy: Policy = {
  model: 'claude-sonnet-5',
  required: ['build', 'tests'],
  blockOn: ['CRITICAL', 'HIGH'],
  minConfidence: 0.7,
  onTestFailure: { runAuditors: ['scope', 'acceptance'] },
  auditors: {
    acceptance: { when: 'criteria_available' },
    scope: { when: 'always' },
    backend: { when: ['backend_changed'] },
  },
};

function deps(overrides: Partial<GateDeps> = {}): GateDeps {
  const anthropic = {
    messages: {
      parse: vi.fn(async (args: Record<string, unknown>) => {
        const msgs = args['messages'] as Array<{ content: string }>;
        const name = /"([a-z]+)"/.exec(msgs[0]!.content)?.[1] ?? 'x';
        return { parsed_output: { auditor: name, status: 'PASS', findings: [] } };
      }),
    },
  } as unknown as AnthropicLike;

  return {
    owner: 'o',
    repo: 'r',
    prNumber: 1,
    commitSha: 'sha123',
    workspace: process.cwd(),
    anthropic,
    octokit: {
      pulls: {
        get: async () => ({ data: { body: 'Closes #9' } }),
        listFiles: async () => ({
          data: [{ filename: 'src/app.ts', status: 'modified', additions: 1, deletions: 0, patch: '@@ @@' }],
        }),
      },
      issues: {
        get: async () => ({ data: { body: 'Criterio: validar' } }),
        listComments: vi.fn().mockResolvedValue({ data: [] }),
        createComment: vi.fn().mockResolvedValue({}),
        updateComment: vi.fn().mockResolvedValue({}),
      },
      checks: { create: vi.fn().mockResolvedValue({}) },
    } as unknown as GateDeps['octokit'],
    policy,
    prompts: { acceptance: 'p', scope: 'p', backend: 'p' },
    detect: async () => ({ kind: 'node', install: null, build: 'true', test: 'true' }),
    run: async () => ({
      install: null,
      build: { ok: true, exitCode: 0, output: '' },
      test: { ok: true, exitCode: 0, output: '' },
    }),
    ...overrides,
  };
}

describe('runGate', () => {
  it('devuelve PASS con todo verde y sin findings', async () => {
    const d = await runGate(deps());
    expect(d.verdict).toBe('PASS');
  });

  it('corta sin llamar a la IA cuando el build falla', async () => {
    const anthropic = { messages: { parse: vi.fn() } } as unknown as AnthropicLike;
    const d = await runGate(
      deps({
        anthropic,
        run: async () => ({
          install: null,
          build: { ok: false, exitCode: 1, output: 'compile error' },
          test: null,
        }),
      }),
    );
    expect(d.verdict).toBe('FAIL');
    expect(anthropic.messages.parse).not.toHaveBeenCalled();
  });

  it('con tests fallando corre sólo scope y acceptance', async () => {
    const parse = vi.fn(async (args: Record<string, unknown>) => {
      const msgs = args['messages'] as Array<{ content: string }>;
      const name = /"([a-z]+)"/.exec(msgs[0]!.content)?.[1] ?? 'x';
      return { parsed_output: { auditor: name, status: 'PASS', findings: [] } };
    });
    const anthropic = { messages: { parse } } as unknown as AnthropicLike;

    const d = await runGate(
      deps({
        anthropic,
        run: async () => ({
          install: null,
          build: { ok: true, exitCode: 0, output: '' },
          test: { ok: false, exitCode: 1, output: '2 failed' },
        }),
      }),
    );

    expect(d.verdict).toBe('FAIL');
    const called = parse.mock.calls.map((c) => {
      const msgs = (c[0] as Record<string, unknown>)['messages'] as Array<{ content: string }>;
      return /"([a-z]+)"/.exec(msgs[0]!.content)?.[1];
    });
    expect(called.sort()).toEqual(['acceptance', 'scope']);
  });

  it('devuelve ERROR sin lanzar cuando GitHub falla', async () => {
    const d = await runGate(
      deps({
        octokit: {
          pulls: {
            get: async () => {
              throw new Error('502 bad gateway');
            },
            listFiles: async () => ({ data: [] }),
          },
          issues: {
            get: async () => ({ data: { body: '' } }),
            listComments: vi.fn().mockResolvedValue({ data: [] }),
            createComment: vi.fn().mockResolvedValue({}),
            updateComment: vi.fn().mockResolvedValue({}),
          },
          checks: { create: vi.fn().mockResolvedValue({}) },
        } as unknown as GateDeps['octokit'],
      }),
    );
    expect(d.verdict).toBe('ERROR');
    expect(d.reason).toContain('502');
  });

  it('publica siempre comentario y check', async () => {
    const d = deps();
    await runGate(d);
    expect(d.octokit.issues.createComment).toHaveBeenCalledOnce();
    expect(d.octokit.checks.create).toHaveBeenCalledOnce();
  });
});
```

- [ ] **Step 2: Correr el test para verificar que falla**

Run: `npx vitest run tests/cli.test.ts`
Expected: FAIL — `Cannot find module '../src/cli.js'`

- [ ] **Step 3: Escribir `src/cli.ts`**

```typescript
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
```

- [ ] **Step 4: Correr el test para verificar que pasa**

Run: `npx vitest run tests/cli.test.ts`
Expected: PASS — 5 tests.

- [ ] **Step 5: Correr toda la suite**

Run: `npm test && npm run typecheck`
Expected: todos los tests pasan, sin errores de tipos.

- [ ] **Step 6: Commit**

```bash
git add src/cli.ts tests/cli.test.ts
git commit -m "feat: wire the full gate pipeline with ERROR fallback"
```

---

### Task 12: Empaquetado como GitHub Action

**Files:**
- Create: `action.yml`
- Create: `.github/workflows/ci.yml`
- Modify: `.gitignore` (dejar de ignorar `dist/`)
- Test: `tests/action.test.ts`

**Interfaces:**
- Consumes: `dist/index.js` producido por `npm run build`.
- Produces: la Action publicable.

Una JavaScript Action necesita su bundle commiteado: el runner no ejecuta `npm install`.

- [ ] **Step 1: Escribir `action.yml`**

```yaml
name: 'AI Quality Gate'
description: 'Audita cada PR con auditores de IA especializados y bloquea el merge hasta que pase.'
author: 'brunogianoli'

inputs:
  anthropic-api-key:
    description: 'API key de Anthropic para los auditores.'
    required: true
  github-token:
    description: 'Token con permiso para comentar y crear checks.'
    required: false
    default: ${{ github.token }}

runs:
  using: 'node24'
  main: 'dist/index.js'

branding:
  icon: 'shield'
  color: 'purple'
```

- [ ] **Step 2: Quitar `dist/` del `.gitignore`**

`.gitignore` queda:

```
node_modules/
*.log
```

- [ ] **Step 3: Escribir el test que falla**

`tests/action.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { readFile, access } from 'node:fs/promises';
import { parse } from 'yaml';

describe('action.yml', () => {
  it('apunta al bundle y declara la API key como requerida', async () => {
    const action = parse(await readFile('action.yml', 'utf8')) as {
      runs: { using: string; main: string };
      inputs: Record<string, { required?: boolean }>;
    };
    expect(action.runs.main).toBe('dist/index.js');
    expect(action.runs.using).toMatch(/^node\d+$/);
    expect(action.inputs['anthropic-api-key']?.required).toBe(true);
  });

  it('el bundle existe y no requiere node_modules', async () => {
    await expect(access('dist/index.js')).resolves.toBeUndefined();
    const bundle = await readFile('dist/index.js', 'utf8');
    expect(bundle).not.toMatch(/require\(['"]@octokit\/rest['"]\)/);
    expect(bundle.length).toBeGreaterThan(10_000);
  });
});
```

- [ ] **Step 4: Correr el test para verificar que falla**

Run: `npx vitest run tests/action.test.ts`
Expected: FAIL — el segundo test falla porque `dist/index.js` no existe todavía.

- [ ] **Step 5: Construir el bundle**

Run: `npm run build`
Expected: se crea `dist/index.js`.

Si el runner de GitHub rechaza `using: 'node24'`, bajar a `node20` en `action.yml` y cambiar `--target=node24` a `--target=node20` en el script `build` de `package.json`.

- [ ] **Step 6: Correr el test para verificar que pasa**

Run: `npx vitest run tests/action.test.ts`
Expected: PASS — 2 tests.

- [ ] **Step 7: Escribir el CI del propio repo**

`.github/workflows/ci.yml`:

```yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 24
          cache: npm
      - run: npm ci
      - run: npm run typecheck
      - run: npm test
      - run: npm run build
      - name: El bundle commiteado está actualizado
        run: git diff --exit-code dist/
```

- [ ] **Step 8: Escribir el `README.md` con las instrucciones de instalación**

Este snippet es lo único que un repo consumidor necesita copiar. El bloque
`concurrency` no es opcional: sin él, tres pushes seguidos disparan tres
auditorías completas del mismo PR y se pagan tres veces.

````markdown
# AI Quality Gate

Audita cada Pull Request con auditores de IA especializados y bloquea el merge
hasta que pase. Ejecuta el build y los tests del proyecto, revisa el cambio, y
publica un veredicto. **Nunca modifica código**: comenta y espera a que quien
abrió la PR corrija.

## Instalación

1. Agregá `ANTHROPIC_API_KEY` a los secrets del repositorio
   (Settings → Secrets and variables → Actions).

2. Creá `.github/workflows/ai-quality-gate.yml`:

```yaml
name: AI Quality Gate

on:
  pull_request:
    types: [opened, synchronize, reopened]

permissions:
  contents: read
  pull-requests: write
  checks: write

concurrency:
  group: quality-gate-${{ github.ref }}
  cancel-in-progress: true

jobs:
  audit:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0        # necesario para calcular el diff de la PR
      - uses: brunogianoli/quality-gate@v1
        with:
          anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}
```

3. Para que el gate bloquee de verdad, marcá el check **AI Quality Gate** como
   requerido en Settings → Branches → Branch protection rules.

## Configuración

La política por defecto está en `policies/default.yaml` de esta Action. Para
cambiarla en un repo, creá `.ai/policy.yaml` — los campos que definas pisan los
del default, el resto se hereda:

```yaml
min_confidence: 0.8        # más estricto: menos findings bloquean

auditors:
  security:
    model: claude-opus-5   # un modelo más capaz sólo para este auditor
```

## Criterios de aceptación

El auditor `acceptance` compara el código contra lo que la tarea pedía. Los
busca en este orden:

1. El issue que la PR cierra (`Closes #42`) — la fuente preferida: el criterio
   es previo al código.
2. La descripción de la PR.
3. Si no hay ninguno, `acceptance` no corre y el comentario lo dice.

## Limitación conocida

Las PRs desde un *fork* no reciben secrets, así que el gate no puede correr
sobre ellas.
````

- [ ] **Step 9: Commit**

```bash
git add action.yml .gitignore .github/workflows/ci.yml dist/index.js README.md tests/action.test.ts
git commit -m "feat: package as a GitHub Action with committed bundle"
```

---

### Task 13: Fixture y golden set

**Files:**
- Create: `fixture/package.json`, `fixture/src/calculator.ts`, `fixture/src/calculator.test.ts`, `fixture/vitest.config.ts`
- Create: `tests/golden/cases.ts`
- Test: `tests/golden.test.ts`

**Interfaces:**
- Consumes: `decide` de `src/policy.ts`, `selectAuditors` de `src/analyzer.ts`.
- Produces: el golden set — casos con veredicto esperado que se corre ante cualquier cambio de prompt o de política.

El golden set de esta tarea valida el **camino determinista** (selección de auditores y veredicto) sin gastar tokens. Los casos que requieren juicio del modelo se corren a mano contra el fixture antes de publicar una versión.

- [ ] **Step 1: Crear el fixture**

`fixture/package.json`:

```json
{
  "name": "quality-gate-fixture",
  "version": "1.0.0",
  "type": "module",
  "private": true,
  "scripts": {
    "build": "tsc --noEmit",
    "test": "vitest run"
  },
  "devDependencies": {
    "typescript": "^5.7.0",
    "vitest": "^3.0.0"
  }
}
```

`fixture/vitest.config.ts`:

```typescript
import { defineConfig } from 'vitest/config';

export default defineConfig({ test: { include: ['src/**/*.test.ts'] } });
```

`fixture/src/calculator.ts`:

```typescript
export function add(a: number, b: number): number {
  return a + b;
}

export function divide(a: number, b: number): number {
  if (b === 0) throw new Error('division by zero');
  return a / b;
}
```

`fixture/src/calculator.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { add, divide } from './calculator.js';

describe('calculator', () => {
  it('suma', () => {
    expect(add(2, 3)).toBe(5);
  });

  it('divide', () => {
    expect(divide(10, 2)).toBe(5);
  });

  it('rechaza la división por cero', () => {
    expect(() => divide(1, 0)).toThrow('division by zero');
  });
});
```

- [ ] **Step 2: Escribir los casos del golden set**

`tests/golden/cases.ts`:

```typescript
import type { ChangedFile, Finding, RunnerResult } from '../../src/types.js';

export interface GoldenCase {
  name: string;
  files: ChangedFile[];
  criteriaAvailable: boolean;
  runner: RunnerResult;
  findings: Finding[];
  expectedVerdict: 'PASS' | 'FAIL';
  expectedAuditors: string[];
}

function file(path: string): ChangedFile {
  return { path, status: 'modified', additions: 5, deletions: 2, patch: '@@ -1 +1 @@' };
}

const green: RunnerResult = {
  install: null,
  build: { ok: true, exitCode: 0, output: '' },
  test: { ok: true, exitCode: 0, output: '3 passed' },
};

const redTests: RunnerResult = {
  install: null,
  build: { ok: true, exitCode: 0, output: '' },
  test: { ok: false, exitCode: 1, output: '1 failed, 2 passed' },
};

const redBuild: RunnerResult = {
  install: null,
  build: { ok: false, exitCode: 2, output: 'TS2322: type error' },
  test: null,
};

function finding(severity: Finding['severity'], confidence: number): Finding {
  return {
    severity,
    confidence,
    title: 't',
    file: 'fixture/src/calculator.ts',
    line: 3,
    message: 'm',
    evidence: null,
    suggestedFix: null,
  };
}

export const CASES: GoldenCase[] = [
  {
    name: 'cambio limpio en el backend, todo verde',
    files: [file('src/calculator.ts')],
    criteriaAvailable: true,
    runner: green,
    findings: [],
    expectedVerdict: 'PASS',
    expectedAuditors: ['acceptance', 'scope', 'backend'],
  },
  {
    name: 'tests rotos: sólo corren scope y acceptance',
    files: [file('src/calculator.ts')],
    criteriaAvailable: true,
    runner: redTests,
    findings: [],
    expectedVerdict: 'FAIL',
    expectedAuditors: ['acceptance', 'scope'],
  },
  {
    name: 'build roto: veredicto FAIL sin importar los auditores',
    files: [file('src/calculator.ts')],
    criteriaAvailable: true,
    runner: redBuild,
    findings: [],
    expectedVerdict: 'FAIL',
    expectedAuditors: ['acceptance', 'scope', 'backend'],
  },
  {
    name: 'secreto hardcodeado: HIGH de alta confianza bloquea',
    files: [file('src/auth/token.ts')],
    criteriaAvailable: true,
    runner: green,
    findings: [finding('HIGH', 0.95)],
    expectedVerdict: 'FAIL',
    expectedAuditors: ['acceptance', 'scope', 'backend', 'security'],
  },
  {
    name: 'sospecha de baja confianza: informa pero no bloquea',
    files: [file('src/calculator.ts')],
    criteriaAvailable: true,
    runner: green,
    findings: [finding('HIGH', 0.4)],
    expectedVerdict: 'PASS',
    expectedAuditors: ['acceptance', 'scope', 'backend'],
  },
  {
    name: 'migración destructiva activa el auditor de base de datos',
    files: [file('migrations/V42__drop_users.sql')],
    criteriaAvailable: true,
    runner: green,
    findings: [finding('CRITICAL', 0.9)],
    expectedVerdict: 'FAIL',
    expectedAuditors: ['acceptance', 'scope', 'database'],
  },
  {
    name: 'sin criterios declarados: acceptance no corre',
    files: [file('README.md')],
    criteriaAvailable: false,
    runner: green,
    findings: [],
    expectedVerdict: 'PASS',
    expectedAuditors: ['scope'],
  },
  {
    name: 'cambio de infraestructura activa el auditor correspondiente',
    files: [file('.github/workflows/deploy.yml')],
    criteriaAvailable: true,
    runner: green,
    findings: [],
    expectedVerdict: 'PASS',
    expectedAuditors: ['acceptance', 'scope', 'infrastructure'],
  },
];
```

- [ ] **Step 3: Escribir el test que falla**

`tests/golden.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { CASES } from './golden/cases.js';
import { selectAuditors } from '../src/analyzer.js';
import { decide, loadPolicy } from '../src/policy.js';
import type { Policy } from '../src/types.js';

let policy: Policy;

describe('golden set', () => {
  it.each(CASES)('$name', async (c) => {
    policy ??= await loadPolicy(process.cwd());

    const testsFailed = Boolean(c.runner.test && !c.runner.test.ok);

    // `expectedAuditors` es siempre el resultado final esperado, ya con el
    // corte parcial aplicado donde corresponde. El test no recalcula nada.
    const selected = selectAuditors(policy, c.files, {
      criteriaAvailable: c.criteriaAvailable,
      testsFailed,
    });

    expect(selected.sort()).toEqual([...c.expectedAuditors].sort());
    expect(decide(policy, c.runner, c.findings).verdict).toBe(c.expectedVerdict);
  });
});
```

- [ ] **Step 4: Correr el test para verificar que falla**

Run: `npx vitest run tests/golden.test.ts`
Expected: FAIL — `Cannot find module './golden/cases.js'` hasta que los pasos anteriores estén guardados.

- [ ] **Step 5: Correr el golden set completo**

Run: `npx vitest run tests/golden.test.ts`
Expected: PASS — 8 casos.

Si un caso falla, el bug está en `resolveTriggers` (patrones de path) o en `decide` (umbrales), no en el test. Corregir el código, no el caso esperado.

- [ ] **Step 6: Verificar que el fixture corre solo**

```bash
cd fixture && npm install && npm test && cd ..
```

Expected: 3 tests pasan.

- [ ] **Step 7: Correr la suite completa**

Run: `npm test && npm run typecheck && npm run build`
Expected: todo pasa.

- [ ] **Step 8: Commit**

```bash
git add fixture/ tests/golden/ tests/golden.test.ts
git commit -m "test: add fixture repo and deterministic golden set"
```

---

## Verificación final

- [ ] `npm test` — toda la suite pasa
- [ ] `npm run typecheck` — sin errores
- [ ] `npm run build` — `dist/index.js` actualizado y commiteado
- [ ] `git status` limpio

## Qué queda fuera de este plan

Estas piezas están diseñadas en el spec pero no se implementan acá, y cada una es su propio plan cuando toque:

- **Prueba end-to-end real**: publicar la Action, instalarla en un repo de prueba y verificar el ciclo completo (FAIL → push → PASS) contra la API de verdad. Es el criterio de éxito del spec (sección 11) y requiere credenciales y un repo publicado.
- **Auditores adicionales**: `regression`, `frontend`, `api-contract`, `dependencies`, `architecture`. Cada uno es un `.md` más una entrada de política.
- **Golden set con llamadas reales al modelo**: mide si los prompts aciertan, no sólo si el cableado funciona. Requiere presupuesto de tokens y un criterio para tolerar variación entre corridas.
