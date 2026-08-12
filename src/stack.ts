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

interface NodePackageManager {
  install: string;
  build: string;
  test: string;
}

// `npm ci` exige un package-lock.json presente; sin uno falla de entrada. Un
// repo con Yarn o pnpm tampoco tiene package-lock.json, así que hay que
// detectar el gestor por el lockfile que realmente está en el repo en vez de
// asumir npm para todo lo que tenga package.json.
async function detectNodePackageManager(dir: string): Promise<NodePackageManager> {
  if (await exists(join(dir, 'yarn.lock'))) {
    return { install: 'yarn install --frozen-lockfile', build: 'yarn build', test: 'yarn test' };
  }
  if (await exists(join(dir, 'pnpm-lock.yaml'))) {
    return { install: 'pnpm install --frozen-lockfile', build: 'pnpm build', test: 'pnpm test' };
  }
  if (await exists(join(dir, 'package-lock.json'))) {
    return { install: 'npm ci', build: 'npm run build', test: 'npm test' };
  }
  return { install: 'npm install', build: 'npm run build', test: 'npm test' };
}

export async function detectStack(dir: string): Promise<StackInfo> {
  if (await exists(join(dir, 'package.json'))) {
    const raw = await readFile(join(dir, 'package.json'), 'utf8');
    const pkg = JSON.parse(raw) as { scripts?: Record<string, string> };
    const scripts = pkg.scripts ?? {};
    const pm = await detectNodePackageManager(dir);
    return {
      kind: 'node',
      install: pm.install,
      build: scripts['build'] ? pm.build : null,
      test: scripts['test'] ? pm.test : null,
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
