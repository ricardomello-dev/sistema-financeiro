#!/bin/bash
# Compara um backup com o banco ATUAL, sem alterar nada.
#   bash /var/www/sistema-financeiro/comparar-backup.sh 2026-09-06
#
# Serve para decidir com numero na mao ANTES de restaurar: mostra empresa por
# empresa quantos planos, centros e lancamentos existem de cada lado, e quantos
# lancamentos ficaram apontando para categoria que nao existe mais.

set -u
APP_DIR=/var/www/sistema-financeiro
DB=$APP_DIR/data/sistema.db
DEST=/var/backups/sistema-financeiro

[ $# -eq 1 ] || { echo "uso: bash $0 AAAA-MM-DD"; exit 1; }
DATA=$1
ARQ=""
[ -f "$DEST/diario/sf_${DATA}.db.gz" ] && ARQ="$DEST/diario/sf_${DATA}.db.gz"
[ -z "$ARQ" ] && [ -f "$DEST/mensal/sf_${DATA}.db.gz" ] && ARQ="$DEST/mensal/sf_${DATA}.db.gz"
[ -n "$ARQ" ] || { echo "ERRO: nao existe backup de $DATA"; exit 1; }

TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
echo "Agora:            $(date '+%F %T %Z')"
echo "Backup escolhido: $ARQ"
echo "Gravado em:       $(stat -c '%y' "$ARQ" | cut -d. -f1)"
echo ""

gunzip -c "$ARQ" > "$TMP/bkp.db"
sqlite3 "$TMP/bkp.db" "SELECT value FROM app_data WHERE key='root';" > "$TMP/bkp.json"
sqlite3 "$DB"        "SELECT value FROM app_data WHERE key='root';" > "$TMP/atual.json"

node -e '
const fs = require("fs");
const bkp   = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const atual = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));

// quantos lancamentos apontam para plano/centro que nao existe mais
function orfaos(e){
  const d = e.db || {};
  const pl = new Set((d.planos  || []).map(p => p.id));
  const cc = new Set((d.ccustos || []).map(c => c.id));
  let semPl = 0, semCc = 0;
  for (const l of d.lancs || []) {
    const partes = (l.parts && l.parts.length) ? l.parts : [l];
    if (partes.some(p => p.pl && !pl.has(p.pl))) semPl++;
    if (partes.some(p => p.cc && !cc.has(p.cc))) semCc++;
  }
  return { semPl, semCc };
}
function linha(e){
  const d = e.db || {};
  const o = orfaos(e);
  return { nome: e.nome,
           planos: (d.planos||[]).length,
           centros:(d.ccustos||[]).length,
           lancs:  (d.lancs||[]).length,
           orfPl:  o.semPl, orfCc: o.semCc };
}
const B = new Map((bkp.empresas   || []).map(e => [e.id, linha(e)]));
const A = new Map((atual.empresas || []).map(e => [e.id, linha(e)]));

const pad = (s,n) => String(s).padEnd(n);
const num = (s,n) => String(s).padStart(n);
console.log(pad("EMPRESA",26) + num("PLANOS",14) + num("CENTROS",14) + num("LANCAMENTOS",16));
console.log(pad("",26) + num("bkp -> hoje",14) + num("bkp -> hoje",14) + num("bkp -> hoje",16));
console.log("-".repeat(70));
const ids = new Set([...B.keys(), ...A.keys()]);
for (const id of ids) {
  const b = B.get(id), a = A.get(id);
  const nome = (a || b).nome;
  const f = (x,y) => (x === undefined ? "-" : x) + " -> " + (y === undefined ? "-" : y);
  console.log(pad(nome.slice(0,25),26)
    + num(f(b && b.planos,  a && a.planos), 14)
    + num(f(b && b.centros, a && a.centros),14)
    + num(f(b && b.lancs,   a && a.lancs),  16));
}
console.log("");
console.log("LANCAMENTOS APONTANDO PARA CATEGORIA QUE NAO EXISTE MAIS:");
for (const id of ids) {
  const b = B.get(id), a = A.get(id);
  const nome = (a || b).nome;
  const bo = b ? (b.orfPl + "/" + b.orfCc) : "-";
  const ao = a ? (a.orfPl + "/" + a.orfCc) : "-";
  const alerta = (a && (a.orfPl || a.orfCc)) ? "   <<< PROBLEMA AQUI" : "";
  console.log("  " + pad(nome.slice(0,25),26) + "backup: " + pad(bo,10) + "hoje: " + pad(ao,10) + alerta);
}
console.log("");
console.log("  (formato plano/centro — ex.: 2251/2251 = todos perderam a classificacao)");
console.log("");
console.log("DIFERENCA DE LANCAMENTOS (o que voce perde ao restaurar):");
let perda = 0;
for (const id of ids) {
  const b = B.get(id), a = A.get(id);
  const d = ((a && a.lancs) || 0) - ((b && b.lancs) || 0);
  if (d !== 0) { console.log("  " + pad((a||b).nome.slice(0,25),26) + (d > 0 ? d + " lancamento(s) feitos depois do backup" : Math.abs(d) + " a mais no backup")); }
  if (d > 0) perda += d;
}
console.log(perda ? "  TOTAL A PERDER: " + perda + " lancamento(s)." : "  Nenhum lancamento novo desde o backup — restaurar nao perde nada.");
' "$TMP/bkp.json" "$TMP/atual.json"
