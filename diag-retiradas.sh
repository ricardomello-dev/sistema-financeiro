#!/bin/bash
# Mostra de onde vem cada movimento do placar de retiradas. Nao altera nada.
#   bash /var/www/sistema-financeiro/diag-retiradas.sh

set -u
DB=/var/www/sistema-financeiro/data/sistema.db
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
sqlite3 "$DB" "SELECT value FROM app_data WHERE key='root';" > "$TMP/r.json"

node -e '
const fs = require("fs");
const R = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const norm = s => String(s||"").normalize("NFD").replace(/[̀-ͯ]/g,"").trim().toUpperCase();
const so = s => String(s||"").replace(/\D/g,"");
const brl = v => (v<0?"-":"") + "R$ " + Math.abs(v).toLocaleString("pt-BR",{minimumFractionDigits:2});

for (const g of R.grupos || []) {
  const cfg = g.ret || {};
  const socios = (cfg.socios || []).filter(s => (s.nome||"").trim());
  const emps = (g.empresas || []).map(id => (R.empresas||[]).find(e => e.id === id)).filter(Boolean);

  console.log("");
  console.log("=".repeat(78));
  console.log("GRUPO: " + g.nome);
  console.log("EMPRESAS DO GRUPO: " + (emps.map(e=>e.nome).join(", ") || "(nenhuma)"));
  console.log("SOCIOS CADASTRADOS NESTE GRUPO:");
  for (const s of socios) {
    console.log("   - " + s.nome + "  (ja retirado antes: " + (s.saldoIni||0) + ")");
    for (const p of s.pessoas || [])
      console.log("       recebe por ele: \"" + p.nome + "\"  doc:" + (p.doc||"-") + "  rel:" + (p.rel||"-"));
  }

  // indice nome/doc -> socio, igual ao do sistema
  const porNome = new Map(), porDoc = new Map();
  for (const s of socios) for (const p of s.pessoas || []) {
    if (p.nome) porNome.set(norm(p.nome), s);
    const d = so(p.doc); if (d) porDoc.set(d, s);
  }

  const tot = {};
  socios.forEach(s => tot[s.id] = { ret:0, ap:0, n:0, porEmp:{} });

  console.log("");
  console.log("MOVIMENTOS QUE ENTRAM NO PLACAR:");
  console.log("");
  for (const e of emps) {
    const db = e.db || {};
    for (const l of db.lancs || []) {
      if (!l.v) continue;
      const ov = (cfg.over || {})[e.id + "|" + l.id];
      let s = null, via = "";
      if (ov !== undefined) { if (!ov) continue; s = socios.find(x => x.id === ov); via = "ATRIBUICAO MANUAL"; }
      else if (l.fav) {
        s = porNome.get(norm(l.fav)); via = "nome do favorecido";
        if (!s) {
          const f = (db.favorecidos || []).find(x => norm(x.nome) === norm(l.fav));
          if (f && so(f.doc) && porDoc.has(so(f.doc))) { s = porDoc.get(so(f.doc)); via = "CPF/CNPJ do cadastro"; }
        }
      }
      if (!s) continue;
      const t = tot[s.id]; if (!t) continue;
      const v = Math.abs(l.v);
      if (l.v < 0) t.ret += v; else t.ap += v;
      t.n++; t.porEmp[e.nome] = (t.porEmp[e.nome]||0) + (l.v < 0 ? v : -v);
      console.log("  [LANCAMENTO] " + (l.data||"?") + "  " + e.nome);
      console.log("               favorecido no lancamento: \"" + (l.fav||"") + "\"");
      console.log("               casou com o socio: " + s.nome + "  (via " + via + ")");
      console.log("               " + (l.v<0 ? "RETIRADA " : "aporte  ") + brl(v) + "   hist: " + (l.hist||"").slice(0,60));
      console.log("");
    }
  }
  for (const a of cfg.ajustes || []) {
    const dentro = (g.empresas||[]).includes(a.empId);
    const s = socios.find(x => x.id === a.socioId);
    const en = ((R.empresas||[]).find(e => e.id === a.empId) || {}).nome || "(empresa removida)";
    if (!s) continue;
    console.log("  [ACERTO MANUAL] " + (a.data||"?") + "  " + en + (dentro ? "" : "   <<< FORA DO GRUPO, NAO CONTA"));
    console.log("                  socio: " + s.nome + "   " + a.tipo + "  " + brl(Math.abs(a.valor||0)));
    console.log("                  desc: " + (a.desc||""));
    console.log("");
    if (!dentro) continue;
    const t = tot[s.id]; if (!t) continue;
    const v = Math.abs(a.valor||0);
    if (a.tipo === "aporte") t.ap += v; else t.ret += v;
    t.n++; t.porEmp[en] = (t.porEmp[en]||0) + (a.tipo === "aporte" ? -v : v);
  }

  console.log("PLACAR CALCULADO (confira com a tela):");
  let soma = 0;
  for (const s of socios) {
    const t = tot[s.id];
    const liq = t.ret + (s.saldoIni||0) - t.ap;
    soma += liq;
    console.log("  " + s.nome.padEnd(34) + "liquido " + brl(liq).padStart(16) + "   " + t.n + " movimento(s)");
    Object.entries(t.porEmp).forEach(([n,v]) => console.log("        de " + n + ": " + brl(v)));
    if (s.saldoIni) console.log("        ja retirado antes do sistema: " + brl(s.saldoIni));
  }
  console.log("  TOTAL DO GRUPO: " + brl(soma) + "   / " + socios.length + " socios = " + brl(soma/(socios.length||1)) + " esperado para cada");
}
' "$TMP/r.json"
