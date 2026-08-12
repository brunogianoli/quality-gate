import type { AuditContext, ChangedFile, FileStatus, RunnerResult } from './types.js';

export interface OctokitLike {
  pulls: {
    get(args: { owner: string; repo: string; pull_number: number }): Promise<{
      data: { body?: string | null };
    }>;
    listFiles(args: {
      owner: string;
      repo: string;
      pull_number: number;
      per_page?: number;
      page?: number;
    }): Promise<{
      data: Array<{
        filename: string;
        status: string;
        additions: number;
        deletions: number;
        patch?: string | undefined;
      }>;
    }>;
  };
  issues: {
    get(args: { owner: string; repo: string; issue_number: number }): Promise<{
      data: { body?: string | null };
    }>;
  };
}

const CLOSING_KEYWORD = /\b(clos(e|es|ed)|fix(es|ed)?|resolv(e|es|ed))\s+#(\d+)\b/i;

export function extractIssueNumber(body: string | null): number | null {
  if (!body) return null;
  const match = CLOSING_KEYWORD.exec(body);
  if (!match?.[5]) return null;
  return Number.parseInt(match[5], 10);
}

function normalizeStatus(status: string): FileStatus {
  if (status === 'added' || status === 'removed' || status === 'renamed') return status;
  return 'modified';
}

// El máximo que `pulls.listFiles` devuelve por página. Pedir más no falla: la
// API acepta el parámetro y devuelve 100 igual, así que un valor mayor trunca
// el diff en silencio en vez de dar error.
const PER_PAGE = 100;

async function listAllFiles(
  octokit: OctokitLike,
  owner: string,
  repo: string,
  prNumber: number,
): Promise<ChangedFile[]> {
  const files: ChangedFile[] = [];

  for (let page = 1; ; page++) {
    const { data } = await octokit.pulls.listFiles({
      owner,
      repo,
      pull_number: prNumber,
      per_page: PER_PAGE,
      page,
    });

    for (const f of data) {
      files.push({
        path: f.filename,
        status: normalizeStatus(f.status),
        additions: f.additions,
        deletions: f.deletions,
        patch: f.patch ?? null,
      });
    }

    // Una página incompleta es la última: no hay nada más que pedir.
    if (data.length < PER_PAGE) return files;
  }
}

export interface ContextDeps {
  octokit: OctokitLike;
  owner: string;
  repo: string;
  prNumber: number;
  commitSha: string;
  runner: RunnerResult;
}

export async function buildContext(deps: ContextDeps): Promise<AuditContext> {
  const { octokit, owner, repo, prNumber, commitSha, runner } = deps;

  const pr = await octokit.pulls.get({ owner, repo, pull_number: prNumber });
  const prBody = pr.data.body ?? null;

  const changedFiles = await listAllFiles(octokit, owner, repo, prNumber);

  let criteria: string | null = null;
  let criteriaSource: AuditContext['criteriaSource'] = null;

  const issueNumber = extractIssueNumber(prBody);
  if (issueNumber !== null) {
    const issue = await octokit.issues.get({ owner, repo, issue_number: issueNumber });
    const issueBody = issue.data.body?.trim();
    if (issueBody) {
      criteria = issueBody;
      criteriaSource = 'issue';
    }
  }

  if (criteria === null && prBody?.trim()) {
    criteria = prBody.trim();
    criteriaSource = 'pull_request';
  }

  return { owner, repo, prNumber, commitSha, changedFiles, criteria, criteriaSource, runner };
}
