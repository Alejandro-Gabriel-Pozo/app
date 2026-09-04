#!/usr/bin/env bash
# Inventario de endpoints con su control de acceso REAL.
# Salida CSV: archivo;linea;metodo;path;guard
#   authorize(Roles.X)          -> guard declarativo en la propia ruta
#   use:<middlewares>           -> guard posicional heredado de un router.use() anterior
#   handler:requireCustomerId   -> control dentro del handler (portal de clientes)
#   SIN-GUARD                   -> ninguno de los anteriores  => revisar a mano
# Invariante: el total debe coincidir con
#   grep -rho "router\.\(get\|post\|put\|patch\|delete\)(" --include="*.routes.ts" src | wc -l
# Uso: bash docs/erp-auditoria-v2/scripts/extraer-endpoints.sh   (desde app-main/)
set -u
cd "$(dirname "$0")/../../.." || exit 1
echo "archivo;linea;metodo;path;guard"
for f in $(find src -name "*.routes.ts" | sort); do
  awk -v F="$f" '
    { L[NR]=$0 } END {
      inherited="";
      for (n=1; n<=NR; n++) {
        s=L[n];
        if (s ~ /router\.use\(/ && (s ~ /authorize/ || s ~ /authenticate/)) {
          u=s; sub(/.*router\.use\(/,"",u); sub(/\);.*/,"",u); gsub(/[ \t]+/," ",u);
          inherited="use:" u; continue;
        }
        if (s !~ /router\.(get|post|put|patch|delete)\(/) continue;
        m=s; sub(/.*router\./,"",m); sub(/\(.*/,"",m);
        path=""; guard="";
        if (match(s, /\x27[^\x27]*\x27/)) path=substr(s,RSTART+1,RLENGTH-2);
        if (match(s, /authorize\([^)]*\)/)) guard=substr(s,RSTART,RLENGTH);
        for (k=n+1; k<=n+15 && k<=NR; k++) {
          t=L[k];
          if (t ~ /router\.(get|post|put|patch|delete)\(/) break;
          if (path=="" && match(t, /\x27[^\x27]*\x27/)) path=substr(t,RSTART+1,RLENGTH-2);
          if (guard=="" && match(t, /authorize\([^)]*\)/)) { guard=substr(t,RSTART,RLENGTH); break }
          if (guard=="" && t ~ /requireCustomerId/) { guard="handler:requireCustomerId"; break }
        }
        if (guard=="" && inherited!="") guard=inherited;
        gsub(/[ \t]+/," ",guard);
        printf "%s;%d;%s;%s;%s\n", F, n, toupper(m), path, (guard==""?"SIN-GUARD":guard);
      }
    }
  ' "$f"
done
