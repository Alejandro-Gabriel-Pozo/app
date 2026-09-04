# Programa de auditoría end-to-end de completitud del ERP — v2

**Versión:** 2.0 · **Fecha:** 02/09/2026
**Reemplaza a:** `docs/programa-auditoria-completitud-erp-2026-09-01.md` (v1.0, borrador)
**Alcance de este documento:** el método. Los resultados están en
`10-matriz-maestra.md`, `fichas/` y `datos/`.

---

## 0. Qué cambia respecto de v1 y por qué

v1 era un buen marco conceptual y un mal programa ejecutable. Las siete
diferencias, en orden de impacto:

| # | Problema de v1 | Qué hace v2 |
|---|---|---|
| 1 | El inventario de módulos era **inventado** ("inventario de trabajo, no hechos"). Varias de sus filas no existen como módulo en este producto y faltan seis que sí existen. | El inventario se **deriva del código** (§2) y queda como CSV re-generable. |
| 2 | Pedía "verificá" sin decir **cómo**. Un agente en automode produce prosa plausible, no evidencia. | Capa mecánica (§3): cuatro extractores que producen los hechos base, con invariantes chequeables. |
| 3 | No definía **unidad de entrega**, así que una corrida larga se pierde entera si se corta. | Un archivo por módulo, escrito al cerrar cada módulo (§5.3). Se puede retomar. |
| 4 | `[V]` no obligaba a citar. "Verificado en código" sin ancla no es verificable. | `[V]` exige `archivo:linea` **que resuelva**; hay validador (§4.2). |
| 5 | Auditaba **sólo lo que existe**. Un ERP incompleto se nota sobre todo en lo que no está. | Dimensión nueva: capacidades ausentes (§6.8). |
| 6 | No se cruzaba con `pendientes-*.md` ni con el roadmap → se re-descubre lo ya sabido y se pierde lo ya decidido. | Toda brecha se marca `nuevo`, `↔` o `⊃` contra un ID existente (§7). |
| 7 | El encargo terminaba en "no toques nada", sin **condición de fin**. | Criterio de terminación por módulo y por corrida (§5.4). |

Lo que **se conserva** de v1, porque estaba bien: el principio rector, la
separación `[V]`/`[P]`/`[H]`, los estados de evaluación, la escala de severidad
por impacto empresarial y la ficha por flujo.

---

## 1. Principio rector

Una funcionalidad no está completa porque tenga pantalla, endpoint o test en
verde. Está completa cuando el usuario puede ejecutar el objetivo de negocio de
punta a punta y el sistema conserva una representación coherente, auditable y
recuperable de lo ocurrido.

> Un ERP completo no sólo registra una operación: la identifica, la ejecuta, la
> documenta, la relaciona, la audita, permite corregirla y la refleja en los
> saldos, reportes e integraciones que correspondan.

Esto **no** es una auditoría de calidad de código. El código, los tests y la UI
son fuentes de evidencia; el objeto es la completitud empresarial.

**Corolario operativo:** el mayor riesgo de esta auditoría no es dejar de
encontrar brechas — es *inventarlas*, o *declarar cerrado* lo que no se miró.
Por eso todo el peso del método está en la evidencia, no en la opinión.

---

## 2. Inventario verificado

El inventario ya no se propone: se deriva. Fuentes, todas re-generables:

- endpoints y su guard → `datos/endpoints.csv` (245 rutas)
- prefijos de montaje → `datos/montajes.csv`
- llamadas del panel → `datos/consumo-frontend.csv`
- cruce backend ↔ frontend → `datos/cobertura.csv`
- tablas → `src/db/schema.sql` (tenant) y `src/db/platform.schema.sql` (plataforma)
- pantallas → `appfrontend-main/src/app/**/page.tsx`

El inventario resultante está en `01-inventario-verificado.md`. Reglas:

1. Un módulo existe si tiene **al menos una** de las tres cosas: router montado,
   tabla propia, pantalla. Los casos de "una sola de las tres" son los más
   interesantes de la auditoría, no los descartes.
2. El ID de módulo de v1 se conserva donde el módulo existe de verdad, para no
   romper referencias. Los agregados siguen la numeración.
3. Un módulo del inventario de v1 que no existe en el producto **no se borra**:
   se marca `— No aplica` con la razón. Su ausencia puede ser una brecha (§6.8).

