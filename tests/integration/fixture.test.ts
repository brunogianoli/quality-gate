import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { cp, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detectStack } from '../../src/stack.js';
import { runStack } from '../../src/runner.js';
import { decide } from '../../src/policy.js';
import type { Policy, RunnerResult, StackInfo } from '../../src/types.js';

// El único test de la suite que ejecuta un repositorio de verdad: instala sus
// dependencias, compila y corre sus tests. Por eso vive fuera de `npm test` (que
// no toca la red) y corre con `npm run test:integration`.
//
// Los auditores siguen mockeados — acá no se llama a la API de Anthropic. Lo que
// se verifica es la mitad determinista del gate: que detectStack elija los
// comandos correctos, que runStack los ejecute y corte donde tiene que cortar, y
// que decide() traduzca ese resultado al veredicto que corresponde.

const FIXTURE = join(import.meta.dirname, '..', '..', 'fixture');

// `divide` devuelve el producto: compila sin problemas, pero rompe dos de los
// tres tests del fixture. Sirve para el caso "build ok, tests en rojo".
const BUG_EN_RUNTIME = `export function add(a: number, b: number): number {
  return a + b;
}

export function divide(a: number, b: number): number {
  if (b === 0) throw new Error('division by zero');
  return a * b;
}
`;

// `divide` devuelve un string donde su firma promete number: no compila, así que
// el corte tiene que ocurrir en el build y los tests no deben llegar a correr.
const BUG_DE_TIPOS = `export function add(a: number, b: number): number {
  return a + b;
}

export function divide(a: number, b: number): number {
  if (b === 0) throw new Error('division by zero');
  return 'no es un número';
}
`;

const policy: Policy = {
  model: 'claude-sonnet-5',
  required: ['build', 'tests'],
  blockOn: ['CRITICAL', 'HIGH'],
  minConfidence: 0.7,
  onTestFailure: { runAuditors: [] },
  auditors: {},
};

let dir: string;
let stack: StackInfo;
let sano: RunnerResult;
let conBugEnRuntime: RunnerResult;
let conBugDeTipos: RunnerResult;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'quality-gate-fixture-'));
  await cp(FIXTURE, dir, { recursive: true });

  stack = await detectStack(dir);

  // Primera pasada completa: instala, compila y corre los tests.
  sano = await runStack(stack, dir);

  // Las siguientes reusan node_modules — `npm ci` lo borra y lo reinstala desde
  // cero cada vez, y son tres minutos de CI por nada.
  const sinInstall: StackInfo = { ...stack, install: null };

  const calculator = join(dir, 'src', 'calculator.ts');

  await writeFile(calculator, BUG_EN_RUNTIME);
  conBugEnRuntime = await runStack(sinInstall, dir);

  await writeFile(calculator, BUG_DE_TIPOS);
  conBugDeTipos = await runStack(sinInstall, dir);
}, 10 * 60 * 1000);

afterAll(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

describe('el gate contra el repositorio fixture', () => {
  it('detecta el stack y elige los comandos de npm', () => {
    expect(stack.kind).toBe('node');
    expect(stack.install).toBe('npm ci');
    expect(stack.build).toBe('npm run build');
    expect(stack.test).toBe('npm test');
  });

  it('aprueba el fixture sin tocar: install, build y tests en verde', () => {
    expect(sano.install?.ok).toBe(true);
    expect(sano.build?.ok).toBe(true);
    expect(sano.test?.ok).toBe(true);

    const decision = decide(policy, sano, []);
    expect(decision.verdict).toBe('PASS');
  });

  it('bloquea cuando los tests fallan, con el output del fallo real', () => {
    expect(conBugEnRuntime.build?.ok).toBe(true);
    expect(conBugEnRuntime.test?.ok).toBe(false);
    expect(conBugEnRuntime.test?.output).toContain('divide');

    const decision = decide(policy, conBugEnRuntime, []);
    expect(decision.verdict).toBe('FAIL');
    expect(decision.reason).toBe('Los tests fallaron.');
  });

  it('corta en el build y no llega a correr los tests cuando no compila', () => {
    expect(conBugDeTipos.build?.ok).toBe(false);
    expect(conBugDeTipos.build?.output).toContain('calculator.ts');
    // El corte escalonado: si no compila, los tests no aportan nada.
    expect(conBugDeTipos.test).toBeNull();

    const decision = decide(policy, conBugDeTipos, []);
    expect(decision.verdict).toBe('FAIL');
    expect(decision.reason).toBe('El build falló.');
  });
});
