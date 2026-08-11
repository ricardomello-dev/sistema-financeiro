#!/bin/bash
# Backup do Sistema Financeiro — rode pelo cron, uma vez por dia.
#   bash /var/www/sistema-financeiro/backup.sh
#
# O que faz:
#   1. Copia o banco SQLite com consistencia (usa .backup, nao "cp")
#   2. Verifica a integridade da copia antes de aceita-la
#   3. Compacta e guarda em /var/backups/sistema-financeiro
#   4. Mantem 30 diarios + 12 mensais (o do dia 1 de cada mes)
#   5. Envia uma copia criptografada para fora do servidor, se configurado

set -u
APP_DIR=/var/www/sistema-financeiro
DB=$APP_DIR/data/sistema.db
DEST=/var/backups/sistema-financeiro
HOJE=$(date +%F)
DIA_DO_MES=$(date +%d)
LOG=$DEST/backup.log

mkdir -p "$DEST/diario" "$DEST/mensal"
exec > >(tee -a "$LOG") 2>&1
echo "=========================================================="
echo "[$(date '+%F %T')] Iniciando backup"

if [ ! -f "$DB" ]; then
  echo "ERRO: banco nao encontrado em $DB"
  exit 1
fi

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

# 1. Copia consistente (nao trava o app; respeita transacoes em andamento)
if ! sqlite3 "$DB" ".backup '$TMP/sistema.db'"; then
  echo "ERRO: falha ao copiar o banco"
  exit 1
fi

# 2. Integridade
CHECK=$(sqlite3 "$TMP/sistema.db" "PRAGMA integrity_check;" 2>&1)
if [ "$CHECK" != "ok" ]; then
  echo "ERRO: copia corrompida — integrity_check retornou: $CHECK"
  exit 1
fi

# Confere se ha dados de verdade (evita salvar um banco vazio por engano)
N_EMP=$(sqlite3 "$TMP/sistema.db" "SELECT COALESCE(LENGTH(value),0) FROM app_data WHERE key='root';" 2>/dev/null || echo 0)
if [ "${N_EMP:-0}" -lt 1000 ]; then
  echo "ERRO: o banco parece vazio (payload de $N_EMP bytes). Backup abortado."
  exit 1
fi
echo "Banco integro — $N_EMP bytes de dados."

# 3. Compacta
ARQ="$DEST/diario/sf_${HOJE}.db.gz"
gzip -c "$TMP/sistema.db" > "$ARQ"
TAM=$(du -h "$ARQ" | cut -f1)
echo "Backup diario gravado: $ARQ ($TAM)"

# Copia mensal no dia 1
if [ "$DIA_DO_MES" = "01" ]; then
  cp "$ARQ" "$DEST/mensal/sf_${HOJE}.db.gz"
  echo "Copia mensal gravada."
fi

# 4. Retencao
find "$DEST/diario" -name 'sf_*.db.gz' -mtime +30 -delete
ls -1t "$DEST/mensal"/sf_*.db.gz 2>/dev/null | tail -n +13 | xargs -r rm -f
echo "Retencao aplicada: $(ls -1 "$DEST/diario" | wc -l) diarios, $(ls -1 "$DEST/mensal" 2>/dev/null | wc -l) mensais."

# 5. Copia externa (opcional) — configure REMOTO no .env.backup
if [ -f "$APP_DIR/.env.backup" ]; then
  # shellcheck disable=SC1090
  . "$APP_DIR/.env.backup"
  if [ -n "${BACKUP_PASS:-}" ] && [ -n "${RCLONE_REMOTO:-}" ]; then
    CRIPTO="$TMP/sf_${HOJE}.db.gz.enc"
    if openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -salt \
         -in "$ARQ" -out "$CRIPTO" -pass pass:"$BACKUP_PASS"; then
      if command -v rclone >/dev/null && rclone copy "$CRIPTO" "$RCLONE_REMOTO" 2>&1; then
        echo "Copia externa enviada para $RCLONE_REMOTO (criptografada)."
      else
        echo "AVISO: falha ao enviar a copia externa."
      fi
    else
      echo "AVISO: falha ao criptografar a copia externa."
    fi
  else
    echo "Copia externa nao configurada (.env.backup sem BACKUP_PASS/RCLONE_REMOTO)."
  fi
else
  echo "Copia externa nao configurada (sem .env.backup)."
fi

echo "[$(date '+%F %T')] Backup concluido com sucesso."
