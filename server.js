const express  = require('express');
const Database = require('better-sqlite3');
const path     = require('path');
const fs       = require('fs');
const crypto   = require('crypto');

const app  = express();
const PORT = process.env.PORT || 3000;
const TOKEN = process.env.APP_TOKEN || 'trocar-este-token-secreto';
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'sistema.db');

// ── Garantir que a pasta data existe ─────────────────────────────────────
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

// ── Banco de dados SQLite ─────────────────────────────────────────────────
const db = new Database(DB_PATH);
db.exec(`
  CREATE TABLE IF NOT EXISTS app_data (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT DEFAULT (datetime('now','localtime'))
  );
  CREATE TABLE IF NOT EXISTS audit_log (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    action     TEXT,
    user_login TEXT,
    ip         TEXT,
    ts         TEXT DEFAULT (datetime('now','localtime'))
  );
`);

// ── Middlewares ───────────────────────────────────────────────────────────
app.use(express.json({ limit: '50mb' }));
// Serve o HTML principal com o token injetado
app.get('/', (req, res) => {
  let html = fs.readFileSync(path.join(__dirname, 'Sistema Financeiro.html'), 'utf8');
  html = html.replace("window._APP_TOKEN || ''", JSON.stringify(TOKEN));
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.send(html);
});
app.use(express.static(__dirname));

// ── Verificação de token ──────────────────────────────────────────────────
function checkToken(req, res, next) {
  const tok = req.headers['x-app-token'] || req.query.token;
  if (!tok || !crypto.timingSafeEqual(Buffer.from(tok), Buffer.from(TOKEN))) {
    return res.status(401).json({ error: 'Token inválido.' });
  }
  next();
}

// ── GET /api/load  — retorna o ROOT JSON ─────────────────────────────────
app.get('/api/load', checkToken, (req, res) => {
  const row = db.prepare("SELECT value FROM app_data WHERE key='root'").get();
  if (!row) return res.json(null);
  try { res.json(JSON.parse(row.value)); }
  catch(e) { res.status(500).json({ error: 'Erro ao ler dados.' }); }
});

// ── POST /api/save  — grava o ROOT JSON ──────────────────────────────────
app.post('/api/save', checkToken, (req, res) => {
  const data = req.body;
  if (!data || !data.empresas) return res.status(400).json({ error: 'Payload inválido.' });
  const json = JSON.stringify(data);
  db.prepare(`
    INSERT INTO app_data(key, value, updated_at)
    VALUES('root', ?, datetime('now','localtime'))
    ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at
  `).run(json);
  // Log de auditoria (registra qual usuário salvou)
  const user = data.usuarios && data._lastUser ? data._lastUser : '?';
  const ip   = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  db.prepare("INSERT INTO audit_log(action,user_login,ip) VALUES('save',?,?)").run(user, ip);
  res.json({ ok: true, ts: new Date().toISOString() });
});

// ── GET /api/backup  — download do banco em JSON ─────────────────────────
app.get('/api/backup', checkToken, (req, res) => {
  const row = db.prepare("SELECT value, updated_at FROM app_data WHERE key='root'").get();
  if (!row) return res.status(404).json({ error: 'Sem dados.' });
  const filename = `backup_${new Date().toISOString().slice(0,10)}.json`;
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Content-Type', 'application/json');
  res.send(row.value);
});

// ── GET /api/status  — healthcheck público ───────────────────────────────
app.get('/api/status', (req, res) => {
  const row = db.prepare("SELECT updated_at FROM app_data WHERE key='root'").get();
  res.json({ ok: true, last_save: row ? row.updated_at : null, version: '1.0' });
});

// ── Todas as rotas desconhecidas → entrega o HTML ─────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'Sistema Financeiro.html'));
});

app.listen(PORT, () => {
  console.log(`✅ Sistema Financeiro rodando na porta ${PORT}`);
  console.log(`   Banco: ${DB_PATH}`);
});
