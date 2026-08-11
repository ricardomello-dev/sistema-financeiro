#!/bin/bash
# Deploy do Sistema Financeiro — uso: bash /var/www/sistema-financeiro/deploy.sh
#
# HISTORICO IMPORTANTE (11/08/2026):
#   O sistema roda pelo systemd, servico "finance", a partir de
#   /var/www/sistema-financeiro. NAO use pm2 — havia uma segunda instalacao
#   em /opt/aliance/finance gerenciada pelo systemd que disputava a porta 3000
#   com o pm2. Como o servico tem Restart=always, matar o processo so fazia o
#   systemd ressuscitar a versao velha, e o deploy parecia "nao pegar".
#   A instalacao de /opt foi aposentada. Se algum dia o deploy voltar a
#   "nao pegar", cheque primeiro: lsof -ti :3000 -sTCP:LISTEN | xargs ps -o cmd -p

cd /var/www/sistema-financeiro || exit 1

echo "== 1/6 Baixando atualizacoes do GitHub =="
git pull origin main || { echo ">>> FALHA no git pull"; exit 1; }

echo "== 2/6 Conferindo dependencias =="
npm install --omit=dev --no-audit --no-fund 2>&1 | tail -3

echo "== 3/6 Checando sintaxe do sistema =="
node -e "
const fs=require('fs'),vm=require('vm');
const h=fs.readFileSync('Sistema Financeiro.html','utf8');
const m=h.match(/<script>([\s\S]*?)<\/script>/);
try{ new vm.Script(m[1]); console.log('   HTML: sintaxe OK'); }
catch(e){ console.log('   ERRO DE SINTAXE no HTML: '+e.message); process.exit(1); }
" || { echo ">>> ABORTADO: o sistema NAO foi alterado, continua no ar"; exit 1; }
node --check server.js && echo "   server.js: sintaxe OK" || { echo ">>> ABORTADO: erro no server.js"; exit 1; }

echo "== 4/6 Reiniciando o servico =="
systemctl restart finance
sleep 4

echo "== 5/6 Conferindo quem responde na porta 3000 =="
QUEM=$(lsof -ti :3000 -sTCP:LISTEN 2>/dev/null | head -1)
if [ -n "$QUEM" ]; then
  PASTA=$(readlink -f /proc/"$QUEM"/cwd 2>/dev/null)
  echo "   PID $QUEM em $PASTA"
  if [ "$PASTA" != "/var/www/sistema-financeiro" ]; then
    echo ""
    echo "   !!! ATENCAO: quem responde na porta 3000 NAO e esta instalacao."
    echo "   !!! Ha outro servico rodando o sistema a partir de $PASTA"
    echo "   !!! O deploy nao vai surtir efeito ate isso ser resolvido."
    exit 1
  fi
fi

echo "== 6/6 Verificando =="
if curl -s http://localhost:3000/api/status | grep -q '"ok":true'; then
  TAM_DISCO=$(wc -c < "Sistema Financeiro.html")
  TAM_HTTP=$(curl -s http://localhost:3000/ | wc -c)
  DIF=$(( TAM_DISCO > TAM_HTTP ? TAM_DISCO - TAM_HTTP : TAM_HTTP - TAM_DISCO ))
  if [ "$DIF" -gt 2000 ]; then
    echo "   !!! O HTML entregue ($TAM_HTTP bytes) difere do arquivo em disco ($TAM_DISCO)."
    echo "   !!! Provavel versao antiga sendo servida. Investigue."
    exit 1
  fi
  echo ""
  echo "   ####################################"
  echo "   #   SISTEMA ATUALIZADO E NO AR     #"
  echo "   ####################################"
  echo ""
  systemctl status finance --no-pager | grep -E "Active:" | sed 's/^/   /'
  journalctl -u finance -n 20 --no-pager 2>/dev/null | grep -iE "SMTP" | tail -1 | sed 's/^/   /'
else
  echo ""
  echo "   !!! FALHOU - rode: journalctl -u finance -n 30 --no-pager"
  exit 1
fi
