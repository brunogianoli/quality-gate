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
