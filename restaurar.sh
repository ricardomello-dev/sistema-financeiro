#!/bin/bash
# Restauracao do Sistema Financeiro a partir de um backup.
#   bash /var/www/sistema-financeiro/restaurar.sh              -> lista os backups
#   bash /var/www/sistema-financeiro/restaurar.sh 2026-08-10   -> restaura essa data
#
# Antes de sobrescrever, guarda o banco atual em data/sistema.db.antes-da-restauracao

set -u
APP_DIR=/var/www/sistema-financeiro
DB=$APP_DIR/data/sistema.db
DEST=/var/backups/sistema-financeiro

if [ $# -eq 0 ]; then
  echo "Backups disponiveis:"
  echo ""
  echo "  DIARIOS:"
  ls -1t "$DEST/diario"/sf_*.db.gz 2>/dev/null | head -35 | while read -r f; do
    echo "    $(basename "$f" | sed 's/sf_//; s/.db.gz//')   ($(du -h "$f" | cut -f1))"
  done
  echo ""
  echo "  MENSAIS:"
  ls -1t "$DEST/mensal"/sf_*.db.gz 2>/dev/null | while read -r f; do
    echo "    $(basename "$f" | sed 's/sf_//; s/.db.gz//')   ($(du -h "$f" | cut -f1))"
  done
  echo ""
  echo "Para restaurar:  bash $0 AAAA-MM-DD"
  exit 0
fi

DATA=$1
ARQ=""
[ -f "$DEST/diario/sf_${DATA}.db.gz" ] && ARQ="$DEST/diario/sf_${DATA}.db.gz"
[ -z "$ARQ" ] && [ -f "$DEST/mensal/sf_${DATA}.db.gz" ] && ARQ="$DEST/mensal/sf_${DATA}.db.gz"
if [ -z "$ARQ" ]; then
  echo "ERRO: nao existe backup de $DATA. Rode sem argumentos para ver a lista."
  exit 1
fi

TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
gunzip -c "$ARQ" > "$TMP/sistema.db"
CHECK=$(sqlite3 "$TMP/sistema.db" "PRAGMA integrity_check;" 2>&1)
if [ "$CHECK" != "ok" ]; then
  echo "ERRO: o arquivo de backup esta corrompido ($CHECK). Nada foi alterado."
  exit 1
fi

EMPRESAS=$(sqlite3 "$TMP/sistema.db" "SELECT value FROM app_data WHERE key='root';" | grep -o '"nome":"[^"]*"' | head -5 | sed 's/"nome":"/  - /; s/"$//')
echo ""
echo "Backup de $DATA — conteudo:"
echo "$EMPRESAS"
echo ""
read -r -p "Restaurar este backup por cima dos dados atuais? (digite SIM): " OK
[ "$OK" = "SIM" ] || { echo "Cancelado. Nada foi alterado."; exit 0; }

cp "$DB" "$DB.antes-da-restauracao" 2>/dev/null && echo "Banco atual guardado em $DB.antes-da-restauracao"
pm2 stop sistema-financeiro >/dev/null 2>&1
cp "$TMP/sistema.db" "$DB"
pm2 start sistema-financeiro >/dev/null 2>&1
sleep 3

if curl -s http://localhost:3000/api/status | grep -q '"ok":true'; then
  echo ""
  echo "  ####################################################"
  echo "  #   RESTAURADO. Sistema no ar com os dados de      #"
  echo "  #   $DATA"
  echo "  ####################################################"
else
  echo "AVISO: o sistema nao respondeu. Rode: pm2 logs sistema-financeiro --lines 20 --nostream"
fi
