# AI Quality Gate — Diseño

**Fecha:** 2026-08-11
**Estado:** aprobado, listo para plan de implementación

## 1. Problema

Cuando un agente de IA (Claude Code, Codex, Cursor) o una persona termina una tarea, no hay nada que verifique el resultado antes de que se dé por terminado. Pedirlo a mano en cada tarea no escala y se olvida.

El objetivo es que **toda** tarea terminada pase obligatoriamente por auditores especializados que la revisen y la prueben, sin que nadie tenga que acordarse de pedirlo.

El mecanismo es separar dos estados que hoy se confunden:

```
DONE       ← lo declara quien hizo el trabajo
APPROVED   ← lo decide un sistema externo
```

El agente puede decir "terminé". No puede decir "está aprobado". Esa decisión vive fuera de él, y por eso ningún agente puede saltearla.

## 2. Alcance

### Lo que hace

Cuando se abre o actualiza una Pull Request, el sistema ejecuta el build y los tests del proyecto, corre auditores de IA especializados sobre el cambio, aplica una política configurable, y publica un veredicto que bloquea o habilita el merge.

### Lo que no hace

**No modifica código.** No hay Fix Agent, no commitea, no pushea, no aplica correcciones. Detecta, explica, propone y comenta. Quien corrige es el agente que abrió la PR: lee el comentario, arregla, pushea, y eso dispara una nueva auditoría.

Esta restricción es una decisión, no una limitación técnica. El sistema no necesita permiso de escritura sobre el código, y sus juicios se pueden evaluar durante un tiempo antes de considerar darle más autonomía.

### Decisiones descartadas explícitamente

Se evaluaron y se descartaron para v1, con su motivo:

| Descartado | Motivo |
|---|---|
| Servicio propio 24/7 con Postgres y cola de jobs | GitHub Actions ya aporta trigger, sandbox aislado, historial y bloqueo de merge. Reconstruirlo son semanas antes del primer veredicto. |
| GitHub App + webhook + túnel de desarrollo | El workflow recibe un `GITHUB_TOKEN` con permiso para comentar y crear checks. No hace falta identidad propia ni exponer un puerto. |
| Fix Agent con loop de corrección automática | Requiere escritura en el repositorio antes de haber visto si los auditores aciertan. |

## 3. Arquitectura

Dos repositorios con roles distintos:

```
ESTE REPO (CI-CD) — el producto          REPOS DE TRABAJO — los consumidores
────────────────────────────────         ──────────────────────────────────
action.yml           la Action           .github/workflows/
src/                 orquestador (TS)      ai-quality-gate.yml
  cli.ts             entrada                      │
  context.ts         arma el contexto             │ invoca
  analyzer.ts        elige auditores      ◄───────┘
  auditor.ts         corre un auditor
  runner.ts          build + tests        .ai/policy.yaml
  policy.ts          PASS / FAIL            overrides opcionales
  report.ts          comentario + check
agents/              contratos en .md
  acceptance.md  scope.md  backend.md
  security.md    database.md  infrastructure.md
policies/default.yaml
fixture/             repo de prueba Node/TS
```

**Stack:** TypeScript sobre Node.js. Octokit para GitHub, el SDK de Anthropic para los auditores, Vitest para los tests del propio sistema.

**Los auditores son datos, no código.** Cada `agents/*.md` contiene rol, qué revisar, qué no puede aprobar y el esquema de salida. `auditor.ts` es genérico: recibe un `.md` y un contexto, devuelve findings. Agregar un auditor de frontend es escribir un markdown, no tocar TypeScript.

### Instalación en un repo consumidor

Cinco líneas, una vez por repositorio:

```yaml
name: AI Quality Gate
on:
  pull_request:
    types: [opened, synchronize, reopened]
permissions:
  contents: read
  pull-requests: write
  checks: write
concurrency:
  group: quality-gate-${{ github.ref }}
  cancel-in-progress: true
jobs:
  audit:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }        # el diff completo necesita el historial
      - uses: brunogianoli/quality-gate@v1
        with:
          anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}
```

### Limitación conocida

Las PRs que vienen de un *fork* no reciben secrets, así que `ANTHROPIC_API_KEY` no está disponible y el gate no puede correr. Para repos propios con ramas internas no es un problema. Abrir a contribuciones externas requiere una solución aparte y cuidadosa: `pull_request_target` ejecuta código no confiable con acceso a los secrets, así que no es la respuesta obvia que parece.

## 4. Flujo de una PR

