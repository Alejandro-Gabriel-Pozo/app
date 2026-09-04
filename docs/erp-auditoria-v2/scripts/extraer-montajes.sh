#!/usr/bin/env bash
# Mapa de montaje: prefijo HTTP -> archivo de router.
# Cubre tanto `app.use('/x', createXRouter(...))` como el patron de closure
# `app.use('/x', requireModule(...), (req,res,next) => { ... createXRouter() })`
# Salida CSV: prefijo;router;linea_app_ts
set -u
cd "$(dirname "$0")/../../.." || exit 1
echo "prefijo;router;linea"
awk '
  { L[NR]=$0 } END {
    for (n=1;n<=NR;n++) {
      if (L[n] !~ /^  app\.use\(/) continue;
      pref=""; router=""; depth=0;
      for (k=n;k<=n+40 && k<=NR;k++) {
        if (pref=="" && match(L[k], /\x27\/[^\x27]*\x27/)) pref=substr(L[k],RSTART+1,RLENGTH-2);
        if (router=="" && match(L[k], /create[A-Za-z]+Router/)) router=substr(L[k],RSTART,RLENGTH);
        if (k>n && L[k] ~ /^  app\.use\(/) break;
        if (L[k] ~ /^  \);/ && k>n) break;
      }
      if (pref!="" && router!="") printf "%s;%s;%d\n", pref, router, n;
    }
  }' src/app.ts
