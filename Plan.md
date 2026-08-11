## 0. Objetivo

Construir desde cero un **Quality System para equipos/agentes de desarrollo asistidos por IA**.

El sistema funciona como una capa independiente de control de calidad alrededor del flujo normal de Git/GitHub:

```text
AGENTE DE DESARROLLO
        │
        ▼
      PR #123
        │
        ▼
┌───────────────────┐
│  QUALITY SYSTEM   │
└─────────┬─────────┘
          │
    tests + auditorías
          │
     ┌────┴────┐
     ▼         ▼
   PASS       FAIL
     │         │
     ▼         ▼
 APPROVED   COMENTARIO EN PR
                │
                ▼
         AGENTE ORIGINAL
                │
          modifica código
                │
             push
                │
                ▼
         PR ACTUALIZADA
                │
                ▼
        QUALITY SYSTEM
                │
             nuevamente
Principio fundamental

El agente de desarrollo escribe código. El Quality System juzga el código.

El Quality System NO modifica código automáticamente en v1.

Cuando encuentra problemas, debe:

Detectarlos.
Analizarlos.
Clasificarlos.
Asignar severidad.
Explicar el problema.
Proponer una solución.
Publicar el resultado en la PR.
Esperar al agente de desarrollo.
Volver a auditar cuando la PR cambie.
1. Objetivos del sistema
1.1 Objetivo principal

Crear un sistema capaz de revisar automáticamente cada Pull Request y determinar si cumple las reglas de calidad configuradas para ese proyecto.

1.2 Objetivos secundarios
Ejecutar tests automáticamente.
Levantar proyectos en entornos aislados.
Ejecutar build, unit tests, integration tests y E2E.
Analizar código mediante IA.
Analizar seguridad.
Analizar arquitectura.
Analizar performance cuando corresponda.
Analizar documentación.
Detectar automáticamente qué auditorías son relevantes.
Aplicar políticas configurables.
Comentar problemas directamente en la PR.
Re-ejecutarse automáticamente después de nuevos pushes.
Mantener historial de auditorías.
Generar evidencia reproducible de cada ejecución.
2. Flujo oficial
                    GITHUB
                      │
                      ▼
               Pull Request
                      │
                      ▼
          ┌─────────────────────┐
          │ QUALITY ORCHESTRATOR│
          └──────────┬──────────┘
                     │
          ┌──────────┼───────────┐
          ▼          ▼           ▼
      Detection    Policies    Context
          │
          ▼
    Auditorías IA
          │
          ├── Code
          ├── Security
          ├── Architecture
          ├── Database
          ├── Performance
          ├── Tests
          ├── Documentation
          └── etc.
          │
          ▼
      SANDBOX RUNNER
          │
          ├── Build
          ├── Unit tests
          ├── Integration tests
          ├── E2E
          └── Runtime evidence
          │
          ▼
     QUALITY ENGINE
          │
          ▼
      POLICY ENGINE
          │
          ▼
      QUALITY REPORT
          │
       ┌──┴──┐
       ▼     ▼
     PASS   FAIL
       │     │
       ▼     ▼
   APPROVED  PR COMMENT
                 │
                 ▼
          AGENTE ORIGINAL
                 │
                 ▼
               PUSH
                 │
                 ▼
            NUEVA AUDITORÍA
3. Responsabilidades
3.1 Quality Orchestrator

Es el cerebro del workflow.

Responsabilidades:

Recibir eventos de GitHub.
Crear auditorías.
Obtener contexto de la PR.
Determinar qué ejecutar.
Coordinar auditores.
Coordinar Sandbox.
Esperar resultados.
Consolidar resultados.
Aplicar políticas.
Decidir PASS/FAIL.
Publicar resultado.
Gestionar re-ejecuciones.

No debe contener lógica específica de Java, Angular, Python, etc.

4. Auditorías IA

El sistema debe utilizar un modelo de auditoría modular.

No crear un único agente gigante para todo.

Conceptualmente:

                 CORE AUDITOR
                      │
       ┌──────────────┼──────────────┐
       ▼              ▼              ▼
     Global          Stack         Project
     Rules           Rules         Rules
       │              │              │
       └──────────────┼──────────────┘
                      ▼
               Project Policy
Auditorías iniciales
Code Quality

Detecta:

bugs potenciales;
código muerto;
duplicación;
complejidad;
errores de diseño;
malas prácticas;
problemas de mantenibilidad.
Security

Detecta:

secretos;
vulnerabilidades;
validación insuficiente;
autorización incorrecta;
injection;
exposición de información;
dependencias vulnerables;
configuraciones inseguras.
Architecture

Detecta:

violaciones de arquitectura;
acoplamiento excesivo;
dependencias incorrectas;
responsabilidades mal ubicadas;
violaciones de patrones definidos.
Database

Detecta:

migraciones problemáticas;
queries ineficientes;
índices faltantes;
problemas de integridad;
cambios peligrosos de schema.
Testing

Evalúa:

tests existentes;
cobertura relevante;
casos faltantes;
tests frágiles;
comportamiento no cubierto.
Performance

Se ejecuta cuando sea relevante.

Documentation

Se ejecuta cuando corresponda según los cambios.

5. Selección automática de auditorías

No ejecutar siempre todas las auditorías.

El sistema debe analizar:

archivos modificados;
lenguaje;
framework;
estructura;
dependencias;
configuración;
tipo de cambio;
políticas del proyecto.

Ejemplo:

PR modifica:

src/payment/PaymentService.java
src/payment/PaymentController.java
migration/V42__payments.sql

↓

Detecta:

Java
Spring Boot
Database migration
API

↓

Ejecuta:

Code
Security
Architecture
Database
Tests
Runtime

La configuración será:

Declarativa por proyecto + detección automática de auditorías relevantes.

6. Severidades

Todas las findings deben tener una severidad:

CRITICAL
HIGH
MEDIUM
LOW
INFO

Las severidades son configurables mediante policies.

Ejemplo
policies:
  block_on:
    - CRITICAL
    - HIGH

  comment_only:
    - MEDIUM
    - LOW
    - INFO

Una sugerencia estética nunca debería bloquear una PR por defecto.

7. Policy Engine

El Policy Engine determina qué significa cada finding para el proyecto.

Ejemplo:

quality:
  block_on:
    - CRITICAL
    - HIGH

security:
  block_on:
    - CRITICAL
    - HIGH

tests:
  require_pass: true

e2e:
  required: true

coverage:
  minimum: 80

Las policies deben poder configurarse por proyecto.

No hardcodear reglas específicas del cliente dentro del código.

8. Sandbox Runner
8.1 Objetivo

El Sandbox permite levantar y probar cada proyecto en un entorno aislado y efímero.

Responsabilidad:

Ejecutar y observar.

No decide si algo es un problema de calidad.

El Sandbox responde:

"Esto pasó."

El Auditor responde:

"Esto significa que hay un problema."

9. Sandbox — arquitectura

Durante desarrollo:

Developer Machine
       │
       ▼
Docker
       │
       ▼
Sandbox Runner
       │
   ┌───┴────┐
   ▼        ▼
Sandbox  Sandbox
   #1       #2

En producción:

Quality Platform
       │
       ▼
    Job Queue
       │
       ▼
  Sandbox Worker
       │
       ▼
Ephemeral Sandbox

El Runner debe ser portable.

La implementación local y la producción deben utilizar el mismo concepto de worker.

10. Aislamiento del Sandbox

Cada ejecución debe ser:

efímera;
aislada;
destruible;
con filesystem propio;
limitada por CPU;
limitada por RAM;
limitada por disco;
limitada por tiempo;
con red restringida.
Red

La red debe estar:

bloqueada por defecto.

Cuando un proyecto necesita servicios externos, se deben declarar explícitamente.

No asumir que código arbitrario de una PR puede acceder libremente a Internet.

11. Servicios del proyecto

Un proyecto puede requerir:

Application
 ├── PostgreSQL
 ├── Redis
 ├── Kafka
 └── otros servicios

El Sandbox debe poder levantar servicios auxiliares.

Preferentemente puede aprovechar el docker-compose.yml del proyecto cuando sea compatible, pero debe:

inspeccionarlo;
aplicar límites;
restringir networking;
evitar privilegios innecesarios;
impedir acceso al host.
12. Execution Profiles

Cada proyecto tendrá un Execution Profile.

Ejemplo:

profile: spring-production

runtime:
  java: 21
  maven: 3.9

services:
  postgres:
    image: postgres:17

  redis:
    image: redis:8

commands:
  build: "./mvnw clean package"
  test: "./mvnw test"
  e2e: "./mvnw verify"

limits:
  cpu: 4
  memory: 8GB
  timeout: 15m

network:
  mode: restricted

El sistema debe poder:

Detectar automáticamente el stack.
Crear un profile inicial.
Permitir modificarlo.
Guardarlo por proyecto.
Versionarlo opcionalmente.
13. Detección de stack

Detectar automáticamente archivos como:

pom.xml
build.gradle
package.json
pnpm-lock.yaml
yarn.lock
requirements.txt
pyproject.toml
Dockerfile
docker-compose.yml
go.mod
Cargo.toml

Ejemplo:

pom.xml
Dockerfile
docker-compose.yml

↓

Java
Spring Boot
Maven
Docker
PostgreSQL/otros servicios según compose

La detección no debe ser exclusiva de una tecnología.

El sistema debe estar preparado para:

Java;
Spring Boot;
Node.js;
Angular;
React;
Next.js;
Python;
FastAPI;
Go;
etc.
14. Ejecución del Sandbox

Un job recibe aproximadamente:

{
  "projectId": "project-123",
  "repository": "repository-url",
  "commit": "a81f92c",
  "branch": "feature/payment",
  "executionProfile": "spring-production"
}

El Runner:

1. Obtiene commit
2. Crea sandbox
3. Clona/prepara repository
4. Instala dependencias
5. Levanta servicios
6. Ejecuta build
7. Ejecuta unit tests
8. Ejecuta integration tests
9. Ejecuta E2E si corresponde
10. Captura logs
11. Captura artifacts
12. Genera resultado
13. Destruye sandbox
15. Resultado del Sandbox

Ejemplo:

{
  "status": "FAILED",

  "build": {
    "status": "PASSED"
  },

  "tests": {
    "status": "FAILED",
    "passed": 127,
    "failed": 2
  },

  "e2e": {
    "status": "PASSED"
  },

  "executionTime": 184,

  "logs": "...",

  "artifacts": []
}

El resultado debe ser estructurado.

No depender únicamente de texto libre.

16. Runtime Evidence

El Sandbox debe devolver evidencia para que los auditores puedan analizarla:

logs;
stack traces;
test failures;
HTTP responses;
screenshots de E2E;
videos de E2E cuando corresponda;
coverage;
build output;
artifacts;
métricas de ejecución.

Esto permite que la IA razone sobre hechos reales y no solamente sobre el código.

17. E2E

Ejemplo:

Angular
   │
   ▼
Spring Boot
   │
   ├── PostgreSQL
   └── Redis

        │
        ▼
     Browser
        │
        ▼
    Playwright

El sistema puede detectar:

"El backend compila y los unit tests pasan, pero el flujo de login falla desde el frontend."

Esto debe convertirse en evidencia para el Quality Report.

18. Quality Engine

El Quality Engine combina:

Static Analysis
      +
AI Audits
      +
Sandbox
      +
Tests
      +
E2E
      +
Security
      +
Runtime Evidence

Produce un conjunto unificado de findings.

Ejemplo:

{
  "severity": "HIGH",
  "type": "TEST_FAILURE",
  "title": "Refund endpoint returns HTTP 500",
  "file": "src/payment/PaymentService.java",
  "test": "shouldRefundPayment",
  "message": "Expected 200 but received 500",
  "evidence": "...",
  "suggestedFix": "..."
}
19. Quality Report

El Quality Report es la representación final de una auditoría.

Debe contener:

Audit
├── status
├── commit
├── duration
├── auditors
├── sandbox execution
├── findings
├── policies evaluated
└── final decision

Resultado:

PASS

o:

FAIL
20. GitHub Integration

El sistema debe integrarse con GitHub.

Eventos relevantes:

PR opened
PR synchronize
PR reopened
PR closed

Cuando hay un nuevo commit:

PR synchronize
      │
      ▼
Quality System
      │
      ▼
New Audit
21. Comentarios en PR

Cuando hay FAIL, publicar un comentario claro.

El comentario debe contener:

Quality System — FAILED

2 problemas encontrados

🔴 HIGH
PaymentService.java:84

El método puede devolver HTTP 500
cuando ...

Evidence:
...

Suggested solution:
...

🔴 HIGH
...

Tests:
127 passed
2 failed

No llenar la PR con cientos de comentarios individuales si pueden agruparse.

Preferir un comentario consolidado o comentarios identificables y actualizables.

22. Agente de desarrollo

El agente original sigue siendo responsable de modificar código.

El Quality System:

NO:
- modifica código;
- hace commits;
- hace push;
- implementa fixes automáticamente.

Sí:

- detecta;
- explica;
- propone;
- comenta;
- revalida.
23. Re-auditoría

Cuando el agente hace:

git push

GitHub genera:

pull_request.synchronize

El Quality System vuelve a ejecutar la auditoría.

No asumir que el problema anterior fue solucionado.

Se debe evaluar nuevamente el estado actual del commit.

24. Historial

Cada auditoría debe estar asociada a:

Project
Repository
Pull Request
Commit
Audit
Findings
Sandbox Execution
Policy Evaluation

Ejemplo:

PR #123

Commit A
  Audit #1
  FAIL
  3 findings

Commit B
  Audit #2
  FAIL
  1 finding

Commit C
  Audit #3
  PASS

Esto permite tener trazabilidad completa.

25. Estados
Audit
QUEUED
RUNNING
PASSED
FAILED
ERROR
CANCELLED
TIMEOUT
Sandbox Job
QUEUED
PROVISIONING
CLONING
INSTALLING
BUILDING
TESTING
E2E
COLLECTING
COMPLETED
FAILED
TIMEOUT
DESTROYING
26. Concurrencia

El sistema debe estar preparado para múltiples PRs simultáneas.

Ejemplo:

PR #101 ──► Sandbox Worker #1
PR #102 ──► Sandbox Worker #2
PR #103 ──► Queue
PR #104 ──► Queue

El Orchestrator no debe bloquearse esperando una ejecución.

Debe utilizar jobs/eventos asíncronos.

27. Seguridad

Prioridad alta.

El sistema ejecutará código potencialmente no confiable proveniente de PRs.

Por lo tanto:

no ejecutar directamente en el host;
no montar Docker socket del host dentro del sandbox;
no exponer secretos;
no reutilizar filesystem entre ejecuciones;
no permitir privilegios innecesarios;
limitar CPU;
limitar RAM;
limitar disco;
limitar tiempo;
restringir networking;
destruir sandbox después de cada ejecución;
auditar todas las ejecuciones.

La arquitectura de aislamiento debe poder evolucionar posteriormente de Docker hacia mecanismos más fuertes como VMs/microVMs si el producto lo requiere.

28. Arquitectura lógica inicial

Proponer inicialmente estos módulos:

quality-system/
│
├── orchestrator/
├── github-integration/
├── project-service/
├── audit-engine/
├── policy-engine/
├── sandbox-runner/
├── execution-profile/
├── ai-agents/
├── quality-engine/
├── event-bus/
├── persistence/
└── api/

No asumir microservicios independientes desde el primer commit.

Para MVP puede ser un modular monolith con workers separados donde sea necesario.

La separación debe existir conceptualmente aunque inicialmente algunos módulos estén en el mismo proceso.

29. Principio de diseño

No sobre-ingenierizar el MVP.

Prioridad:

1. GitHub PR
2. Orchestrator
3. Sandbox
4. Tests
5. Auditor IA
6. Policies
7. PR comments
8. Re-audit
9. Historial
10. Escalabilidad

Primero hacer funcionar correctamente el ciclo:

PR
 ↓
Audit
 ↓
Sandbox
 ↓
FAIL
 ↓
Comment
 ↓
Push
 ↓
Audit
 ↓
PASS
30. MVP

El MVP mínimo debe soportar:

GitHub
repository;
PR;
commits;
webhook;
comments;
checks/status.
Stack inicial

Priorizar:

Java / Spring Boot
Node.js
Angular / React
Python
Docker
Sandbox
Docker;
CPU limit;
RAM limit;
timeout;
filesystem aislado;
network restricted;
build;
tests;
logs;
cleanup.
IA

Inicialmente:

Code Quality;
Security;
Architecture;
Tests.
Policies
severities;
block/pass;
configuración por proyecto.
Resultado
PASS
FAIL
ERROR
PR
comentario consolidado;
resultado;
findings;
evidencia;
suggested fixes.
31. Lo que NO implementar inicialmente

No implementar de entrada:

auto-fix;
agentes que hagan commits;
despliegue automático a producción;
Kubernetes;
multi-cloud;
marketplace de plugins;
decenas de proveedores LLM;
billing;
multi-tenancy complejo;
optimizaciones prematuras.

Primero demostrar que el ciclo de calidad funciona de extremo a extremo.

32. Criterio de éxito del MVP

El sistema debe poder hacer esto de forma autónoma:

1. Developer/AI Agent abre PR.
2. GitHub notifica al Quality System.
3. Quality System identifica el proyecto.
4. Detecta stack.
5. Obtiene Execution Profile.
6. Determina auditorías.
7. Levanta Sandbox.
8. Ejecuta build.
9. Ejecuta tests.
10. Ejecuta auditorías IA.
11. Consolida resultados.
12. Aplica policies.
13. Publica PASS o FAIL.
14. Si FAIL, comenta problemas en la PR.
15. Agente original lee el comentario.
16. Agente modifica código.
17. Agente hace push.
18. GitHub dispara nueva ejecución.
19. Quality System vuelve a validar.
20. Cuando cumple las policies, marca PASS/APPROVED.
33. Instrucción para el agente de implementación

Implementar este proyecto desde cero siguiendo esta especificación.

Antes de escribir código:

Analizar la arquitectura.
Proponer stack tecnológico.
Proponer estructura del repositorio.
Identificar decisiones que requieran confirmación.
Definir contratos entre módulos.
Definir modelo de datos.
Definir eventos.
Definir API.
Definir estrategia del Sandbox.
Definir estrategia de integración con GitHub.

Después comenzar por el vertical slice completo del MVP, no por construir todos los módulos aisladamente.

El primer objetivo debe ser:

GitHub PR
   ↓
Webhook
   ↓
Quality Orchestrator
   ↓
Sandbox
   ↓
Build/Test
   ↓
Simple AI Audit
   ↓
Quality Report
   ↓
PASS/FAIL
   ↓
GitHub PR Comment

Una vez que ese flujo funcione end-to-end, agregar progresivamente:

políticas;
múltiples auditores;
Execution Profiles;
E2E;
historial;
concurrencia;
escalabilidad;
seguridad avanzada.
34. Regla de oro

No convertir el proyecto en un "AI coding agent".

El producto es un:

AI-powered Quality System para agentes y equipos de desarrollo.

El agente desarrolla.

El Quality System verifica.

El Sandbox demuestra qué ocurrió realmente.

Las Policies determinan qué se acepta.

El ciclo se repite hasta obtener una PR que cumpla las reglas.