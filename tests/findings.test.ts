import { describe, it, expect } from 'vitest';
import { dedupeFindings } from '../src/findings.js';
import type { Finding } from '../src/types.js';

function f(over: Partial<Finding> = {}): Finding {
  return {
    severity: 'HIGH',
    confidence: 0.9,
    title: 't',
    file: 'src/pago.ts',
    line: 10,
    message: 'm',
    evidence: null,
    suggestedFix: null,
    ...over,
  };
}

describe('dedupeFindings', () => {
  it('fusiona el mismo defecto reportado por dos auditores', () => {
    // Caso real de la PR #4: `acceptance` y `backend` reportaron que
    // porcentaje() no rechaza total = 0, con títulos distintos y una línea de
    // diferencia. El comentario lo mostró como dos problemas.
    const findings = [
      f({ line: 11, title: "Criterio 'Rechaza total = 0' no implementado", confidence: 0.95 }),
      f({ line: 10, title: 'porcentaje() no rechaza total = 0', confidence: 0.9 }),
    ];

    const result = dedupeFindings(findings);

    expect(result).toHaveLength(1);
  });

  it('conserva el finding con más confianza', () => {
    const result = dedupeFindings([
      f({ line: 10, title: 'menos seguro', confidence: 0.75 }),
      f({ line: 11, title: 'más seguro', confidence: 0.95 }),
    ]);

    expect(result[0]?.title).toBe('más seguro');
  });

  it('no fusiona severidades distintas sobre la misma línea', () => {
    // Un CRITICAL y un LOW en el mismo lugar son dos problemas, no uno: fusionar
    // perdería el que no bloquea.
    const result = dedupeFindings([
      f({ severity: 'CRITICAL', title: 'inyección SQL' }),
      f({ severity: 'LOW', title: 'nombre poco descriptivo' }),
    ]);

    expect(result).toHaveLength(2);
  });

  it('no fusiona defectos lejanos dentro del mismo archivo', () => {
    const result = dedupeFindings([f({ line: 10 }), f({ line: 80 })]);
    expect(result).toHaveLength(2);
  });

  it('no fusiona el mismo número de línea en archivos distintos', () => {
    const result = dedupeFindings([f({ file: 'src/a.ts' }), f({ file: 'src/b.ts' })]);
    expect(result).toHaveLength(2);
  });

  it('fusiona findings sin línea si coinciden archivo y severidad', () => {
    const result = dedupeFindings([
      f({ line: null, title: 'falta validación', confidence: 0.8 }),
      f({ line: null, title: 'no valida la entrada', confidence: 0.9 }),
    ]);

    expect(result).toHaveLength(1);
    expect(result[0]?.title).toBe('no valida la entrada');
  });

  it('no mezcla un finding sin línea con uno que sí la tiene', () => {
    const result = dedupeFindings([f({ line: null }), f({ line: 10 })]);
    expect(result).toHaveLength(2);
  });

  it('preserva el orden de aparición de los que sobreviven', () => {
    const result = dedupeFindings([
      f({ file: 'src/a.ts', title: 'primero' }),
      f({ file: 'src/b.ts', title: 'segundo' }),
      f({ file: 'src/a.ts', line: 11, title: 'duplicado del primero', confidence: 0.5 }),
    ]);

    expect(result.map((x) => x.title)).toEqual(['primero', 'segundo']);
  });

  it('no rompe con una lista vacía', () => {
    expect(dedupeFindings([])).toEqual([]);
  });
});
