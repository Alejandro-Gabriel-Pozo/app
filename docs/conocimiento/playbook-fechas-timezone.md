# Playbook — fechas calendario vs huso (JS, Zod, día de negocio)

- **Fecha:** 2026-08-25
- **Estado:** implementado (patrón repetido; no reabrir el “instante exacto” en housekeeping sin dueño)
- **Contexto:** varios bugs reales vinieron de tratar `YYYY-MM-DD` como instante UTC o de comparar instantes cuando el negocio piensa en **día**.
- **Categoría:** Playbook
- **Etiquetas:** `timezone` `luxon` `zod` `housekeeping` `A4.2` `A4.4`
- **Alcance:** frontend (`<input type=date>`), API (`dateOnlySchema`), dominio (`Business.timezone` IANA).
- **Referencias:** `criterios-negocio.md` A4.2/A4.4; `src/api/schemas/common.schemas.ts` (`dateOnlySchema`); `housekeeping-task.ts` `create()`; `appfrontend-main` `housekeeping/page.tsx` `handleCreate`; `maintenance-window.service.ts` / `stay.service.ts` `combineDateAndTime`.

## Problema

En JavaScript:

- `new Date("2026-08-25")` → medianoche **UTC**.
- `new Date("2026-08-25T00:00")` → medianoche **local del navegador**.

Con huso detrás de UTC (Argentina, UTC−3) el primer caso manda “ayer” al servidor. El segundo es el quirk que el front usa cuando el contrato exige datetime ISO (`z.string().datetime()`), no date-only.

## Procedimiento

1. **¿El campo es día de calendario?** Mandar el string `YYYY-MM-DD` crudo. No pasar por `Date` en el cliente. Ejemplo: `startDate` de maintenance windows.
2. **¿El contrato exige instante (`datetime`)?** Si la UI solo eligió un día: `new Date(\`${date}T00:00\`).toISOString()` en el navegador, o `combineDateAndTime` en el servidor con el timezone del negocio.
3. **¿El guard es “no en el pasado”?** Preguntar si es **instante** o **día de negocio**. `HousekeepingTask.create()` compara `startOf('day')` en `profile.timezone` (Luxon). Un comentario viejo que diga “instante exacto, decisión confirmada” puede estar **desactualizado** si aparece un caller manual (pantalla “Planificar tarea” con default hoy).
4. **Query strings de reportes:** usar `dateOnlySchema` — rechaza `2026-02-30`. No hacer `new Date(req.query.from as string)` (produce `Invalid Date` en silencio).
5. **Housekeeping GET `date`:** no envolver en `Date` en la ruta; el string es deliberado.

## Ejemplo concreto

Rechazo 409 “fecha ya pasada” al planificar housekeeping para **hoy** después de medianoche: el guard comparaba `scheduledFor` (00:00 local → ISO) con `now`. Tras el parche, “hoy” en el huso del negocio es válido; “ayer” sigue rechazado.

## Consecuencias y limitaciones

- `T00:00` en el **navegador** usa el huso de la máquina del staff, no necesariamente `Business.timezone`. Hecho observado: el negocio demo opera en Argentina y el staff también; **pendiente de confirmar** el caso staff en otro huso que el negocio.
- No migrar a `scheduledDate` + `scheduledTime` sin decisión de producto (alternativa descartada el 25/08: parche táctico sin schema).

## Tareas futuras que deben consultar esto

Cualquier `<input type=date>`, worker que agende “mañana 08:00”, reporte con `from`/`to`, o guard “no pasado” sobre TRANSACCIÓN.
