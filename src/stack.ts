import { readFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import type { StackInfo } from './types.js';

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export async function detectStack(dir: string): Promise<StackInfo> {
  if (await exists(join(dir, 'package.json'))) {
    const raw = await readFile(join(dir, 'package.json'), 'utf8');
    const pkg = JSON.parse(raw) as { scripts?: Record<string, string> };
    const scripts = pkg.scripts ?? {};
    return {
      kind: 'node',
      install: 'npm ci',
      build: scripts['build'] ? 'npm run build' : null,
      test: scripts['test'] ? 'npm test' : null,
    };
  }

  if (await exists(join(dir, 'pom.xml'))) {
    return {
      kind: 'java-maven',
      install: null,
      build: './mvnw -B compile',
      test: './mvnw -B test',
    };
  }

  if (
    (await exists(join(dir, 'pyproject.toml'))) ||
    (await exists(join(dir, 'requirements.txt')))
  ) {
    return {
      kind: 'python',
      install: (await exists(join(dir, 'requirements.txt')))
        ? 'pip install -r requirements.txt'
        : 'pip install -e .',
      build: null,
      test: 'pytest',
    };
  }

  return { kind: 'unknown', install: null, build: null, test: null };
}
