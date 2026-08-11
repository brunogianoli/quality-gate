# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Estado actual

Repositorio greenfield: sólo existe `Plan.md` (la especificación completa del producto). No hay código, ni control de versiones inicializado, ni stack tecnológico elegido todavía.

Consecuencias prácticas:

- **No hay comandos de build/test/lint aún.** Cuando se elija el stack e inicialice el proyecto, actualizar esta sección con los comandos reales (build, test suite completa, test individual, lint).
- `Plan.md` §33 exige que **antes de escribir código** se acuerden: stack, estructura del repo, contratos entre módulos, modelo de datos, eventos, API, estrategia de Sandbox y estrategia de integración con GitHub. Son decisiones de producto: confirmarlas con el usuario, no asumirlas.

## Qué es este producto

Un **Quality System** que audita Pull Requests de otros equipos/agentes. No es un coding agent. La distinción es el eje de todo el diseño (`Plan.md` §34):

- El agente de desarrollo **escribe** código.
- El Quality System **juzga** el código.

### Regla de oro (invariante duro de v1)

El Quality System **nunca** modifica código, hace commits, hace push ni aplica fixes automáticamente. Su output es: detectar → analizar → clasificar → asignar severidad → explicar → proponer solución → comentar en la PR → esperar el push del agente original → re-auditar.

Cualquier feature propuesta que implique escribir en el repositorio auditado viola esta regla. `Plan.md` §31 lista además lo que explícitamente **no** se implementa en v1: auto-fix, Kubernetes, multi-cloud, multi-tenancy complejo, billing, marketplace de plugins, múltiples proveedores LLM.

## Arquitectura

### Flujo end-to-end

```
GitHub PR (opened / synchronize / reopened)
   → Quality Orchestrator
   → Detection + Policies + Context
   → Auditorías IA (paralelas, seleccionadas dinámicamente)
   → Sandbox Runner (build, tests, E2E, runtime evidence)
   → Quality Engine (consolida findings)
   → Policy Engine (decide)
   → Quality Report → PASS | FAIL
   → comentario consolidado en la PR
   → push del agente → nueva auditoría
```

### Módulos (`Plan.md` §28)

`orchestrator/`, `github-integration/`, `project-service/`, `audit-engine/`, `policy-engine/`, `sandbox-runner/`, `execution-profile/`, `ai-agents/`, `quality-engine/`, `event-bus/`, `persistence/`, `api/`.

**Modular monolith con workers separados donde haga falta**, no microservicios desde el primer commit. La separación debe existir conceptualmente (contratos explícitos entre módulos) aunque varios corran en el mismo proceso.

### Separaciones de responsabilidad que no deben difuminarse

Estas fronteras son el motivo de que el sistema sea modular; romperlas es el error de diseño más probable:

1. **Sandbox vs Auditor.** El Sandbox ejecuta y observa: reporta *"esto pasó"* (logs, exit codes, tests fallidos, screenshots). El Auditor interpreta: *"esto significa que hay un problema"*. El Sandbox nunca emite juicios de calidad ni severidades.

2. **Auditor vs Policy Engine.** Los auditores producen findings con severidad (`CRITICAL`/`HIGH`/`MEDIUM`/`LOW`/`INFO`). El Policy Engine decide qué severidades bloquean la PR, por proyecto y de forma configurable. Nunca hardcodear el criterio de bloqueo dentro de un auditor. Por defecto, una sugerencia estética no bloquea.

3. **Orchestrator sin conocimiento de stacks.** El Orchestrator coordina; no contiene lógica específica de Java, Angular, Python, etc. Ese conocimiento vive en detección de stack + Execution Profiles.

4. **Auditores modulares, no un agente gigante.** Auditorías iniciales del MVP: Code Quality, Security, Architecture, Tests. Luego Database, Performance, Documentation. Cada auditoría combina Global Rules + Stack Rules + Project Rules bajo la Project Policy.

### Selección dinámica de auditorías

No se ejecutan todas siempre. Se decide a partir de archivos modificados, lenguaje, framework, estructura, dependencias, configuración, tipo de cambio y políticas del proyecto. Configuración declarativa por proyecto **+** detección automática (`Plan.md` §5).

