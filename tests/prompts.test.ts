import { describe, it, expect } from 'vitest';
import { loadPrompts } from '../src/prompts.js';

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

  it('cada prompt define rol y lo que no puede aprobar', async () => {
    const prompts = await loadPrompts();
    for (const [name, text] of Object.entries(prompts)) {
      expect(text, `${name} debe declarar ROLE`).toContain('# ROLE');
      expect(text, `${name} debe declarar qué no puede aprobar`).toContain('WHAT YOU CANNOT APPROVE');
      expect(text, `${name} debe dar guía de confianza`).toContain('# CONFIDENCE');
    }
  });
});
