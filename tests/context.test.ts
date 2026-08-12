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

interface IssueGetArgs {
  owner: string;
  repo: string;
  issue_number: number;
}

function spyOctokit(prBody: string | null, issueBody?: string): {
  octokit: OctokitLike;
  issueGetCalls: IssueGetArgs[];
} {
  const issueGetCalls: IssueGetArgs[] = [];
  const octokit: OctokitLike = {
    pulls: {
      get: async () => ({ data: { body: prBody } }),
      listFiles: async () => ({
        data: [
          { filename: 'src/a.ts', status: 'modified', additions: 3, deletions: 1, patch: '@@ x @@' },
        ],
      }),
    },
    issues: {
      get: async (args) => {
        issueGetCalls.push(args);
        return { data: { body: issueBody ?? '' } };
      },
    },
  };
  return { octokit, issueGetCalls };
}

type ListedFile = { filename: string; status: string; additions: number; deletions: number; patch?: string | undefined };

function fileAt(i: number): ListedFile {
  return { filename: `src/f${i}.ts`, status: 'modified', additions: 1, deletions: 0, patch: '@@ x @@' };
}

interface ListFilesCall {
  per_page?: number | undefined;
  page?: number | undefined;
}

function pagedOctokit(pages: ListedFile[][]): { octokit: OctokitLike; calls: ListFilesCall[] } {
  const calls: ListFilesCall[] = [];
  const octokit: OctokitLike = {
    pulls: {
      get: async () => ({ data: { body: null } }),
      listFiles: async (args) => {
        calls.push({ per_page: args.per_page, page: args.page });
        return { data: pages[(args.page ?? 1) - 1] ?? [] };
      },
    },
    issues: {
      get: async () => ({ data: { body: '' } }),
    },
  };
  return { octokit, calls };
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

  it('cae al cuerpo de la PR si el issue vinculado tiene body vacío', async () => {
    // A diferencia del test anterior, este body SÍ tiene palabra clave de
    // cierre: extractIssueNumber encuentra el #42, buildContext consulta
    // issues.get, encuentra un body vacío/blanco, lo descarta, y recién ahí
    // cae al cuerpo de la PR. Ejercita la rama donde se consulta el issue.
    const ctx = await buildContext({
      ...base,
      octokit: fakeOctokit('Closes #42 - agrega validación de DNI', '   '),
    });
    expect(ctx.criteriaSource).toBe('pull_request');
    expect(ctx.criteria).toBe('Closes #42 - agrega validación de DNI');
  });

  it('deja criteria en null si no hay issue ni cuerpo', async () => {
    const ctx = await buildContext({ ...base, octokit: fakeOctokit(null) });
    expect(ctx.criteriaSource).toBeNull();
    expect(ctx.criteria).toBeNull();
  });

  it('invoca issues.get con el número de issue extraído del body, no con el de la PR', async () => {
    const { octokit, issueGetCalls } = spyOctokit('Closes #42', 'criterios del issue');
    await buildContext({ ...base, octokit });
    expect(issueGetCalls).toEqual([{ owner: 'o', repo: 'r', issue_number: 42 }]);
    // prNumber (1) y el issue_number extraído (42) son distintos a propósito:
    // si buildContext pasara prNumber en vez del número extraído, este
    // assert lo detectaría.
    expect(issueGetCalls[0]?.issue_number).not.toBe(base.prNumber);
  });

  it('pide páginas de 100, que es el máximo real de la API', async () => {
    // Pedir per_page: 300 no es un error: la API lo acepta y devuelve 100.
    // Por eso el truncado es silencioso y sólo se ve auditando los args.
    const { octokit, calls } = pagedOctokit([[fileAt(1)]]);
    await buildContext({ ...base, octokit });
    expect(calls[0]?.per_page).toBe(100);
  });

  it('trae todos los archivos de una PR con más de 100 cambios', async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => fileAt(i));
    const page2 = Array.from({ length: 50 }, (_, i) => fileAt(100 + i));
    const { octokit } = pagedOctokit([page1, page2]);

    const ctx = await buildContext({ ...base, octokit });

    expect(ctx.changedFiles).toHaveLength(150);
    expect(ctx.changedFiles[149]?.path).toBe('src/f149.ts');
  });

  it('no pide una página extra cuando la primera vuelve incompleta', async () => {
    const { octokit, calls } = pagedOctokit([[fileAt(1), fileAt(2)]]);
    await buildContext({ ...base, octokit });
    expect(calls).toHaveLength(1);
  });
});
