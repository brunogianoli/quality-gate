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

// `detectStack` fija install: 'npm ci' para todo repo Node (ver src/stack.ts), así
// que una corrida real nunca tiene install: null — siempre es un CommandResult.
const green: RunnerResult = {
  install: { ok: true, exitCode: 0, output: '' },
  build: { ok: true, exitCode: 0, output: '' },
  test: { ok: true, exitCode: 0, output: '3 passed' },
};

const redTests: RunnerResult = {
  install: { ok: true, exitCode: 0, output: '' },
  build: { ok: true, exitCode: 0, output: '' },
  test: { ok: false, exitCode: 1, output: '1 failed, 2 passed' },
};

const redBuild: RunnerResult = {
  install: { ok: true, exitCode: 0, output: '' },
  build: { ok: false, exitCode: 2, output: 'TS2322: type error' },
  test: null,
};

const redInstall: RunnerResult = {
  install: { ok: false, exitCode: 1, output: 'npm ERR! code E404' },
  build: null,
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
  {
    name: 'instalación rota: FAIL antes de build o tests',
    files: [file('src/calculator.ts')],
    criteriaAvailable: true,
    runner: redInstall,
    findings: [],
    expectedVerdict: 'FAIL',
    expectedAuditors: ['acceptance', 'scope', 'backend'],
  },
  {
    name: 'lockfile modificado: activa security por deps_changed',
    files: [file('package-lock.json')],
    criteriaAvailable: true,
    runner: green,
    findings: [],
    expectedVerdict: 'PASS',
    expectedAuditors: ['acceptance', 'scope', 'security'],
  },
  {
    name: 'controller modificado: activa security por endpoints_changed',
    files: [file('src/api/PaymentController.java')],
    criteriaAvailable: true,
    runner: green,
    findings: [],
    expectedVerdict: 'PASS',
    expectedAuditors: ['acceptance', 'scope', 'backend', 'security'],
  },
  {
    name: 'umbral de confianza: 0.7 exactamente bloquea',
    files: [file('src/calculator.ts')],
    criteriaAvailable: true,
    runner: green,
    findings: [finding('HIGH', 0.7)],
    expectedVerdict: 'FAIL',
    expectedAuditors: ['acceptance', 'scope', 'backend'],
  },
  {
    name: 'umbral de confianza: 0.69 no bloquea',
    files: [file('src/calculator.ts')],
    criteriaAvailable: true,
    runner: green,
    findings: [finding('HIGH', 0.69)],
    expectedVerdict: 'PASS',
    expectedAuditors: ['acceptance', 'scope', 'backend'],
  },
  {
    name: 'PR con múltiples archivos agrega triggers de distintos auditores',
    files: [
      file('src/calculator.ts'),
      file('migrations/V1__init.sql'),
      file('.github/workflows/ci.yml'),
    ],
    criteriaAvailable: true,
    runner: green,
    findings: [],
    expectedVerdict: 'PASS',
    expectedAuditors: ['acceptance', 'scope', 'backend', 'database', 'infrastructure'],
  },
];
