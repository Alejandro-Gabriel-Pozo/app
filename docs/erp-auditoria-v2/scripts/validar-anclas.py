#!/usr/bin/env python3
"""Valida las anclas `archivo:linea` citadas en las fichas de la auditoria v2.

Una ficha con anclas rotas no se considera entregada (00-programa-v2.md, 4.2).
Se resuelven contra los dos repos: app-main/ y appfrontend-main/.

Uso: python docs/erp-auditoria-v2/scripts/validar-anclas.py   (desde app-main/)
Sale con codigo 1 si hay al menos un ancla rota.
"""
import re, sys, pathlib

BASE  = pathlib.Path(__file__).resolve().parents[3]      # -> app-main/
FRONT = BASE.parent / "appfrontend-main"
DOCS  = BASE / "docs/erp-auditoria-v2"

# `src/algo/archivo.ts:123` o `appfrontend-main/src/...:123`, dentro o fuera de backticks
ANCLA = re.compile(r"((?:appfrontend-main/|app-main/)?(?:src|docs|migrations)/[A-Za-z0-9_./\[\]-]+\.(?:ts|tsx|sql|md)):(\d+)")

def resolver(rel: str) -> pathlib.Path | None:
    for raiz, prefijo in ((FRONT, "appfrontend-main/"), (BASE, "app-main/"), (BASE, "")):
        p = rel[len(prefijo):] if prefijo and rel.startswith(prefijo) else (None if prefijo else rel)
        if p is None:
            continue
        cand = raiz / p
        if cand.is_file():
            return cand
    return None

rotas, total = [], 0
for ficha in sorted(DOCS.rglob("*.md")):
    for n, linea in enumerate(ficha.read_text(encoding="utf-8").splitlines(), 1):
        for rel, num in ANCLA.findall(linea):
            total += 1
            f = resolver(rel)
            if f is None:
                rotas.append((ficha.name, n, f"{rel}:{num}", "archivo inexistente"))
            else:
                nlineas = len(f.read_text(encoding="utf-8", errors="replace").splitlines())
                if int(num) > nlineas or int(num) < 1:
                    rotas.append((ficha.name, n, f"{rel}:{num}", f"el archivo tiene {nlineas} lineas"))

print(f"anclas citadas: {total}   rotas: {len(rotas)}")
for ficha, n, ancla, motivo in rotas:
    print(f"  {ficha}:{n}  ->  {ancla}   ({motivo})")
sys.exit(1 if rotas else 0)
