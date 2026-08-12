# Problemas conocidos

Hallazgos que salieron de las revisiones durante la construcción y se decidió no
arreglar en ese momento. Ninguno rompe la suite ni impide publicar la Action.
Están ordenados por lo que más conviene atender primero.

La referencia completa —quién lo encontró, en qué tarea y con qué evidencia—
está en el historial de git de la rama `feat/quality-gate`.

## Atender pronto

### El fixture no está conectado a ningún test

`fixture/` es un repo Node/TS completo, con sus tests y su build. El spec lo
define como el banco de pruebas ejecutable del sistema. Pero el golden set usa
objetos `RunnerResult` escritos a mano y **nunca invoca `detectStack` ni
`runStack` sobre el fixture**. Hoy es decoración: nada verifica que el gate
funcione de punta a punta contra un repositorio real, ni siquiera uno de juguete.

### La política se valida, pero el timeout y el reintento son los del SDK

El spec pide timeout por auditor y un reintento con backoff. No están
implementados de forma explícita: el comportamiento depende de los valores por
defecto del SDK de Anthropic. Es una degradación razonable, no un vacío, pero es
una diferencia con lo que el spec declara.

## Aceptables

Fallan hacia el lado seguro o su impacto es acotado.

- **Los patrones de `auth_changed` y `endpoints_changed` no usan límites de
  palabra**, así que sobre-disparan: `AUTHORS.md` activa el auditor de seguridad,
  `Resources.java` el de endpoints. Falla hacia auditar de más, nunca hacia
  omitir.
- **`runCommand` usa `shell: true`.** Sin riesgo hoy, porque los comandos son
  constantes de `stack.ts` y no vienen del repositorio auditado. A tener presente
  si algún día los comandos salieran de un archivo de configuración del repo.
- **El truncado de salida puede partir un carácter multibyte** en el límite de un
  chunk, insertando un carácter de reemplazo en logs con acentos o emojis.
- **En PRs chicas el caché no se activa.** El mínimo cacheable de
  `claude-sonnet-5` es 1024 tokens; si el contexto compartido no lo alcanza, el
  `cache_control` no falla, simplemente no cachea nada y no avisa. El ahorro
  proyectado aplica a PRs medianas y grandes.
- **Huecos de cobertura menores:** la rama de `main()` que maneja un evento que no
  es `pull_request`; el camino positivo del guard de entrypoint (validado a mano,
  automatizarlo exige lanzar un proceso hijo); el caso de un comentario con cuerpo
  indefinido; el quinto encabezado de los prompts (`WHAT IS NOT YOUR JOB`) que el
  test no verifica.
- **Si la llamada del auditor que ceba el caché falla, nadie lo ceba.** El turno
  de cebado se le da al primer auditor con prompt, pero si esa llamada muere con
  un 503 el bloque compartido no se escribió y el resto sale en paralelo pagando
  la escritura entera. No se reintenta con el siguiente a propósito: serializar
  otra llamada más cuesta latencia en todas las corridas para cubrir un caso
  raro, y el impacto es de costo, no de correctitud.
- **El bundle pesa 1.1 MB** y esbuild emite un aviso de tamaño en cada build.
  Incluye el SDK de Anthropic y Octokit enteros. No hay política de tamaño
  definida para el proyecto.

## Lo que falta de verdad

Nada de lo anterior es lo más importante. **El sistema nunca habló con la API de
Anthropic ni con GitHub.** Los 112 tests corren con ambas mockeadas, que es lo
correcto para una suite unitaria, pero significa que sabemos que las piezas
encajan entre sí, no que funcionan contra el mundo real.

El criterio de éxito del spec sigue sin cumplirse: abrir una PR de verdad en el
repositorio fixture, ver el gate correr solo, comentar el `FAIL`, y que un push
que arregle el test lo lleve a `PASS`. Eso requiere la Action publicada en GitHub
y una API key, y es donde se va a ver si los auditores aciertan o generan ruido —
que es la única pregunta que define si este sistema sirve.

## Resueltos

- **Los límites de paginación de la API de GitHub no se manejaban.**
  `src/context.ts` pedía `per_page: 300` a `pulls.listFiles` (el máximo real es
  100, así que truncaba el diff en silencio) y `src/report.ts` listaba
  comentarios sin paginar (podía no encontrar el marcador y crear un comentario
  nuevo por corrida). Ambos paginan ahora, cortando en la primera página
  incompleta; `upsertComment` además corta apenas encuentra el marcador.
- **El cebado del caché dependía de la posición en el array.** Si `names[0]` no
  tenía prompt, el turno de cebado se gastaba en un auditor que nunca llamaba a
  la API. `runAuditors` ahora descarta primero los auditores sin prompt y le da
  el turno al primero que sí lo tiene.
