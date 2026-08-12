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
    expect(bundle.length).toBeGreaterThan(10_000);

    // No alcanza con chequear un paquete a mano: recorremos todas las
    // dependencies de package.json para que el test se mantenga solo si el
    // día de mañana se agrega/quita una dependencia. Cubre tanto
    // `require('pkg')` como subpaths (`require('pkg/algo')`).
    const pkg = JSON.parse(await readFile('package.json', 'utf8')) as {
      dependencies?: Record<string, string>;
    };
    const dependencyNames = Object.keys(pkg.dependencies ?? {});
    expect(dependencyNames.length).toBeGreaterThan(0);

    for (const name of dependencyNames) {
      const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const externalRequire = new RegExp(`require\\(['"]${escaped}(?:/[^'"]*)?['"]\\)`);
      expect(bundle, `el bundle no debería requerir '${name}' como paquete externo`).not.toMatch(
        externalRequire,
      );
    }
  });
});
