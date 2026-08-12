import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detectStack } from '../src/stack.js';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'stack-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('detectStack', () => {
  it('detecta Node con npm ci cuando hay package-lock.json', async () => {
    await writeFile(
      join(dir, 'package.json'),
      JSON.stringify({ scripts: { build: 'tsc', test: 'vitest run' } }),
    );
    await writeFile(join(dir, 'package-lock.json'), '{}');
    const stack = await detectStack(dir);
    expect(stack.kind).toBe('node');
    expect(stack.install).toBe('npm ci');
    expect(stack.build).toBe('npm run build');
    expect(stack.test).toBe('npm test');
  });

  it('detecta Yarn cuando hay yarn.lock y usa sus comandos', async () => {
    await writeFile(
      join(dir, 'package.json'),
      JSON.stringify({ scripts: { build: 'tsc', test: 'vitest run' } }),
    );
    await writeFile(join(dir, 'yarn.lock'), '');
    const stack = await detectStack(dir);
    expect(stack.kind).toBe('node');
    expect(stack.install).toBe('yarn install --frozen-lockfile');
    expect(stack.build).toBe('yarn build');
    expect(stack.test).toBe('yarn test');
  });

  it('detecta pnpm cuando hay pnpm-lock.yaml y usa sus comandos', async () => {
    await writeFile(
      join(dir, 'package.json'),
      JSON.stringify({ scripts: { build: 'tsc', test: 'vitest run' } }),
    );
    await writeFile(join(dir, 'pnpm-lock.yaml'), '');
    const stack = await detectStack(dir);
    expect(stack.kind).toBe('node');
    expect(stack.install).toBe('pnpm install --frozen-lockfile');
    expect(stack.build).toBe('pnpm build');
    expect(stack.test).toBe('pnpm test');
  });

  it('usa npm install (no npm ci) cuando no hay ningún lockfile', async () => {
    await writeFile(
      join(dir, 'package.json'),
      JSON.stringify({ scripts: { build: 'tsc', test: 'vitest run' } }),
    );
    const stack = await detectStack(dir);
    expect(stack.kind).toBe('node');
    expect(stack.install).toBe('npm install');
    expect(stack.build).toBe('npm run build');
    expect(stack.test).toBe('npm test');
  });

  it('omite el build cuando package.json no define ese script', async () => {
    await writeFile(join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'vitest run' } }));
    const stack = await detectStack(dir);
    expect(stack.build).toBeNull();
    expect(stack.test).toBe('npm test');
  });

  it('detecta Maven cuando hay pom.xml', async () => {
    await writeFile(join(dir, 'pom.xml'), '<project/>');
    const stack = await detectStack(dir);
    expect(stack.kind).toBe('java-maven');
    expect(stack.build).toBe('./mvnw -B compile');
    expect(stack.test).toBe('./mvnw -B test');
  });

  it('detecta Python cuando hay pyproject.toml', async () => {
    await writeFile(join(dir, 'pyproject.toml'), '[project]');
    const stack = await detectStack(dir);
    expect(stack.kind).toBe('python');
    expect(stack.test).toBe('pytest');
  });

  it('devuelve unknown cuando no hay marcadores', async () => {
    const stack = await detectStack(dir);
    expect(stack.kind).toBe('unknown');
    expect(stack.test).toBeNull();
  });
});
