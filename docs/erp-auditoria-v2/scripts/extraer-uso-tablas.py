#!/usr/bin/env python3
"""Que carpeta de src/ usa cada tabla del schema de tenant.

Sirve para dos cosas de la auditoria: asignar cada tabla a un modulo, y detectar
tablas del schema que ningun codigo toca (candidatas a entidad huerfana).

Salida: datos/uso-tablas.csv -> tabla;carpetas;hits
Uso   : python docs/erp-auditoria-v2/scripts/extraer-uso-tablas.py   (desde app-main/)
"""
import re, csv, pathlib, collections

BASE = pathlib.Path(__file__).resolve().parents[3]
SRC  = BASE / "src"

schema = (SRC / "db/schema.sql").read_text(encoding="utf-8")
tablas = sorted(set(re.findall(r"(?im)^CREATE TABLE (?:IF NOT EXISTS )?([a-z_]+)", schema)))

archivos = [p for p in SRC.rglob("*.ts") if ".test." not in p.name and "/tests/" not in p.as_posix()]
textos = {p: p.read_text(encoding="utf-8", errors="replace") for p in archivos}

filas = []
for t in tablas:
    pat = re.compile(rf"\b{t}\b")
    carpetas, hits = collections.Counter(), 0
    for p, txt in textos.items():
        n = len(pat.findall(txt))
        if n:
            rel = p.relative_to(SRC).as_posix()
            carpetas[rel.split("/")[0]] += n
            hits += n
    filas.append([t, ",".join(f"{c}({n})" for c, n in carpetas.most_common()) or "-", hits])

out = BASE / "docs/erp-auditoria-v2/datos/uso-tablas.csv"
with open(out, "w", encoding="utf-8", newline="") as f:
    w = csv.writer(f, delimiter=";")
    w.writerow(["tabla", "carpetas", "hits"])
    w.writerows(filas)
print(f"tablas: {len(filas)}   sin uso en src (fuera de db/): "
      f"{sum(1 for r in filas if r[1] in ('-', 'db(1)') or set(x.split('(')[0] for x in r[1].split(',')) <= {'db'})}")