---

## 3. Capa mecánica — de dónde salen los hechos

Cuatro scripts en `scripts/`, corridos desde `app-main/`. Producen los hechos
base; **no** producen conclusiones.

| Script | Qué produce | Invariante que lo hace confiable |
|---|---|---|
| `extraer-endpoints.sh` | `datos/endpoints.csv` — ruta, método, guard | El total debe igualar el conteo crudo de declaraciones `router.<verbo>(` en `src/**/*.routes.ts`. Hoy: **245 = 245**. Si no coincide, el parser perdió rutas y el resultado no se usa. |
| `extraer-montajes.sh` | `datos/montajes.csv` — prefijo → router | Cubre los dos patrones reales de `app.ts`: montaje directo, y montaje con closure que arma el router por request. |
| `extraer-consumo-frontend.py` | `datos/consumo-frontend.csv` — qué invoca el panel | Sólo cuenta líneas con llamada real (`apiFetch`, `customerApiFetch`, `publicFetch`, `platformFetch`, `fetch(`), no menciones en comentarios. El método sale del `method:` de **esa** llamada — el bloque se cierra por balance de paréntesis — y no del de la línea siguiente. |
| `cruzar-cobertura.py` | `datos/cobertura.csv` — endpoint ↔ consumidor | Un router montado dos veces (p. ej. `user-invitation.routes.ts`, en `/api/users/invitations` y en `/api/invitations`) se considera cubierto si **alguno** de sus caminos tiene consumidor. |

Comando de invariante, para pegar en la ficha:

```bash
grep -rho "router\.\(get\|post\|put\|patch\|delete\)(" --include="*.routes.ts" src | wc -l
```

### 3.1 Límites declarados de la capa mecánica

No sobrevenderla es parte del método:

- `consumidores = "-"` significa **candidato a huérfano**, no huérfano. Dos
  fuentes conocidas de falso positivo: paths armados con query string
  concatenada (`/api/x${qs}`), y llamadas desde código que no matchea los cinco
  nombres de helper. Cada candidato que entra a una ficha se confirma a mano.
- El guard `SIN-GUARD` es correcto sólo para el guard *declarativo*. Hay control
  de acceso real que el parser no ve: `requireCustomerId` dentro del handler,
  `requireModule()` aplicado en el montaje, y el `authenticate()` global de
  `app.ts`. El CSV señala dónde mirar; la ficha lo resuelve leyendo.
- El inventario de tablas no dice si la tabla se usa. Eso se verifica por grep
  por tabla, no por su presencia en el schema.
- **Un archivo que exporta dos routers rompe la asignación de prefijo.**
  `src/facturacion/invoices.routes.ts` exporta `createInvoicesRouter` y
  `createAfipCredentialsRouter`; el cruce le asigna a cada ruta uno de los dos
  prefijos y acierta sólo cuando encuentra consumidor. Efecto conocido: cinco
  filas de `/api/business-profile/afip-credentials/*` en la lista de candidatos
  a huérfano son en realidad rutas de `/api/invoices/*` que **sí** tienen
  consumidor (`appfrontend-main/src/lib/facturacion/api.ts:21`–`:32`). Descontar
  esas cinco antes de citar el número.

---

## 4. Disciplina epistemológica

### 4.1 Las tres marcas

| Marca | Significado | Qué exige |
|---|---|---|
| `[V]` | Hecho verificado | **Obligatorio** `archivo:linea` que resuelva hoy, o comando + salida pegada. Sin ancla no es `[V]`. |
| `[P]` | Decisión o propuesta de diseño | Nombre de quién la aprueba. Mientras no esté aprobada es propuesta, no plan. |
| `[H]` | Hipótesis | Cómo se confirmaría: sistema externo, dato real, validación profesional. |

Reglas duras:

1. Una `[P]` no puede apoyarse en silencio sobre una `[H]`. Si depende, la ficha
   lo dice y ofrece una alternativa que no dependa.
2. **Prohibido el ascenso de marca.** Lo que entró como `[H]` no pasa a `[V]`
   porque después pareció obvio. Pasa con una ejecución, o no pasa.
3. La ausencia de evidencia se escribe como ausencia. "No hay escritura a
   `audit_log` en X" es `[V]` sobre la búsqueda — con el grep pegado — y es `[H]`
   sobre el mundo sólo si la búsqueda pudo haber fallado.
