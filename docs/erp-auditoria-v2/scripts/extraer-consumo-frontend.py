#!/usr/bin/env python3
"""Endpoints que el frontend INVOCA de verdad (no los que solo menciona un comentario).

Reconoce las cuatro formas reales de llamada del repo:
    apiFetch<T>('/api/...')   customerApiFetch / publicFetch (portal)   platformFetch   fetch(`${BASE}/...`)

El metodo se lee del `method: 'X'` que pertenece a ESA llamada: se acumulan lineas
desde la de apertura hasta que los parentesis cierran (tope 8 lineas), asi un
`list:` sin opciones no hereda el 'POST' del `create:` de la linea siguiente.
Sin `method:` explicito -> GET, que es el default real de fetch/apiFetch.

Salida: datos/consumo-frontend.csv -> archivo;linea;metodo;path   (`${x}` y /:id -> /:param)
Uso   : python docs/erp-auditoria-v2/scripts/extraer-consumo-frontend.py   (desde app-main/)
"""
import re, csv, pathlib

BASE  = pathlib.Path(__file__).resolve().parents[3]           # -> app-main/
FRONT = BASE.parent / "appfrontend-main"
OUT   = BASE / "docs/erp-auditoria-v2/datos/consumo-frontend.csv"

CALL = re.compile(r"\b(apiFetch|customerApiFetch|publicFetch|customerFetch|platformFetch|fetch)\s*[<(]")
PATH = re.compile(r"""[`'"]((?:\$\{[A-Za-z_]+\})?/(?:api|platform|register)[^`'"]*)[`'"]""")
METH = re.compile(r"method:\s*'([A-Z]+)'")

rows = set()
for f in list(FRONT.joinpath("src").rglob("*.ts")) + list(FRONT.joinpath("src").rglob("*.tsx")):
    lines = f.read_text(encoding="utf-8", errors="replace").splitlines()
    for i, line in enumerate(lines):
        if not CALL.search(line):
            continue
        m = PATH.search(line)
        if not m:
            continue
        stmt, depth = "", 0
        for j in range(i, min(i + 8, len(lines))):
            stmt += lines[j]
            depth += lines[j].count("(") - lines[j].count(")")
            if depth <= 0:
                break
        meth = METH.search(stmt)
        path = re.sub(r"\$\{[^}]*\}", ":param", m.group(1))
        path = path[path.index("/api"):] if "/api" in path else                path[path.index("/platform"):] if "/platform" in path else                path[path.index("/register"):]
        path = re.sub(r"/:[A-Za-z]+", "/:param", path.split("?")[0]).rstrip("/") or "/"
        rows.add((str(f.relative_to(FRONT)).replace("\\", "/"), i + 1,
                  meth.group(1) if meth else "GET", path))

with open(OUT, "w", encoding="utf-8", newline="") as fh:
    w = csv.writer(fh, delimiter=";")
    w.writerow(["archivo", "linea", "metodo", "path"])
    w.writerows(sorted(rows, key=lambda r: (r[0], r[1])))
print(f"llamadas: {len(rows)}")
