# Comandos del framework

Referencia para personas. Esto es lo que le podés escribir a Claude Code en un proyecto que usa el framework, y qué va a pasar en cada caso. (Los detalles finos del protocolo viven en `.claude/skills/`; esto es el mapa.)

> Requisito: haber autenticado el conector una vez con `/mcp`. Si algo falla con "unauthorized", empezá por ahí.

## Trabajar tareas

| Comando | Qué hace |
|---|---|
| `/work` | Muestra tu cola de trabajo (tareas asignadas a vos o libres, desbloqueadas, con criterios de aceptación) y te pregunta cuál tomar. |
| `/work #12` | Trabaja la tarea 12: contexto → plan (comentario en la tarea) → tus respuestas a las preguntas → implementación → revisión → tests según rigor → cierre con comentario, tiempo y tokens. |
| `/work US-3` | Trabaja todas las tareas pendientes de la historia 3, en orden de dependencias, con un subagente fresco por tarea. Las preguntas se juntan al principio. |
| `/work --board` | Trabaja la cola del tablero hasta el límite (por defecto: una historia o 5 tareas, lo que llegue primero). |
| `/work --board --limit 10` | Igual, con otro límite. Subirlo mucho es una decisión, no un default: los errores en lote se propagan y 25 planes juntos no los lee nadie. Lo sano: de a una historia al principio del proyecto, por fase cuando el esqueleto está firme. |
| `/work --phase "Sitio público"` | Trabaja una fase entera: todas sus historias pendientes en orden de tablero, y al final las tareas sueltas de la fase (las que no cuelgan de ninguna historia). |
| `/work --phase 1` | Lo mismo, por posición en el tablero (1-based). El nombre se puede escribir sin tildes y en cualquier capitalización. Si hay más de una candidata, o ninguna, te muestra las opciones y pregunta: nunca adivina. |
| `/work --epic "Admin"` | Igual que `--phase`, para un épico. Por nombre solamente: los épicos no tienen posición visible. |

**Antes de tocar nada, `--phase` y `--epic` te muestran el alcance resuelto y esperan un OK explícito** — "Fase 'Sitio público' (posición 1): 8 historias pendientes (US-2…US-9), 3 tareas sueltas, ~19 tareas". Ese cartel es lo único que separa un argumento mal tipeado de una noche entera de ramas. Como el alcance ya está acotado por la fase o el épico, `--limit` no hace falta; si lo ponés igual, sigue funcionando como techo.

Una historia cuyas tareas dependen de tareas de **afuera** del alcance se trabaja hasta donde la cola deja y queda *parcialmente bloqueada*, con un comentario que nombra la dependencia externa. No se trae la tarea de afuera al lote: el límite lo pusiste vos. Y el reporte final de estos dos modos viene **agrupado por historia**, con el estado de cada una (DONE / parcialmente bloqueada / salteada), que es la lectura que sirve a la mañana.

Reglas que valen siempre, en cualquier modo: nunca implementa sobre una pregunta abierta (la deja en la tarea y sigue con otra o se frena); nunca mergea; una tarea sin criterios de aceptación en su historia no entra; si cortás la sesión con una tarea abierta, el guard de cierre te va a pedir completar el cierre antes de terminar.

## Adoptar un proyecto existente

Para un repo que ya existe y tiene historia, `/adopt` se corre **una sola vez**, después de crear el proyecto en DevManager y correr `init.mjs`.

| Comando | Qué hace |
|---|---|
| `/adopt` | Corre el protocolo canónico de adopción de la organización — la skill `adopt-lite` del baseline, que el conector de DevManager sirve como prompt — y al terminar agrega los dos pasos propios del framework: `/sync-docs` y la verificación de que el template esté aplicado (`init.mjs` hecho, hooks activos). |

**El protocolo no vive en este repo.** Vive en el baseline de la organización, una sola vez, y así se actualiza en un solo lugar para todos los proyectos. La skill del repo es un envoltorio: apunta al protocolo y lo sigue tal cual. Si el baseline de la organización no tiene skill de adopción, `/adopt` se frena y te lo dice, en vez de improvisar una versión propia.

Qué hace `adopt-lite`, en corto: lee el código, te entrevista sobre lo que el código no puede contestar, escribe los documentos del proyecto, propone las decisiones fundacionales y crea un backlog hacia adelante, mostrando cada escritura antes de mandarla. **Sentate al lado: la entrevista es el paso que decide si los documentos son verdad.** El detalle fino —qué pregunta, qué no hace, qué pasa si te vas a la mitad— está en la skill del baseline, que es la fuente; leelo ahí y no acá, para que no haya dos versiones que se contradigan.

Los dos pasos que agrega el framework al final:

1. **`/sync-docs`**, para que el repo tenga la copia generada de lo que se acaba de escribir en DevManager.
2. **Verificar el template**: id del proyecto en `CLAUDE.md` y sección administrada llena, `.mcp.json` apuntando a DevManager, el hook `Stop` conectado a `stop-guard.mjs`, skills y agentes en su lugar, `.gitignore` con el bloque del framework, y los comandos de test/lint/typecheck/build de `settings.json` cambiados por los de este proyecto. Lo que falte sale nombrado en el traspaso, no parcheado en silencio.

Las decisiones quedan *propuestas* hasta que un ADMIN las acepte. Después de `/adopt`, el proyecto se trabaja como cualquier otro: `/work`.

## Documentación

| Comando | Qué hace |
|---|---|
| `/sync-docs` | Baja del DevManager los documentos y decisiones aceptadas del proyecto y regenera `.claude/docs/` y la sección administrada de `CLAUDE.md`. Un commit propio. Los archivos generados no se editan a mano: se edita en DevManager y se vuelve a sincronizar. |

## Pedidos en lenguaje natural que funcionan

No todo necesita comando. Con el conector activo, estas frases hacen lo esperable:

- "listá mis tareas de este proyecto" / "qué hay en la cola"
- "mostrame la tarea #12" / "qué dice la historia US-3"
- "proponé una decisión: …" (queda como propuesta; la acepta un admin)
- "actualizá el documento de dominio con esto que te expliqué" (te muestra el texto antes de escribir)
- "cargá 30 minutos míos en la #12" (tiempo humano; el de agente se carga solo)

## Qué NO va a hacer aunque se lo pidas

- Aceptar decisiones o historias si no sos ADMIN (y siendo ADMIN, te va a pedir confirmación explícita).
- Cerrar una tarea sin comentario de cierre y tiempo cargado (lo exige el servidor, no la buena voluntad).
- Inventar cifras de tokens: si no se pudieron medir, la entrada va sin tokens.
- Borrar cosas: no existen herramientas de borrado por MCP. Eso es siempre en la interfaz.

## Si algo se traba

- Tarea bloqueada con preguntas → las respuestas van como respuesta al comentario en DevManager o acá; después `/work #n` de nuevo.
- Conflicto de versión al editar un doc → alguien lo tocó en el medio; Claude te muestra la versión actual y rehace el cambio sobre esa.
- El guard de cierre bloquea y tenés que irte ya → decile a Claude "marcá la #n como bloqueada con lo que falta" y el cierre queda honesto.
