#!/bin/bash
# Deploy do Sistema Financeiro — uso: bash /var/www/sistema-financeiro/deploy.sh
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

echo "== 4/6 Liberando a porta 3000 =="
# ATENCAO: -sTCP:LISTEN e obrigatorio. Sem ele, o lsof tambem lista o Caddy
# (que abre conexao de saida para a 3000) e o kill derruba o proxy junto.
lsof -ti :3000 -sTCP:LISTEN | xargs -r kill -9
sleep 2

echo "== 5/6 Reiniciando o servidor =="
pm2 restart sistema-financeiro >/dev/null 2>&1
sleep 3

echo "== 6/6 Verificando =="
if curl -s http://localhost:3000/api/status | grep -q '"ok":true'; then
  echo ""
  echo "   ####################################"
  echo "   #   SISTEMA ATUALIZADO E NO AR     #"
  echo "   ####################################"
  echo ""
  echo "   Recuperacao de senha por e-mail:"
  pm2 logs sistema-financeiro --lines 40 --nostream 2>/dev/null | grep -E "SMTP (configurado|nao)|SMTP não" | tail -1 || echo "   (sem informacao — veja: pm2 logs sistema-financeiro --lines 20 --nostream)"
else
  echo ""
  echo "   !!! FALHOU - rode: pm2 logs sistema-financeiro --lines 20 --nostream"
  exit 1
fi
