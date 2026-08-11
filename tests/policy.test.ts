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
