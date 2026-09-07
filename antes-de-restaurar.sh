#!/bin/bash
# Roda ANTES de restaurar. Nao altera nada.
#   bash /var/www/sistema-financeiro/antes-de-restaurar.sh 2026-09-06
#
# Imprime o que existe hoje e NAO existe no backup, para voce reconstruir
# depois: lancamentos novos, usuarios, favorecidos, socios das retiradas.

set -u
APP_DIR=/var/www/sistema-financeiro
DB=$APP_DIR/data/sistema.db
DEST=/var/backups/sistema-financeiro

[ $# -eq 1 ] || { echo "uso: bash $0 AAAA-MM-DD"; exit 1; }
DATA=$1
ARQ="$DEST/diario/sf_${DATA}.db.gz"
[ -f "$ARQ" ] || ARQ="$DEST/mensal/sf_${DATA}.db.gz"
[ -f "$ARQ" ] || { echo "ERRO: nao existe backup de $DATA"; exit 1; }

TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
gunzip -c "$ARQ" > "$TMP/b.db"
sqlite3 "$TMP/b.db" "SELECT value FROM app_data WHERE key='root';" > "$TMP/b.json"
sqlite3 "$DB"       "SELECT value FROM app_data WHERE key='root';" > "$TMP/a.json"

node -e '
const fs = require("fs");
const B = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const A = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const emp = (r, id) => (r.empresas || []).find(e => e.id === id);
const nome = (lista, id) => { const x = (lista || []).find(o => o.id === id); return x ? x.nome : "-"; };

console.log("############################################################");
console.log("#  LANCAMENTOS QUE EXISTEM HOJE E NAO ESTAO NO BACKUP");
console.log("#  (anote — some ao restaurar, precisa relancar a mao)");
console.log("############################################################");
let total = 0;
for (const e of A.empresas || []) {
  const b = emp(B, e.id);
  const antigos = new Set(((b && b.db && b.db.lancs) || []).map(l => l.id));
  const novos = ((e.db && e.db.lancs) || []).filter(l => !antigos.has(l.id));
  if (!novos.length) continue;
  console.log("");
  console.log("== " + e.nome + " — " + novos.length + " lancamento(s)");
  for (const l of novos) {
    total++;
    console.log("   data....: " + l.data);
    console.log("   valor...: " + l.v);
    console.log("   favorec.: " + (l.fav || "-"));
    console.log("   historic: " + (l.hist || "-"));
    console.log("   conta...: " + nome(e.db.contas, l.ct));
    console.log("   plano...: " + nome(e.db.planos, l.pl));
    console.log("   centro..: " + nome(e.db.ccustos, l.cc));
    if (l.obs) console.log("   obs.....: " + l.obs);
    if (l.docs && l.docs.length) console.log("   ANEXOS..: " + l.docs.length + " documento(s) — serao perdidos");
    console.log("   ---");
  }
}
if (!total) console.log("\n   Nenhum. Restaurar nao perde lancamento algum.");

console.log("");
console.log("############################################################");
console.log("#  OUTRAS DIFERENCAS (backup -> hoje)");
console.log("############################################################");
const cmp = (rot, x, y) => console.log("  " + rot.padEnd(34) + String(x).padStart(5) + " -> " + String(y).padStart(5) + (x !== y ? "   <<< mudou" : ""));
cmp("usuarios", (B.usuarios || []).length, (A.usuarios || []).length);
cmp("perfis",   (B.perfis   || []).length, (A.perfis   || []).length);
cmp("grupos",   (B.grupos   || []).length, (A.grupos   || []).length);
cmp("empresas", (B.empresas || []).length, (A.empresas || []).length);
for (const e of A.empresas || []) {
  const b = emp(B, e.id);
  cmp("favorecidos " + e.nome.slice(0, 20), b ? ((b.db.favorecidos) || []).length : 0, ((e.db.favorecidos) || []).length);
  cmp("contas " + e.nome.slice(0, 25),      b ? ((b.db.contas) || []).length : 0,      ((e.db.contas) || []).length);
}
console.log("");
console.log("  SOCIOS CADASTRADOS NAS RETIRADAS:");
const socios = r => (r.grupos || []).map(g => g.nome + ": " + (((g.ret || {}).socios) || []).map(s => s.nome || "(sem nome)").join(", ")).join(" | ") || "(nenhum grupo)";
console.log("    backup: " + socios(B));
console.log("    hoje..: " + socios(A));
console.log("");
console.log("  USUARIOS HOJE: " + (A.usuarios || []).map(u => u.nome || u.login).join(", "));
console.log("  USUARIOS BKP.: " + (B.usuarios || []).map(u => u.nome || u.login).join(", "));
' "$TMP/b.json" "$TMP/a.json"
