import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decide, loadPolicy } from '../src/policy.js';
import type { Finding, Policy, RunnerResult } from '../src/types.js';

const policy: Policy = {
  model: 'claude-sonnet-5',
  required: ['build', 'tests'],
  blockOn: ['CRITICAL', 'HIGH'],
  minConfidence: 0.7,
  timeoutMs: 5 * 60 * 1000,
  maxRetries: 1,
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

  it('con los tres pasos del runner en null, declara honestamente que no se verificó nada en vez de un PASS mudo', () => {
    const unrun: RunnerResult = { install: null, build: null, test: null };
    const d = decide(policy, unrun, []);
    // El veredicto sigue siendo defendible (nada falló), pero el motivo —que
    // termina tanto en el comentario como en el output.summary del check run—
    // tiene que decir explícitamente que no hubo verificación real.
    expect(d.verdict).toBe('PASS');
    expect(d.reason.toLowerCase()).toContain('no fue reconocido');
    expect(d.reason).toContain('build');
    expect(d.reason).toContain('test');
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

  it('declara el timeout y los reintentos en vez de heredar los del SDK', async () => {
    const p = await loadPolicy(process.cwd());
    expect(p.timeoutMs).toBe(5 * 60 * 1000);
    expect(p.maxRetries).toBe(1);
  });

  describe('override del consumidor (.ai/policy.yaml)', () => {
    let dir: string;

    beforeEach(async () => {
      dir = await mkdtemp(join(tmpdir(), 'policy-'));
      await mkdir(join(dir, '.ai'));
    });

    afterEach(async () => {
      await rm(dir, { recursive: true, force: true });
    });

    it('traduce el timeout y los reintentos de un auditor a los nombres del tipo', async () => {
      // El YAML habla snake_case y `AuditorPolicy` camelCase. Sin la traducción
      // el override entra como un campo que nadie lee y el auditor corre con el
      // default, en silencio.
      await writeFile(
        join(dir, '.ai', 'policy.yaml'),
        'auditors:\n  backend:\n    when: always\n    timeout_ms: 60000\n    max_retries: 3\n',
      );
      const p = await loadPolicy(dir);
      expect(p.auditors['backend']?.timeoutMs).toBe(60000);
      expect(p.auditors['backend']?.maxRetries).toBe(3);
    });

    it('hereda del default lo que un override válido no pisa', async () => {
      await writeFile(
        join(dir, '.ai', 'policy.yaml'),
        'model: claude-opus-4\nmin_confidence: 0.9\n',
      );
      const p = await loadPolicy(dir);
      // Lo que el override declaró:
      expect(p.model).toBe('claude-opus-4');
      expect(p.minConfidence).toBe(0.9);
      // Lo que no declaró, viene del default del paquete:
      expect(p.blockOn).toEqual(['CRITICAL', 'HIGH']);
      expect(p.required).toEqual(['build', 'tests']);
      expect(p.auditors['scope']?.when).toBe('always');
    });

    it('lanza con un mensaje comprensible cuando block_on es un string en vez de un array', async () => {
      await writeFile(join(dir, '.ai', 'policy.yaml'), 'block_on: HIGH\n');
      await expect(loadPolicy(dir)).rejects.toThrow(/block_on/);
      await expect(loadPolicy(dir)).rejects.toThrow(/policy\.yaml/);
    });
  });
});
