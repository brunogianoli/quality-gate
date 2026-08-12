# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Estado actual

El diseño está aprobado y documentado en `docs/superpowers/specs/2026-08-11-quality-gate-design.md`. **Ese spec es la fuente de verdad** — este archivo resume lo que hace falta saber antes de tocar código y señala los invariantes que se rompen con facilidad.

El sistema está implementado y la suite pasa. Comandos:

```bash
npm test                    # suite unitaria: sin red, ~8s
npm test -- tests/policy.test.ts   # un solo archivo
npm test -- -t "decide"     # los tests cuyo nombre matchea
npm run test:integration    # corre el gate contra fixture/ de verdad: red, ~1min
npm run typecheck           # tsc --noEmit
npm run build               # regenera dist/index.js (va commiteado)
```

`dist/index.js` es el bundle que ejecuta la Action y **está commiteado**: cada vez que cambie algo de `src/`, hay que correr `npm run build` y commitear el bundle, o el CI falla en el paso `git diff --exit-code dist/`.

Los problemas conocidos que quedaron sin resolver están en `docs/known-issues.md`.

`Plan.md` es material de referencia: la conversación exploratoria de la que salió la idea. El spec la reemplaza en todo punto donde difieran.

## Qué es este producto

Un **quality gate** que corre como GitHub Action en cada Pull Request: ejecuta el build y los tests del proyecto, audita el cambio con auditores de IA especializados, aplica una política y publica un veredicto que bloquea o habilita el merge.

Existe para separar dos estados que normalmente se confunden:

```
DONE       ← lo declara quien hizo el trabajo
APPROVED   ← lo decide este sistema, desde fuera
```

Un agente puede decir "terminé". No puede decir "está aprobado". Por eso el gate vive fuera del agente y ninguno puede saltearlo.

## Invariantes

Romper cualquiera de estos convierte el producto en otra cosa:

1. **El sistema nunca modifica código.** No hay Fix Agent: no commitea, no pushea, no aplica fixes. Detecta, explica, propone y comenta. Quien corrige es el agente que abrió la PR; su push dispara una nueva auditoría. Cualquier feature que implique escribir en el repositorio auditado contradice el diseño.

2. **El veredicto es aritmética, no criterio de un LLM.** Los auditores producen findings con severidad y `confidence`. El Policy Engine decide con una regla fija: `build ok AND tests ok AND ningún finding bloqueante sobre el umbral de confianza`. Un modelo que dice "en general está bien" no aprueba nada.

3. **Los auditores son datos, no código.** Cada `agents/*.md` es un contrato (rol, qué revisar, qué no puede aprobar, esquema de salida). `auditor.ts` es genérico. Agregar un auditor es escribir un markdown y una línea de política — si agregar uno exige tocar TypeScript, la abstracción se rompió.

4. **`ERROR` no es `FAIL`.** Si la API se cae o un auditor da timeout, el check queda **neutral y no bloquea**. Un outage de un proveedor no puede frenar los merges del equipo; el primer incidente que lo hiciera llevaría a desactivar el gate.

5. **Los falsos positivos son bugs de primera clase.** Un gate que hay que filtrar a mano pierde autoridad y deja de leerse. `confidence` bajo nunca bloquea, y el golden set se corre ante cualquier cambio de prompt.

## Detalles fáciles de romper

- **Corte escalonado.** Si el build falla → `FAIL` sin llamar a la IA (el error del compilador ya es el mensaje, y quien lo lee es un agente que interpreta stack traces sin ayuda). Si los tests fallan → `FAIL`, pero **siguen corriendo `scope` y `acceptance`**, que no dependen de código funcionando y evitan que el agente itere puliendo algo mal orientado.

- **El caché exige una llamada en serie primero.** Los auditores comparten casi todo el input. El bloque compartido va primero, con `cache_control`. Pero una llamada no puede leer un caché que otra está escribiendo: hay que disparar un auditor, esperar su primer token, y recién ahí lanzar el resto en paralelo. Sin eso el caché no ahorra nada.

- **Un comentario, no veinte.** El comentario lleva un marcador HTML invisible; en cada push se busca y se **edita**, nunca se crea otro. El comentario informa; el **check run** es lo que bloquea el merge.

- **Formato para agentes, no para humanos.** Severidad, `archivo:línea` exacto y qué hacer. Nada de prosa que haya que interpretar.

- **`fetch-depth: 0` en el checkout.** Sin el historial completo no se puede calcular el diff de la PR.

- **PRs desde forks no reciben secrets**, así que no hay `ANTHROPIC_API_KEY` y el gate no corre. Para repos propios con ramas internas no importa. No "resolverlo" con `pull_request_target`: eso ejecuta código no confiable con acceso a los secrets.

## Stack

TypeScript sobre Node.js. Octokit para GitHub, el SDK de Anthropic para los auditores, Vitest para los tests del propio sistema. Los auditores corren en `claude-sonnet-5`, configurable por auditor en `policy.yaml`.

Al escribir código que llame a la API de Anthropic, cargar la skill `claude-api` antes — los IDs de modelo, el precio y la forma de forzar JSON (structured outputs vía `output_config.format`, no tool use) cambian seguido y no deben escribirse de memoria.

## Idioma

La documentación del proyecto va en español; identificadores de código y términos técnicos en inglés. Los archivos de `agents/*.md` son prompts para el modelo — escribirlos en inglés.
