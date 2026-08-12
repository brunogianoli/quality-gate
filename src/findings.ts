import type { Finding } from './types.js';

// Dos auditores que miran el mismo cambio desde ángulos distintos encuentran el
// mismo defecto seguido: `acceptance` lo ve como criterio incumplido y `backend`
// como bug. Rara vez coinciden en el número exacto de línea — uno apunta a la
// firma y el otro al cuerpo — así que un margen chico los junta sin alcanzar al
// defecto siguiente.
const LINE_WINDOW = 2;

/**
 * Dos findings son el mismo defecto si están en el mismo archivo, con la misma
 * severidad, y a lo sumo `LINE_WINDOW` líneas de distancia.
 *
 * La severidad tiene que coincidir: un CRITICAL y un LOW sobre la misma línea
 * son dos problemas distintos, y fusionarlos escondería el que no bloquea.
 */
function esElMismoDefecto(a: Finding, b: Finding): boolean {
  if (a.file !== b.file || a.severity !== b.severity) return false;
  if (a.line === null || b.line === null) return a.line === b.line;
  return Math.abs(a.line - b.line) <= LINE_WINDOW;
}

/**
 * Colapsa los reportes repetidos del mismo defecto, conservando el más
 * confiable. No cambia el veredicto: fusionar dos bloqueantes en uno deja un
 * bloqueante, y ninguno de los dos deja de contar. Lo que cambia es que el
 * comentario deja de mostrar un problema como si fueran dos.
 */
export function dedupeFindings(findings: Finding[]): Finding[] {
  const conservados: Finding[] = [];

  for (const finding of findings) {
    const yaVisto = conservados.findIndex((otro) => esElMismoDefecto(otro, finding));

    if (yaVisto === -1) {
      conservados.push(finding);
      continue;
    }

    // Ante el mismo defecto se queda el reporte más confiable; a igual
    // confianza, el que trae más explicación, que es el que le sirve a quien
    // tiene que corregir.
    const actual = conservados[yaVisto]!;
    const reemplaza =
      finding.confidence > actual.confidence ||
      (finding.confidence === actual.confidence && finding.message.length > actual.message.length);

    if (reemplaza) conservados[yaVisto] = finding;
  }

  return conservados;
}
