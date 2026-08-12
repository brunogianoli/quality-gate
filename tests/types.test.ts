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
