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
