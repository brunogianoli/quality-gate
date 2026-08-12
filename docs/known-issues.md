# Problemas conocidos

Hallazgos que salieron de las revisiones durante la construcción y se decidió no
arreglar en ese momento. Ninguno rompe la suite ni impide publicar la Action.
Están ordenados por lo que más conviene atender primero.

La referencia completa —quién lo encontró, en qué tarea y con qué evidencia—
está en el historial de git de la rama `feat/quality-gate`.

## Atender pronto

Nada pendiente: los cuatro hallazgos de esta sección están resueltos y
registrados abajo.

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

**El sistema ya corrió entero, contra PRs reales de este repositorio.** El
criterio de éxito del spec está cumplido: la PR #4 recibió `FAIL` con dos
findings sobre un bug plantado, un push con el arreglo la llevó a `PASS`, y el
comentario se editó en lugar de duplicarse.

Esas corridas encontraron tres defectos que ninguna suite unitaria había
detectado, todos ya resueltos: el `PASS` sin verificación, el input vacío que
mandaba el tráfico al proveedor equivocado, y el ruido de severidad de los
auditores.

Lo que falta ahora es distinto y más incómodo: **nada protege la calibración de
los prompts.** `tests/golden/cases.ts` prueba `decide()` con findings escritos a
mano; ningún test toca los prompts. El ruido que se corrigió en `_shared.md` se
descubrió con un sondeo manual contra la API, y ese sondeo no quedó como red de
seguridad: un cambio futuro en ese archivo puede reintroducir findings HIGH sobre
código correcto sin que falle nada.

Hace falta un golden set de prompts: casos fijos con llamadas reales, corriendo
aparte como la suite de integración, que afirme propiedades estables — sobre un
cambio limpio, cero bloqueantes; sobre un secreto commiteado, al menos un
CRITICAL. Sin eso, el invariante de los falsos positivos depende de que alguien
se acuerde de mirar.

Tampoco se probó `scope` contra un diff que mezcla temas después de la
calibración. Ahí fue donde alucinó (afirmó que el cambio declarado no estaba en
el diff); la regla de citar evidencia apunta a eso, pero no está verificada.

El criterio de éxito del spec sigue sin cumplirse: abrir una PR de verdad en el
repositorio fixture, ver el gate correr solo, comentar el `FAIL`, y que un push
que arregle el test lo lleve a `PASS`. Eso requiere la Action publicada en GitHub
y una API key, y es donde se va a ver si los auditores aciertan o generan ruido —
que es la única pregunta que define si este sistema sirve.

## Resueltos

Los cuatro primeros salieron de las revisiones durante la construcción. Los
cuatro últimos aparecieron corriendo el gate contra PRs reales, que es donde se
ven las cosas que los mocks no muestran.

- **Un `PASS` no exigía que ningún auditor hubiera corrido.** La API rechazó la
  key, los cuatro auditores fallaron con 401, y el gate publicó 🟢 PASSED y
  habilitó el merge sin que nadie mirara el código. Ahora eso degrada a `ERROR`
  (check neutral, no bloquea). Un `FAIL` por build, tests o findings no degrada:
  se sostiene con evidencia propia.
- **Un input vacío de la Action pisaba su valor por defecto.** GitHub Actions
  exporta `INPUT_<NOMBRE>` para todo input declarado aunque el workflow no lo
  pase, como cadena vacía, y `??` no la cubre. El `baseURL` quedaba en `''`, el
  SDK caía a `api.anthropic.com` y la key de DeepSeek parecía la culpable.
- **Los auditores no tenían escala de severidad**, así que la inventaban:
  `infrastructure` produjo tres HIGH bloqueantes cuyo propio texto decía que el
  código estaba bien, y el mismo prompt daba resultados distintos entre corridas.
  `agents/_shared.md` define la escala atada a consecuencia, declara que concluir
  que algo es correcto no es un finding, y exige citar la línea del diff.
- **El mismo defecto contaba dos veces.** Dos auditores reportaron el mismo bug
  con una línea de diferencia y el comentario mostró dos problemas.
  `dedupeFindings` los colapsa por archivo, severidad y proximidad.
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
- **El fixture no estaba conectado a ningún test.** `tests/integration/fixture.test.ts`
  lo copia a un directorio temporal y corre el pipeline determinista de verdad
  (`detectStack` → `runStack` → `decide`) en tres escenarios: el fixture sano
  (`PASS`), con un bug de runtime en `divide` (compila, tests en rojo, `FAIL`) y
  con un error de tipos (corta en el build sin llegar a los tests, `FAIL`).
  Necesita red y tarda ~1 minuto, así que corre con `npm run test:integration` y
  en su propio job de CI, fuera de `npm test`.
- **El timeout y el reintento eran los del SDK.** La política ahora declara
  `timeout_ms` (5 minutos) y `max_retries` (1), pisables por auditor, y
  `runAuditor` los pasa como opciones de la llamada en vez de heredar los
  defaults del SDK (10 minutos, 2 reintentos). El backoff exponencial sigue
  siendo el del SDK. El tercer punto que el spec pedía en la misma frase,
  `concurrency: cancel-in-progress`, ya estaba en el workflow del README.
