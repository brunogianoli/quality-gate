import type { AuditContext } from '../../src/types.js';

/**
 * Cada caso fija una propiedad que los prompts tienen que cumplir, no un texto
 * que tengan que devolver: el modelo redacta distinto en cada corrida, pero
 * bloquear o no bloquear es estable y es lo que decide si el gate sirve.
 *
 * Los casos vienen en pares por auditor — uno donde no hay nada que reportar y
 * otro con un defecto real — porque las dos formas de romper la calibración son
 * opuestas. Bajar el ruido hasta que no detecte nada es tan malo como el ruido.
 */
export interface GoldenPromptCase {
  nombre: string;
  auditor: string;
  espera: 'sin bloqueantes' | 'al menos un bloqueante';
  /** Por qué este caso existe: qué regresión atrapa. */
  porque: string;
  ctx: AuditContext;
}

const runnerVerde: AuditContext['runner'] = {
  install: { ok: true, exitCode: 0, output: '' },
  build: { ok: true, exitCode: 0, output: 'ok' },
  test: { ok: true, exitCode: 0, output: '136 passed' },
};

function ctx(over: Partial<AuditContext> & Pick<AuditContext, 'changedFiles' | 'criteria'>): AuditContext {
  return {
    owner: 'acme',
    repo: 'widgets',
    prNumber: 1,
    commitSha: 'abc1234',
    criteriaSource: 'pull_request',
    runner: runnerVerde,
    ...over,
  };
}

function diff(texto: string): string {
  return texto
    .trim()
    .split('\n')
    .map((l) => `+${l}`)
    .join('\n');
}

// Deliberadamente sin secrets y con permisos de sólo lectura. La primera
// versión de este caso usaba el workflow del propio gate, y resultó un mal caso
// de golden set: ese workflow ejecuta el código de la PR (`npm ci && npm test`)
// con la API key en el entorno del job, así que un finding sobre eso es
// defendible, no ruido. Un caso de golden set tiene que tener una respuesta
// inequívoca; si hay que discutirla, no sirve para decidir si un prompt regresó.
const WORKFLOW_CORRECTO = `name: CI
on:
  pull_request:
permissions:
  contents: read
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 24
      - run: npm ci
      - run: npm test`;

const WORKFLOW_PELIGROSO = `name: Deploy
on:
  pull_request_target:
    types: [opened, synchronize]
env:
  API_KEY: sk-a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6
permissions: write-all
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          ref: \${{ github.event.pull_request.head.sha }}
      - run: npm install && npm run deploy -- --token=\${{ secrets.DEPLOY_TOKEN }}`;

