# erp-auditoria-v2

Auditoría de completitud empresarial del ERP. Corrida del **02/09/2026**,
**completa**: 21 fichas, 158 hallazgos, 431 anclas verificadas.

## Por dónde entrar

| Si querés… | Leé |
|---|---|
| el resultado | `10-matriz-maestra.md` |
| priorizar trabajo | `datos/hallazgos.csv` (ordenado por severidad) |
| entender un módulo | `fichas/<ID>-<nombre>.md` |
| saber qué módulos existen y cuáles no | `01-inventario-verificado.md` |
| repetir o extender la auditoría | `00-programa-v2.md` |

## Qué es cada cosa

- **`00-programa-v2.md`** — el método. Reemplaza a
  `../programa-auditoria-completitud-erp-2026-09-01.md` (v1.0, borrador). §0
  explica las siete diferencias.
- **`01-inventario-verificado.md`** — los 21 módulos, derivados del código, con
  las tres columnas de existencia (router / tabla / pantalla).
- **`10-matriz-maestra.md`** — matriz por módulo, los 4 S0, los cinco patrones
  transversales, los bloques de implementación y las decisiones del dueño.
- **`fichas/`** — una por módulo, quince secciones fijas (`00-programa-v2.md` §8).
- **`datos/`** — hechos base en CSV, todos re-generables.
- **`scripts/`** — los siete extractores y el validador de anclas.

## Alcance de la corrida

**No** se tocó código, schema, permisos, producción ni commits. **No** se
corrieron los tests ni se consultó ninguna base. Toda la evidencia es de código
y de configuración; los 20 hallazgos marcados `[H]` dicen cómo se confirmarían
(`10-matriz-maestra.md` §7).

## Regenerar

```bash
cd app-main
bash   docs/erp-auditoria-v2/scripts/extraer-endpoints.sh > docs/erp-auditoria-v2/datos/endpoints.csv
bash   docs/erp-auditoria-v2/scripts/extraer-montajes.sh  > docs/erp-auditoria-v2/datos/montajes.csv
python docs/erp-auditoria-v2/scripts/extraer-consumo-frontend.py
python docs/erp-auditoria-v2/scripts/extraer-uso-tablas.py
python docs/erp-auditoria-v2/scripts/cruzar-cobertura.py
python docs/erp-auditoria-v2/scripts/extraer-hallazgos.py
python docs/erp-auditoria-v2/scripts/validar-anclas.py
```

Los siete son idempotentes y sólo escriben dentro de `docs/erp-auditoria-v2/`.
