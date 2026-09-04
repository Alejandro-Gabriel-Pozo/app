#!/usr/bin/env python3
"""Cruza el inventario de endpoints del backend contra lo que el frontend invoca.

Entrada : datos/endpoints.csv, datos/montajes.csv, datos/consumo-frontend.csv
Salida  : datos/cobertura.csv  ->  path;metodo;guard;origen;consumidores
          consumidores == "-"  => endpoint sin consumidor conocido en el panel
                                  (candidato a huerfano, hay que confirmarlo a mano)
Uso     : python docs/erp-auditoria-v2/scripts/cruzar-cobertura.py   (desde app-main/)
"""
import csv, re, sys, pathlib

BASE = pathlib.Path(__file__).resolve().parents[3]      # -> app-main/
D    = BASE / "docs/erp-auditoria-v2/datos"

def read(p):
    with open(D / p, encoding="utf-8") as f:
        return list(csv.DictReader(f, delimiter=";"))

montajes = read("montajes.csv")
endpoints = read("endpoints.csv")
consumo  = read("consumo-frontend.csv")

# router exportado -> archivo de rutas
file_of_router = {}
for f in (BASE / "src").rglob("*.routes.ts"):
    rel = "src/" + str(f.relative_to(BASE / "src")).replace("\\", "/")
    for m in re.finditer(r"export function (create[A-Za-z]+Router)", f.read_text(encoding="utf-8")):
        file_of_router[m.group(1)] = rel

# archivo -> prefijos de montaje. Es una LISTA, no un valor: hay routers
# montados dos veces con prefijos distintos (user-invitation.routes.ts vive en
# /api/users/invitations y en /api/invitations). Se descarta el '/api' generico,
# que es un falso positivo del parser de app.ts.
pref_of_file = {}
for row in montajes:
    f = file_of_router.get(row["router"])
    if not f or row["prefijo"] == "/api":
        continue
    pref_of_file.setdefault(f, []).append(row["prefijo"])

def norm(p):
    return re.sub(r"/:[A-Za-z]+", "/:param", p).rstrip("/") or "/"

cons_idx = {}
for c in consumo:
    cons_idx.setdefault((c["metodo"], norm(c["path"])), []).append(f'{c["archivo"]}:{c["linea"]}')

out = [["path", "metodo", "guard", "origen", "consumidores"]]
for e in endpoints:
    prefs = pref_of_file.get(e["archivo"], ["(sin-montaje)"])
    # con montaje multiple gana el prefijo que SI tiene consumidor: el endpoint
    # esta cubierto por alguno de sus dos caminos, no es huerfano.
    elegido, cons = prefs[0], []
    for pref in prefs:
        full = (pref + e["path"]).rstrip("/") or pref
        c = cons_idx.get((e["metodo"], norm(full)), [])
        if c:
            elegido, cons = pref, c
            break
    full = (elegido + e["path"]).rstrip("/") or elegido
    out.append([full, e["metodo"], e["guard"], f'{e["archivo"]}:{e["linea"]}',
                ",".join(cons) or "-"])

with open(D / "cobertura.csv", "w", encoding="utf-8", newline="") as f:
    csv.writer(f, delimiter=";").writerows(out)

huerf = [r for r in out[1:] if r[4] == "-"]
print(f"endpoints: {len(out)-1}  sin consumidor: {len(huerf)}")