export const GOLDEN_PROMPT_CASES: GoldenPromptCase[] = [
  {
    nombre: 'workflow de CI sin secrets y con permisos de sólo lectura',
    auditor: 'infrastructure',
    espera: 'sin bloqueantes',
    porque:
      'No hay nada que reportar: sin secrets, permisos mínimos, acciones oficiales. Sin calibración de severidad, este auditor producía HIGH bloqueantes cuyo propio texto decía que la configuración estaba bien, y variaba entre corridas.',
    ctx: ctx({
      changedFiles: [
        {
          path: '.github/workflows/ci.yml',
          status: 'added',
          additions: 15,
          deletions: 0,
          patch: diff(WORKFLOW_CORRECTO),
        },
      ],
      criteria: 'Correr los tests en cada PR.',
    }),
  },
  {
    nombre: 'workflow peligroso: secreto commiteado y código no confiable con secrets',
    auditor: 'infrastructure',
    espera: 'al menos un bloqueante',
    porque:
      'La contracara del caso anterior: si calibrar la severidad apagara la detección, el gate dejaría pasar un secreto en el repo y un pull_request_target haciendo checkout del código de la PR.',
    ctx: ctx({
      changedFiles: [
        {
          path: '.github/workflows/deploy.yml',
          status: 'added',
          additions: 16,
          deletions: 0,
          patch: diff(WORKFLOW_PELIGROSO),
        },
      ],
      criteria: 'Desplegar automáticamente cuando se abre una PR.',
    }),
  },
  {
    nombre: 'criterio incumplido: la función no rechaza el caso que el criterio exige',
    auditor: 'acceptance',
    espera: 'al menos un bloqueante',
    porque:
      'El caso de la PR #4. Es la razón de ser del auditor: comparar el código contra lo que la tarea pedía, no contra buenas prácticas generales.',
    ctx: ctx({
      changedFiles: [
        {
          path: 'src/calculator.ts',
          status: 'modified',
          additions: 3,
          deletions: 0,
          patch: diff(`export function porcentaje(parte: number, total: number): number {
  return (parte / total) * 100;
}`),
        },
      ],
      criteria:
        'Agregar porcentaje(parte, total). Debe rechazar total = 0 lanzando un error, igual que hace divide() con su divisor.',
    }),
  },
  {
    nombre: 'criterio cumplido: la misma función, ya con el guard que el criterio pedía',
    auditor: 'acceptance',
    espera: 'sin bloqueantes',
    porque:
      'El commit que llevó la PR #4 de FAIL a PASS. Si este caso bloqueara, el gate no dejaría cerrar el ciclo ni siquiera cuando el agente corrige exactamente lo que se le pidió.',
    ctx: ctx({
      changedFiles: [
        {
          path: 'src/calculator.ts',
          status: 'modified',
          additions: 4,
          deletions: 0,
          patch: diff(`export function porcentaje(parte: number, total: number): number {
  if (total === 0) throw new Error('total cannot be zero');
  return (parte / total) * 100;
}`),
        },
      ],
      criteria:
        'Agregar porcentaje(parte, total). Debe rechazar total = 0 lanzando un error, igual que hace divide() con su divisor.',
    }),
  },
  {
    nombre: 'backend: cobro sin validar el monto, con el test que lo prueba en rojo',
    auditor: 'backend',
    espera: 'al menos un bloqueante',
    porque:
      'Un defecto de backend con evidencia dura: el test que falla está en el contexto compartido. Si este caso no bloquea, el auditor no está mirando la salida de los tests.',
    ctx: ctx({
      changedFiles: [
        {
          path: 'src/pago.ts',
          status: 'modified',
          additions: 4,
          deletions: 0,
          patch: diff(`export async function cobrar(monto: number, tarjeta: string) {
  const res = await api.post('/cobro', { monto, tarjeta });
  return res.data;
}`),
        },
      ],
      criteria: 'Cobrar solo montos positivos. Rechazar con 400 si el monto es <= 0.',
      runner: {
        install: { ok: true, exitCode: 0, output: '' },
        build: { ok: true, exitCode: 0, output: 'tsc ok' },
        test: {
          ok: false,
          exitCode: 1,
          output: 'FAIL src/pago.test.ts > rechaza monto negativo\n  expected 400, got 200',
        },
      },
    }),
  },
  {
    nombre: 'backend: un rename sin cambio de comportamiento',
    auditor: 'backend',
    espera: 'sin bloqueantes',
    porque:
      'El cambio aburrido que domina cualquier repo. Un gate que bloquea acá se desactiva en una semana, y este es el caso que más fácil se rompe al endurecer los prompts.',
    ctx: ctx({
      changedFiles: [
        {
          path: 'src/usuario.ts',
          status: 'modified',
          additions: 2,
          deletions: 2,
          patch: `@@ -12,7 +12,7 @@
-export function getUsr(id: string): Promise<Usuario> {
-  return db.usuarios.findById(id);
+export function obtenerUsuario(id: string): Promise<Usuario> {
+  return db.usuarios.findById(id);
 }`,
        },
      ],
      criteria: 'Renombrar getUsr a obtenerUsuario para que el nombre diga qué devuelve.',
    }),
  },
];
