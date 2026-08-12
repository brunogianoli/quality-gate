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

  it('vuelca el output de install en el comentario cuando install falló', () => {
    const installCtx: AuditContext = {
      ...ctx,
      runner: {
        install: { ok: false, exitCode: 1, output: 'npm ERR! code EUSAGE\nnpm ERR! `npm ci` requires package-lock.json' },
        build: null,
        test: null,
      },
    };
    const installDecision: Decision = {
      verdict: 'FAIL',
      blocking: [],
      informational: [],
      reason: 'La instalación de dependencias falló.',
    };
    const body = renderComment({ ctx: installCtx, decision: installDecision, auditors: [], errors: [] });
    expect(body).toContain('**Install:** falló');
    expect(body).toContain('npm ERR! `npm ci` requires package-lock.json');
  });

  it('vuelca el output de build en el comentario cuando el build falló', () => {
    const buildCtx: AuditContext = {
      ...ctx,
      runner: {
        install: { ok: true, exitCode: 0, output: '' },
        build: { ok: false, exitCode: 1, output: "src/index.ts(3,7): error TS2322: Type 'string' is not assignable to type 'number'." },
        test: null,
      },
    };
    const buildDecision: Decision = {
      verdict: 'FAIL',
      blocking: [],
      informational: [],
      reason: 'El build falló.',
    };
    const body = renderComment({ ctx: buildCtx, decision: buildDecision, auditors: [], errors: [] });
    expect(body).toContain('**Build:** falló');
    expect(body).toContain("error TS2322: Type 'string' is not assignable to type 'number'.");
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
