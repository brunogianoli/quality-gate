import { describe, it, expect } from 'vitest';
import { loadPrompts } from '../src/prompts.js';

const REQUIRED_SECTIONS = ['# ROLE', '# WHAT TO CHECK', '# WHAT YOU CANNOT APPROVE', '# CONFIDENCE'];

// The smallest real section body among the six current prompts is ~97 characters
// (acceptance's # ROLE). 40 leaves comfortable room for legitimate edits while
// still rejecting a header left standing over an empty or placeholder body.
const MIN_SECTION_BODY_LENGTH = 40;

// The smallest current prompt is ~1060 characters. 400 leaves comfortable room
// for a legitimate trim while still rejecting a prompt gutted down to its
// headers (five headers plus a token each is nowhere near 400 characters).
const MIN_PROMPT_LENGTH = 400;

/**
 * Maps each top-level `# HEADER` line in a prompt to the trimmed text that
 * follows it, up to the next top-level header (or end of file). Used to check
 * that a section has real content, not just its heading.
 */
function sectionBodies(text: string): Record<string, string> {
  const lines = text.split('\n');
  const headerLineIndexes: number[] = [];
  lines.forEach((line, i) => {
    if (/^# .+/.test(line)) headerLineIndexes.push(i);
  });

  const bodies: Record<string, string> = {};
  headerLineIndexes.forEach((start, idx) => {
    const end = idx + 1 < headerLineIndexes.length ? headerLineIndexes[idx + 1] : lines.length;
    const header = lines[start]!.trim();
    bodies[header] = lines
      .slice(start + 1, end)
      .join('\n')
      .trim();
  });
  return bodies;
}

describe('loadPrompts', () => {
  it('carga los seis auditores de v1', async () => {
    const prompts = await loadPrompts();
    expect(Object.keys(prompts).sort()).toEqual([
      'acceptance',
      'backend',
      'database',
      'infrastructure',
      'scope',
      'security',
    ]);
  });

  it('no expone los archivos compartidos como si fueran auditores', async () => {
    // `_shared.md` es calibración común, no un auditor: si entrara al registro,
    // la política podría "seleccionarlo" y el orquestador intentaría correrlo.
    const prompts = await loadPrompts();
    for (const name of Object.keys(prompts)) {
      expect(name.startsWith('_'), `${name} no debería estar registrado`).toBe(false);
    }
  });

  it('cada auditor recibe la calibración de severidad compartida', async () => {
    // Sin esto la escala la inventa el modelo, y lo que se vio en producción
    // fueron findings HIGH cuyo propio texto decía que el código estaba bien.
    const prompts = await loadPrompts();
    for (const [name, text] of Object.entries(prompts)) {
      expect(text, `${name} debe incluir la escala de severidad`).toContain('# SEVERITY');
      expect(text, `${name} debe incluir qué no es un finding`).toContain('# WHAT IS NOT A FINDING');
    }
  });

  it('cada prompt declara las cuatro secciones obligatorias', async () => {
    const prompts = await loadPrompts();
    for (const [name, text] of Object.entries(prompts)) {
      for (const header of REQUIRED_SECTIONS) {
        expect(text, `${name} debe declarar la sección ${header}`).toContain(header);
      }
    }
  });

  it('cada sección obligatoria tiene contenido real, no sólo el encabezado', async () => {
    const prompts = await loadPrompts();
    for (const [name, text] of Object.entries(prompts)) {
      const bodies = sectionBodies(text);
      for (const header of REQUIRED_SECTIONS) {
        const body = bodies[header] ?? '';
        expect(
          body.length,
          `${name}: la sección ${header} tiene ${body.length} caracteres de contenido, se esperaban al menos ${MIN_SECTION_BODY_LENGTH}`,
        ).toBeGreaterThanOrEqual(MIN_SECTION_BODY_LENGTH);
      }
    }
  });

  it('cada prompt supera una longitud mínima total, para detectar archivos vaciados', async () => {
    const prompts = await loadPrompts();
    for (const [name, text] of Object.entries(prompts)) {
      const length = text.trim().length;
      expect(
        length,
        `${name} tiene ${length} caracteres, se esperaban al menos ${MIN_PROMPT_LENGTH}`,
      ).toBeGreaterThanOrEqual(MIN_PROMPT_LENGTH);
    }
  });
});