4. Nada de "probablemente", "debería" o "seguramente" en una celda de resultado.
   Si es probable, es `[H]`.

### 4.2 Validador de anclas

`scripts/validar-anclas.py` recorre las fichas, extrae todo `archivo:linea`
citado y verifica que el archivo exista y tenga esa línea. Una ficha con anclas
rotas no se considera entregada.

> Precedente que lo justifica: `DOC-ANCLA-001` en `pendientes-2026-09-01.md` —
> dos rutas mal citadas en documentos que se leen todas las sesiones, las dos
> encontradas por un validador, ninguna por una lectura humana.

**Límite del validador, encontrado ejecutando este mismo programa.** Verifica
que el archivo exista y tenga esa línea; **no** verifica que la línea diga lo
que la ficha afirma. En la primera pasada de `fichas/T03-auditoria.md` cinco
anclas a `src/db/schema.sql` apuntaban a un DDL equivocado y el validador las
dio por buenas: el archivo tiene 3000 líneas, cualquier número resuelve. Por eso
el ancla se obtiene **siempre** de un `grep -n` sobre el patrón, nunca de
memoria ni de un conteo aproximado, y toda tanda de anclas nuevas se contrasta
imprimiendo la línea:

```bash
for a in "src/db/schema.sql:2267" "src/domain/audit.ts:95"; do
  f=${a%:*}; n=${a#*:}; printf "%-40s %s
" "$a" "$(sed -n "${n}p" "$f")"
done
```

---

## 5. Protocolo de ejecución en automode

### 5.1 Qué NO hace la corrida

No toca código, schema, permisos, producción ni commits. No corre migraciones.
No arregla lo que encuentra, ni siquiera lo trivial: un arreglo suelto en medio
de una auditoría deja el mapa desincronizado del árbol. Escribe **sólo** dentro
de `docs/erp-auditoria-v2/`.

### 5.2 Fases

| Fase | Salida | Paralelizable |
|---|---|---|
| F0 · capa mecánica | los cuatro CSV de `datos/` | — |
| F1 · inventario verificado | `01-inventario-verificado.md` | — |
| F2 · transversales | `fichas/T01`…`T05` | sí, entre sí |
| F3 · módulos con plata | `fichas/M04, M05, M10, M06` | no — comparten ledger |
| F4 · módulos de operación | `fichas/M01, M07, M08, M09, M13` | sí |
| F5 · datos maestros y plataforma | `fichas/M02, M03, M11, M12, M14` | sí |
| F6 · síntesis | `10-matriz-maestra.md` + `hallazgos.csv` | — |

Las transversales van **antes** que los módulos, al revés que en v1. Motivo: si
`audit_log` no registra quién ni por qué —y no lo hace, ver `fichas/T03`— esa
respuesta se repite igual en los quince módulos. Auditar primero lo transversal
evita escribir quince veces el mismo hallazgo y deja que cada ficha lo cite.

### 5.3 Unidad de entrega y reanudación

Una ficha se escribe **completa a disco al cerrar el módulo**, nunca al final de
la corrida. Si la sesión se corta o se compacta, lo entregado sigue en disco y
`10-matriz-maestra.md` dice qué falta. Retomar = leer la matriz, buscar la
primera fila sin ficha, seguir por ahí.

### 5.4 Criterio de terminación

Un módulo está **auditado** —que no es lo mismo que completo— cuando:

1. su ficha existe y tiene las quince secciones del esquema (§8);
2. cada afirmación tiene marca;
3. cada `[V]` tiene ancla que resuelve;
4. cada brecha tiene severidad e ID;
5. cada brecha está cruzada contra `pendientes-*` y roadmap (§7).

La corrida termina cuando todas las filas del inventario tienen ficha. **No**
termina cuando se acaban las ideas.

### 5.5 Presupuesto

Guía, no regla: entre 15 y 25 comandos de evidencia por módulo. Un módulo que se
lleva el triple es señal de que hay que partirlo en dos flujos, no de que
merecía más.

---

## 6. Checklist por flujo

Se conservan las seis dimensiones de v1 (§6.1–6.7 acá) y se agregan dos que v1
no tenía. Cada celda se responde con marca y evidencia; **una celda sin
evidencia no se marca completa por inferencia**.

