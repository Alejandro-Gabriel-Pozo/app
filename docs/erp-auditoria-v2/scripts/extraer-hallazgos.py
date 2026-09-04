#!/usr/bin/env python3
"""Junta las tablas de brechas de todas las fichas en un CSV unico y ordenado.

Lee la seccion "## 14. Brechas" de cada ficha y produce
datos/hallazgos.csv -> id;modulo;severidad;titulo;evidencia;cruce
ordenado por severidad (S0 primero) y despues por id.

Uso: python docs/erp-auditoria-v2/scripts/extraer-hallazgos.py   (desde app-main/)
"""
import re, csv, pathlib

BASE   = pathlib.Path(__file__).resolve().parents[3]
FICHAS = BASE / "docs/erp-auditoria-v2/fichas"
OUT    = BASE / "docs/erp-auditoria-v2/datos/hallazgos.csv"

FILA = re.compile(r"^\|\s*`(A2-[A-Z0-9]+-\d+)`\s*\|\s*\**(S[0-4])\**\s*\|(.+?)\|(.+?)\|(.+?)\|\s*$")

def limpiar(t):
    return t.strip().strip("*").replace("**", "").strip()

filas = []
for ficha in sorted(FICHAS.glob("*.md")):
    for linea in ficha.read_text(encoding="utf-8").splitlines():
        m = FILA.match(linea)
        if m:
            hid, sev, titulo, evid, cruce = m.groups()
            filas.append([hid, hid.split("-")[1], sev, limpiar(titulo),
                          limpiar(evid), limpiar(cruce)])

filas.sort(key=lambda r: (r[2], r[0]))
with open(OUT, "w", encoding="utf-8", newline="") as f:
    w = csv.writer(f, delimiter=";")
    w.writerow(["id", "modulo", "severidad", "titulo", "evidencia", "cruce"])
    w.writerows(filas)

from collections import Counter
c = Counter(r[2] for r in filas)
print(f"hallazgos: {len(filas)}   " + "  ".join(f"{k}={c[k]}" for k in sorted(c)))
