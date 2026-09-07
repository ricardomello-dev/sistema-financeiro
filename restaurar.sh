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

# Guarda o estado atual com data e hora — se a restauracao for a escolha
# errada, este arquivo e o unico caminho de volta.
SALVO="$DB.antes-da-restauracao-$(date +%Y%m%d-%H%M%S)"
cp "$DB" "$SALVO" 2>/dev/null && echo "Banco ATUAL guardado em: $SALVO"

# ATENCAO: o sistema roda por systemd (servico "finance"), NAO por pm2.
# Parar de verdade e obrigatorio: com o servico no ar, o processo mantem os
# dados antigos em memoria e sobrescreve o banco restaurado na proxima
# gravacao — a restauracao "funciona" e some minutos depois.
echo "Parando o servico finance..."
systemctl stop finance
sleep 2
if systemctl is-active --quiet finance; then
  echo "ERRO: o servico finance nao parou. Nada foi alterado."
  exit 1
fi

cp "$TMP/sistema.db" "$DB"
# Remove journal/WAL orfaos do banco antigo, que poderiam reintroduzir dados
rm -f "$DB-wal" "$DB-shm" 2>/dev/null

echo "Subindo o servico..."
systemctl start finance
sleep 4

if curl -s http://localhost:3000/api/status | grep -q '"ok":true'; then
  echo ""
  echo "  ####################################################"
  echo "  #   RESTAURADO. Sistema no ar com os dados de      #"
  echo "  #   $DATA"
  echo "  ####################################################"
  echo ""
  echo "  Estado anterior a esta restauracao: $SALVO"
  echo "  Confira o sistema no navegador ANTES de fechar este terminal."
else
  echo "AVISO: o sistema nao respondeu. Rode: journalctl -u finance -n 30 --no-pager"
fi
