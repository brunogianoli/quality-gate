import { readdir, readFile } from 'node:fs/promises';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

export async function loadPrompts(): Promise<Record<string, string>> {
  const dir = join(here, '..', 'agents');
  const files = (await readdir(dir)).filter((f) => f.endsWith('.md'));

  const entries = await Promise.all(
    files.map(async (f) => [basename(f, '.md'), await readFile(join(dir, f), 'utf8')] as const),
  );

  return Object.fromEntries(entries);
}