```
PR abierta o push
   │
   ├─► checkout + detección de stack       package.json / pom.xml / requirements.txt
   │
   ├─► instalar + build ──── ¿falla? ─────► FAIL, corte total, cero llamadas a la IA
   │                                        (el error del compilador ya es el mensaje)
   ├─► tests ──────────────── ¿fallan? ───► FAIL, pero siguen scope + acceptance
   │                                        (2 llamadas, ~15s, evita que el agente
   │                                         itere en la dirección equivocada)
   ├─► TASK ANALYZER                        llamada barata: archivos cambiados +
   │      ¿qué cambió? ¿quién audita?       criterios → lista de auditores
   │
   ├─► AUDITORES en paralelo                cada uno recibe: diff + criterios +
   │      acceptance  scope                 resultado real de los tests
   │      backend     security
   │      database    infrastructure
   │
   ├─► POLICY ENGINE                        regla determinista
   │
   └─► comentario en la PR + check run
          │
          ├── PASS  → check verde, merge habilitado
          └── FAIL  → check rojo + comentario con findings
                       │
                       └─► el agente lee, corrige, pushea → vuelve a empezar
```

### Por qué los tests corren antes que los auditores

Cada auditor recibe hechos, no sólo código. Puede decir "el test `shouldRejectNullDni` falla con 500 y la causa está en esta línea" en vez de "esto parece riesgoso". El runner de Actions provee el entorno aislado que esto requiere.

### Por qué el corte es escalonado

El consumidor del comentario es un agente, no una persona: lee el output de vitest o JUnit sin necesidad de traducción. Gastar seis llamadas para reescribir un stack trace en prosa no aporta nada.

La excepción son `scope` y `acceptance`, que no dependen de que los tests pasen: uno mira el diff, el otro compara contra los criterios. Si el agente implementó algo distinto de lo pedido **y** rompió tests, decirle sólo "arreglá los tests" lo manda a pulir código que hay que tirar.

## 5. Auditores de v1

| Auditor | Pregunta | Se activa |
|---|---|---|
| `acceptance` | ¿Hace lo que la tarea pedía? | siempre (si hay criterios) |
| `scope` | ¿Tocó sólo lo que había que tocar? | siempre |
| `backend` | Lógica, validaciones, manejo de errores, arquitectura | controllers, services, repos, DTOs |
| `security` | Auth, permisos, injection, secretos, exposición | auth, endpoints, dependencias |
| `database` | Migraciones, índices, N+1, transacciones, integridad | migraciones, entidades, queries |
| `infrastructure` | Docker, CI, secretos, networking, healthchecks | Dockerfile, compose, workflows, IaC |

Los tres primeros atacan los fallos típicos de un agente: hacer otra cosa, romper algo, tocar de más. Los tres siguientes son los dominios de mayor señal del stack en uso.

`regression`, `frontend`, `api-contract`, `dependencies`, `architecture`, `observability`, `documentation` y `performance` quedan fuera de v1. Agregarlos es escribir un markdown y una línea de política.

### Origen de los criterios de aceptación

En este orden:

1. Si la PR cierra un issue (`Closes #42`), se leen los criterios del issue. El criterio es previo al código y no está contaminado por lo que terminó saliendo.
2. Si no hay issue vinculado, se lee el cuerpo de la PR.
3. Si no hay ninguno de los dos, `acceptance` no corre y el comentario lo dice explícitamente en vez de inventar un veredicto.

## 6. Contratos

Cada auditor devuelve JSON forzado por esquema mediante structured outputs (`output_config.format`), no texto que se parsea después:

```json
{
  "auditor": "backend",
  "status": "PASS | FAIL",
  "findings": [
    {
      "severity": "CRITICAL | HIGH | MEDIUM | LOW | INFO",
      "confidence": 0.85,
      "title": "El endpoint puede devolver 500 con DNI nulo",
      "file": "src/reclamos/ReclamoController.java",
      "line": 84,
      "message": "...",
      "evidence": "test shouldRejectNullDni: expected 400, got 500",
      "suggestedFix": "..."
    }
  ]
}
```

`confidence` es la principal defensa contra el ruido: un finding con confianza baja nunca bloquea — se degrada a informativo o se descarta según el umbral. El modelo puede sospechar; para frenar un merge tiene que estar seguro.

### Política

```yaml
# policies/default.yaml
model: claude-sonnet-5           # configurable por auditor

required: [build, tests]

block_on:     [CRITICAL, HIGH]
comment_only: [MEDIUM, LOW, INFO]

min_confidence: 0.7              # debajo de esto, nunca bloquea

on_test_failure:
  run_auditors: [scope, acceptance]

auditors:
  acceptance:     { when: criteria_available }   # se salta si no hay issue ni cuerpo de PR
  scope:          { when: always, effort: low }
  backend:        { when: backend_changed }
  database:       { when: database_changed }
  security:       { when: [auth_changed, deps_changed, endpoints_changed] }
  infrastructure: { when: infra_changed }
```

```
PASS  =  build ok  AND  tests ok
         AND  ningún finding bloqueante con confidence ≥ min_confidence
```

El veredicto es aritmética, no criterio. Los auditores producen findings con severidad; el Policy Engine decide qué severidades bloquean. Un modelo que dice "en general está bien" no aprueba nada.

