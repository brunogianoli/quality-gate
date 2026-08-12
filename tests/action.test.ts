import { describe, it, expect } from 'vitest';
import { readFile, access } from 'node:fs/promises';
import { parse } from 'yaml';

describe('action.yml', () => {
  it('apunta al bundle y declara la API key como requerida', async () => {
    const action = parse(await readFile('action.yml', 'utf8')) as {
      runs: { using: string; main: string };
      inputs: Record<string, { required?: boolean }>;
    };
    expect(action.runs.main).toBe('dist/index.js');
    expect(action.runs.using).toMatch(/^node\d+$/);
    expect(action.inputs['anthropic-api-key']?.required).toBe(true);
  });

  it('el bundle existe y no requiere node_modules', async () => {
    await expect(access('dist/index.js')).resolves.toBeUndefined();
    const bundle = await readFile('dist/index.js', 'utf8');
    expect(bundle).not.toMatch(/require\(['"]@octokit\/rest['"]\)/);
    expect(bundle.length).toBeGreaterThan(10_000);
  });
});