### 6.1 Definición del negocio
Objetivo · actor · evento de inicio · condición de cierre observable · estados ·
caminos alternativos (cancelación, rechazo, no-show, timeout).

### 6.2 Identidad y datos
ID técnico estable · identidad operativa cuando corresponde · dueño y ámbito
(tenant / empresa / sucursal / moneda) · semántica explícita del `NULL` (ausente
≠ pendiente ≠ inválido ≠ no aplica) · datos conservados para explicar la
operación (snapshot) · que no se use UUID como identidad humana.

### 6.3 Operaciones y ciclo de vida
Alta · consulta · modificación gobernada · confirmación o aprobación ·
cancelación · anulación o reversión sin borrar historia · idempotencia ·
tratamiento del fallo parcial.

### 6.4 Documentos, movimientos y saldos
Documento que el negocio necesita · identidad propia del documento · consulta y
reimpresión · movimiento financiero con entidad propia · saldo derivado de
movimientos · corrección que produce movimiento inverso · presencia en reportes
y cierres.

### 6.5 Auditoría y trazabilidad
Quién · cuándo (fecha de negocio **y** de registro) · desde dónde · antes y
después · correlation ID · navegación del efecto al origen · supervivencia del
histórico a cambios de datos maestros.

### 6.6 Permisos y control interno
Quién crea · quién aprueba · quién anula · segregación de funciones · protección
de exportaciones y documentos · motivo obligatorio en acciones privilegiadas.

### 6.7 UX y operación
Loading / vacío / error / no-aplica distinguibles · identidad presentada igual en
todas las pantallas · corrección sin tocar la base · qué se informa cuando falla
una integración · reconstrucción de un caso por soporte · logs, métricas y
alertas.

### 6.8 · NUEVA · Capacidad ausente

Un ERP se juzga también por lo que no tiene. Para cada módulo:

- ¿Qué operación que el negocio hace todos los días **no tiene lugar** en el
  sistema? (se resuelve en papel, por WhatsApp o en una planilla)
- ¿Qué área entera del ERP no existe? (compras y proveedores, tesorería y
  bancos, contabilidad, nómina, activos fijos)
- ¿La ausencia es una decisión tomada o un olvido? Si es decisión, ¿dónde está
  escrita?

Una ausencia deliberada y documentada es `— No aplica`. Una ausencia que nadie
decidió es una brecha, y suele salir más cara que cualquier bug.

### 6.9 · NUEVA · Consistencia del dinero y del tiempo

Transversal a todo módulo que toque plata o fechas:

- moneda explícita en cada monto, y un solo criterio de redondeo;
- signo del movimiento definido en un solo lugar, no en un `CASE` por consulta;
- fecha de negocio distinta de `created_at`, y huso horario resuelto donde se
  decide, no donde se muestra (`docs/conocimiento/playbook-fechas-timezone.md`);
- suma de movimientos == saldo mostrado, con la consulta que lo demuestra.

---

## 7. Cruce obligatorio con lo que ya se sabe

Antes de escribir una brecha, se busca en:

1. el `pendientes-<fecha más alta>.md`,
2. `docs/roadmap-pms-multirubro.md`,
3. los `diseno-*.md` en HOLD.

La brecha se marca:

- **`nuevo`** — no aparece en ninguno de los tres;
- **`↔ <ID>`** — es lo mismo que un ítem ya registrado. Entonces la ficha **no
  lo re-describe**: cita el ID y agrega sólo lo que la auditoría suma (por
  ejemplo, que el ítem existía como bug y además rompe el cierre de otro módulo);
- **`⊃ <ID>`** — lo contiene: el ítem conocido es un caso particular de una
  brecha más grande que recién ahora se ve.

Motivo, del propio historial del proyecto: el roadmap pasó semanas
desactualizado en las dos direcciones y ninguna de sus filas ❌ llegó nunca a un
`pendientes-*`, que es lo único que se lee cada sesión. Una auditoría que no
cruza produce el mismo efecto: un documento más que nadie mira.

---

## 8. Esquema de ficha

Quince secciones, en este orden, todas presentes aunque digan "no aplica".