Cada repo puede pisar esto con su propio `.ai/policy.yaml`. El campo `model` acepta un valor por auditor, así se puede subir uno solo a un modelo más capaz sin cambiar el resto.

## 7. Salida

### Comentario consolidado y actualizable

Un solo comentario por auditoría, con un marcador HTML invisible. En cada push el sistema lo busca y lo edita en vez de crear otro: una PR con ocho iteraciones tiene un comentario, no ocho.

```markdown
<!-- ai-quality-gate -->
## ● Quality Gate — FAILED   ·   commit a81f92c

**Tests:** 127 passed, 2 failed
**Auditores:** acceptance ✓ · scope ✗ · backend ✗ · security ✓

### 🔴 HIGH · backend
`src/reclamos/ReclamoController.java:84` — El endpoint puede devolver 500 con DNI nulo
> test `shouldRejectNullDni`: expected 400, got 500

**Sugerencia:** validar en el DTO con `@NotBlank` antes de llegar al service.

### 🟡 MEDIUM · scope
`src/utils/DateHelper.java` — Refactor no relacionado con la tarea
(12 archivos fuera del alcance del issue #42)
```

El formato está pensado para que lo consuma un agente: severidad, `archivo:línea` exacto, y qué hacer. Nada de prosa que haya que interpretar.

### Check run

En paralelo, un check run es lo que efectivamente bloquea el merge — el comentario informa, el check manda — más anotaciones por línea, que hacen aparecer cada finding sobre el código en la pestaña *Files changed*.

## 8. Manejo de errores

Tres estados, no dos:

| Estado | Qué pasó | Check | ¿Bloquea? |
|---|---|---|---|
| `PASS` | Todo verde | 🟢 | no |
| `FAIL` | Encontró problemas reales | 🔴 | sí |
| `ERROR` | El gate no pudo correr (API caída, timeout, rate limit) | ⚪ neutral | **no** |

Si un outage de la API bloqueara los merges, el primer incidente llevaría a desactivar el gate. Un `ERROR` comenta qué pasó y deja pasar.

Además: timeout por auditor, un reintento con backoff, y `concurrency: cancel-in-progress` para que varios pushes seguidos no disparen auditorías simultáneas del mismo PR.

## 9. Costo

Modelo `claude-sonnet-5` ($3 por millón de tokens de entrada, $15 de salida; precio introductorio de $2/$10 hasta el 31 de agosto de 2026).

Una PR de ~300 líneas:

```
Contexto compartido (diff + criterios + tests)     ~4.800 tokens
Prompt propio de cada auditor                        ~800 tokens
Salida por auditor (razonamiento + findings)       ~3.000 tokens
```

Los cinco o seis auditores reciben casi el mismo input. Poniendo el bloque compartido **primero** y marcándolo con `cache_control`, el primero paga la escritura y el resto lee a una décima parte del precio:

```
sin caché:   ~29.000 tokens de entrada  →  $0.09
con caché:   ~13.000 tokens de entrada  →  $0.04
salida (domina):  ~18.000 tokens        →  $0.27
                                    total ≈ $0.31 por PR
                                          ≈ $62 / mes a 200 PRs
```

**Restricción de implementación:** las llamadas en paralelo no pueden leer un caché que otra todavía está escribiendo. Hay que disparar un auditor, esperar su primer token, y recién ahí lanzar el resto. Sin esto el caché no aporta nada.

El costo lo domina la salida, así que la palanca real es `effort` por auditor: `scope` mira el diff y no necesita razonar hondo; `security` sí.

## 10. Cómo se prueba el gate

Lo que más se rompe no es el código: son los prompts, y un prompt no tiene stack trace.

- **Golden set.** PRs del fixture con veredicto conocido: una que rompe un test, una fuera de alcance, una con un secreto hardcodeado, una correcta, una con una migración destructiva. Cada vez que se toca un `.md` se corre el set y se verifica que los veredictos siguen dando. Sin esto, editar prompts es a ciegas.
- **Tests unitarios** del orquestador con la API mockeada: el Task Analyzer elige bien, el Policy Engine decide bien, el comentario se actualiza en vez de duplicarse.
- **Los falsos positivos son bugs de primera clase.** Si el golden set marca un finding donde no lo hay, se arregla como un test roto. Un gate que hay que filtrar a mano pierde su autoridad y deja de leerse.

El fixture es un repo Node/TS mínimo con tests que se pueden hacer fallar y pasar a voluntad, para probar PASS y FAIL de forma determinista en segundos.

## 11. Criterio de éxito

El sistema funciona cuando este ciclo cierra solo, de punta a punta:

```
1. Un agente abre una PR en el repo fixture, rompiendo un test.
2. El gate corre solo, sin que nadie lo dispare.
3. Publica FAIL con el test roto y los findings de los auditores.
4. El check rojo impide el merge.
5. El agente lee el comentario, corrige y pushea.
6. El gate vuelve a correr y publica PASS.
7. El merge queda habilitado.
```
