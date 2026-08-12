import { readdir, readFile } from 'node:fs/promises';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

// Los archivos que empiezan con `_` son calibración compartida, no auditores:
// se anexan a cada prompt en vez de registrarse como uno más. Así la escala de
// severidad vive una sola vez y sigue siendo un dato editable sin tocar código.
const SHARED_PREFIX = '_';

export async function loadPrompts(): Promise<Record<string, string>> {
  const dir = join(here, '..', 'agents');
  const files = (await readdir(dir)).filter((f) => f.endsWith('.md'));

  const sharedFiles = files.filter((f) => f.startsWith(SHARED_PREFIX)).sort();
  const shared = (
    await Promise.all(sharedFiles.map((f) => readFile(join(dir, f), 'utf8')))
  ).join('\n\n');

  const auditors = files.filter((f) => !f.startsWith(SHARED_PREFIX));
  const entries = await Promise.all(
    auditors.map(async (f) => {
      const own = await readFile(join(dir, f), 'utf8');
      // El contrato propio del auditor va primero; la calibración común
      // después, para que cierre sobre cómo reportar lo que encontró.
      const text = shared ? `${own.trimEnd()}\n\n${shared}` : own;
      return [basename(f, '.md'), text] as const;
    }),
  );

  return Object.fromEntries(entries);
}