```
# <ID> · <Módulo> — <flujo crítico>

1.  Flujo auditado          (la cadena completa, con flechas)
2.  Estado del módulo / estado del flujo
3.  Último paso confirmado / primer paso incompleto
4.  Severidad máxima
5.  Superficie              (endpoints, tablas, pantallas, servicios)
6.  Identidad               (ID técnico / ID operativo / snapshot)
7.  Estados                 (máquina real, con la línea del CHECK o del enum)
8.  Documentos y movimientos
9.  Saldos y reportes
10. Permisos y segregación
11. Auditoría y trazabilidad
12. Errores, idempotencia y fallo parcial
13. Capacidad ausente
14. Brechas                 (tabla: ID · severidad · qué falta · evidencia · cruce)
15. Criterios de cierre     (qué habría que ver para marcar ✅)
```

El punto 3 es el que más informa y el que más se saltea: **hasta dónde llega hoy
el flujo, y cuál es el primer paso que no cierra**. Es la diferencia entre "Caja
está incompleto" y "Caja tiene los cinco endpoints y ninguna pantalla, así que
ningún turno se abre nunca y todo pago en efectivo queda sin turno".

---

## 9. Estados de evaluación

Se separa el estado del **módulo** del estado de cada **flujo**.

| Estado | Definición |
|---|---|
| ☐ No revisado | No se recorrió el flujo crítico. |
| ◐ En auditoría | Se está reconstruyendo el flujo y sus evidencias. |
| ⚠️ Revisado con brechas | Recorrido, con faltantes documentados. |
| ◇ Parcial | La operación principal existe pero no cierra documento, auditoría, reversión o reporte. |
| ◎ Operación suelta | Un dato cambia o un endpoint actúa sin entidad ni ciclo que lo explique. |
| ◌ Huérfano | Entidad, endpoint o pantalla sin consumidor, sin origen o sin cierre. |
| ✅ Completo | Flujo crítico verificado punta a punta, con sus excepciones gobernadas. |
| ⛔ Bloqueado | Depende de fuente externa, dato de producción, decisión legal o proveedor. |
| — No aplica | Se justificó por qué la dimensión no corresponde. |

---

## 10. Severidad, con anclas reales

Por impacto empresarial, nunca por dificultad de programación.

| Nivel | Criterio | Ancla en este repositorio |
|---|---|---|
| S0 Crítica | Puede alterar plata, saldos, documentos legales o datos sin corrección gobernada. | `Gap C1-C` (`pendientes-2026-09-01.md`): saldo del cliente subdeclarado y reembolso sin nota de crédito. |
| S1 Alta | Una operación diaria no tiene ciclo, auditoría, documento o reversión suficiente. | Caja sin pantalla: los cinco endpoints existen y ningún turno se abre nunca (`fichas/M05`). |
| S2 Media | El flujo existe pero le falta consulta, reporte, permiso fino o manejo de excepción no crítica. | Reportes POS/CRM sin panel (`D7`). |
| S3 Baja | Presentación, comodidad o automatización, sin impacto sobre la verdad empresarial. | `#123` crudo en vez de `RES-000123` (`D6-FRONTEND-001`). |
| S4 Observación | Riesgo futuro o mejora sin impacto demostrado hoy. | `resource_locks` sin categoría. |

**Regla de no-cierre:** ningún módulo se marca `✅ Completo` con un flujo S0 o S1
abierto. Y si una dimensión no se verificó, el estado no es "completo": es "no
verificable" o "revisado con brecha".

---

## 11. Numeración de hallazgos

`A2-<MÓDULO>-<nnn>` — `A2` por auditoría v2, para no colisionar con los IDs de
`pendientes-*` ni con los de la corrida del otro agente.
Ejemplo: `A2-M05-001`.

Cada hallazgo entra además como fila de `hallazgos.csv`, con columnas
`id;modulo;flujo;severidad;titulo;evidencia;cruce;bloque`. Ese CSV es lo que se
ordena por severidad para decidir en qué trabajar; el texto de la ficha es para
entender por qué.

---

## 12. Resultado esperado

No una lista de bugs: un **mapa de madurez**. Al terminar debe poder decirse, por
módulo y por flujo: *está completo en este flujo, incompleto en este otro, por
esta causa, con esta evidencia y con este impacto.*

La auditoría termina cuando existe esa visión completa — no cuando todos los
módulos reciben un tilde.
