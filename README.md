# AI Quality Gate

Audita cada Pull Request con auditores de IA especializados y bloquea el merge
hasta que pase. Ejecuta el build y los tests del proyecto, revisa el cambio, y
publica un veredicto. **Nunca modifica código**: comenta y espera a que quien
abrió la PR corrija.

## Instalación

1. Agregá `ANTHROPIC_API_KEY` a los secrets del repositorio
   (Settings → Secrets and variables → Actions).

2. Creá `.github/workflows/ai-quality-gate.yml`:

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
        with:
          fetch-depth: 0        # necesario para calcular el diff de la PR
      - uses: brunogianoli/quality-gate@v1
        with:
          anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}
```

3. Para que el gate bloquee de verdad, marcá el check **AI Quality Gate** como
   requerido en Settings → Branches → Branch protection rules.

## Configuración

La política por defecto está en `policies/default.yaml` de esta Action. Para
cambiarla en un repo, creá `.ai/policy.yaml` — los campos que definas pisan los
del default, el resto se hereda:

```yaml
min_confidence: 0.8        # más estricto: menos findings bloquean
timeout_ms: 300000         # por auditor, no por corrida
max_retries: 1             # ante 429 y 5xx, con backoff exponencial

auditors:
  security:
    model: claude-opus-5   # un modelo más capaz sólo para este auditor
    timeout_ms: 600000     # y más tiempo, porque piensa más
```

Si un auditor se pasa del timeout, su llamada falla y el comentario lo informa
como resultado parcial: el veredicto degrada a `ERROR`, que no bloquea el merge.

## Criterios de aceptación

El auditor `acceptance` compara el código contra lo que la tarea pedía. Los
busca en este orden:

1. El issue que la PR cierra (`Closes #42`) — la fuente preferida: el criterio
   es previo al código.
2. La descripción de la PR.
3. Si no hay ninguno, `acceptance` no corre y el comentario lo dice.

## Limitación conocida

Las PRs desde un *fork* no reciben secrets, así que el gate no puede correr
sobre ellas.
