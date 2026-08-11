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