Detección de stack por archivos marcadores: `pom.xml`, `build.gradle`, `package.json`, lockfiles, `requirements.txt`, `pyproject.toml`, `go.mod`, `Cargo.toml`, `Dockerfile`, `docker-compose.yml`. La detección debe ser extensible, nunca acoplada a una sola tecnología.

### Execution Profile

Contrato por proyecto que declara runtime, servicios auxiliares, comandos (`build`/`test`/`e2e`), límites (cpu/memoria/timeout) y modo de red (`Plan.md` §12). El sistema debe poder detectar el stack, generar un profile inicial, permitir editarlo y persistirlo por proyecto.

## Seguridad del Sandbox (prioridad alta)

El sistema ejecuta **código no confiable proveniente de PRs**. Cualquier cambio en `sandbox-runner/` se evalúa contra `Plan.md` §10 y §27:

- Ejecución efímera, aislada, destruida al terminar; filesystem propio nunca reutilizado entre ejecuciones.
- Límites obligatorios de CPU, RAM, disco y tiempo.
- **Red bloqueada por defecto**; los servicios externos se declaran explícitamente en el Execution Profile.
- Nunca ejecutar en el host. Nunca montar el Docker socket del host dentro del sandbox. Sin privilegios innecesarios. Sin acceso al host. Sin secretos expuestos.
- Si se reutiliza el `docker-compose.yml` del proyecto auditado, hay que inspeccionarlo y reescribir límites/networking/privilegios antes de levantarlo — no ejecutarlo tal cual.
- El aislamiento debe poder evolucionar de Docker a VMs/microVMs sin rediseñar el resto.

## Modelo de datos y contratos

- **Trazabilidad**: `Project → Repository → Pull Request → Commit → Audit → Findings + Sandbox Execution + Policy Evaluation`. Cada commit produce su propia auditoría; el historial se conserva.
- **Re-auditoría**: en `pull_request.synchronize` se re-evalúa el estado actual del commit desde cero. Nunca asumir que un finding previo fue resuelto.
- **Resultados estructurados, no texto libre**: tanto el resultado del Sandbox como los findings son objetos tipados (severidad, tipo, título, archivo, test, mensaje, evidencia, fix sugerido). Ver los esquemas de ejemplo en `Plan.md` §15 y §18.
- **Estados** — Audit: `QUEUED`, `RUNNING`, `PASSED`, `FAILED`, `ERROR`, `CANCELLED`, `TIMEOUT`. Sandbox Job: `QUEUED`, `PROVISIONING`, `CLONING`, `INSTALLING`, `BUILDING`, `TESTING`, `E2E`, `COLLECTING`, `COMPLETED`, `FAILED`, `TIMEOUT`, `DESTROYING`.
- **Concurrencia**: múltiples PRs simultáneas vía job queue. El Orchestrator es asíncrono y nunca bloquea esperando una ejecución de sandbox.
- **Runtime evidence**: logs, stack traces, test failures, HTTP responses, screenshots/videos de E2E, coverage, build output, artifacts, métricas. Existe para que la IA razone sobre hechos reales, no sólo sobre el código.

## Comentarios en la PR

Un comentario **consolidado** (o comentarios identificables y actualizables) por auditoría. No inundar la PR con cientos de comentarios individuales. Formato de referencia en `Plan.md` §21: estado, cantidad de problemas, y por finding severidad + ubicación + explicación + evidencia + solución sugerida, más el resumen de tests.

## Orden de construcción

`Plan.md` §29 y §33: construir un **vertical slice end-to-end** primero, no todos los módulos en aislamiento.

Slice inicial: `PR → webhook → Orchestrator → Sandbox → build/test → auditoría IA simple → Quality Report → PASS/FAIL → comentario en PR`.

Sólo cuando ese ciclo cierre (incluyendo `push → re-auditoría → PASS`) agregar, en este orden: policies, múltiples auditores, Execution Profiles, E2E, historial, concurrencia, escalabilidad, seguridad avanzada.

Stacks a soportar primero en el sistema auditado: Java/Spring Boot, Node.js, Angular/React, Python, Docker.

## Idioma

`Plan.md` está en español y el usuario trabaja en español. Mantener la documentación del proyecto en español; identificadores de código y términos técnicos en inglés.
