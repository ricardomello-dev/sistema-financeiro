try { require('dotenv').config(); } catch (e) { /* dotenv opcional */ }

const express  = require('express');
const Database = require('better-sqlite3');
const path     = require('path');
const fs       = require('fs');
const crypto   = require('crypto');

const app  = express();
const PORT = process.env.PORT || 3000;
const TOKEN = process.env.APP_TOKEN || 'trocar-este-token-secreto';
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'sistema.db');

// ── Configuração de e-mail (recuperação de senha) ────────────────────────
const APP_URL   = process.env.APP_URL   || 'https://finance.aliancebrasil.com.br';
const SMTP_HOST = process.env.SMTP_HOST || '';
const SMTP_PORT = +(process.env.SMTP_PORT || 587);
const SMTP_USER = process.env.SMTP_USER || '';
const SMTP_PASS = process.env.SMTP_PASS || '';
const SMTP_FROM = process.env.SMTP_FROM || SMTP_USER;
const SMTP_ON   = !!(SMTP_HOST && SMTP_USER && SMTP_PASS);

let nodemailer = null, mailer = null;
if (SMTP_ON) {
  try {
    nodemailer = require('nodemailer');
    mailer = nodemailer.createTransport({
      host: SMTP_HOST,
      port: SMTP_PORT,
      secure: SMTP_PORT === 465,
      auth: { user: SMTP_USER, pass: SMTP_PASS }
    });
    console.log(`✉️  SMTP configurado: ${SMTP_USER} via ${SMTP_HOST}:${SMTP_PORT}`);
  } catch (e) {
    console.warn('⚠️  nodemailer não instalado — recuperação de senha desativada. Rode: npm install nodemailer');
  }
} else {
  console.warn('⚠️  SMTP não configurado — recuperação de senha desativada. Preencha SMTP_* no .env');
}

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
  CREATE TABLE IF NOT EXISTS password_resets (
    token      TEXT PRIMARY KEY,
    login      TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    used       INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now','localtime'))
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
  const a = Buffer.from(String(tok || ''));
  const b = Buffer.from(TOKEN);
  // timingSafeEqual lança exceção se os tamanhos diferirem — compare antes
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
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

// ── Recuperação de senha ─────────────────────────────────────────────────
// O hash é o mesmo do cliente: sha256(salt + '|' + senha), em UTF-8.
function hashPw(pw, salt) {
  return crypto.createHash('sha256').update(salt + '|' + pw, 'utf8').digest('hex');
}
function rndSalt() {
  return crypto.randomBytes(9).toString('base64url');
}
function lerRoot() {
  const row = db.prepare("SELECT value FROM app_data WHERE key='root'").get();
  return row ? JSON.parse(row.value) : null;
}
function gravarRoot(data) {
  db.prepare(`
    INSERT INTO app_data(key, value, updated_at)
    VALUES('root', ?, datetime('now','localtime'))
    ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at
  `).run(JSON.stringify(data));
}

// Limite simples: no máximo 5 pedidos por login a cada 15 minutos
const tentativas = new Map();
function limiteExcedido(chave) {
  const agora = Date.now(), janela = 15 * 60 * 1000;
  const reg = (tentativas.get(chave) || []).filter(t => agora - t < janela);
  reg.push(agora);
  tentativas.set(chave, reg);
  return reg.length > 5;
}

app.get('/api/recuperar-disponivel', (req, res) => res.json({ ok: !!mailer }));

// POST /api/recuperar-senha  { login }  — sempre responde ok, para não revelar quem existe
app.post('/api/recuperar-senha', async (req, res) => {
  const alvo = String((req.body && req.body.login) || '').trim().toLowerCase();
  if (!alvo) return res.status(400).json({ error: 'Informe o login ou e-mail.' });
  if (!mailer) return res.status(503).json({ error: 'O envio de e-mail não está configurado neste servidor. Peça a redefinição a um administrador.' });
  if (limiteExcedido(alvo)) return res.status(429).json({ error: 'Muitas tentativas. Aguarde 15 minutos.' });

  const resposta = { ok: true };   // resposta idêntica exista ou não o usuário
  try {
    const root = lerRoot();
    const u = root && (root.usuarios || []).find(
      x => String(x.login || '').toLowerCase() === alvo || String(x.email || '').toLowerCase() === alvo
    );
    if (!u || !u.email) {
      console.log(`[recuperar] pedido para "${alvo}" — sem usuário ou sem e-mail cadastrado`);
      return res.json(resposta);
    }

    const token = crypto.randomBytes(32).toString('hex');
    const expira = Date.now() + 60 * 60 * 1000;   // 1 hora
    db.prepare("DELETE FROM password_resets WHERE login=? AND used=0").run(u.login);
    db.prepare("INSERT INTO password_resets(token, login, expires_at) VALUES(?,?,?)").run(token, u.login, expira);

    const link = `${APP_URL}/?rt=${token}`;
    await mailer.sendMail({
      from: SMTP_FROM,
      to: u.email,
      subject: 'Redefinição de senha — Sistema Financeiro',
      text:
`Olá, ${u.nome}.

Recebemos um pedido para redefinir a senha da sua conta no Sistema Financeiro.

Abra o link abaixo para criar uma nova senha (válido por 1 hora):
${link}

Se não foi você que pediu, ignore esta mensagem — sua senha continua a mesma.`,
      html:
`<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#2d3748;max-width:520px">
  <h2 style="color:#1e3a5f;margin:0 0 14px">Redefinição de senha</h2>
  <p>Olá, <b>${escapeHtml(u.nome)}</b>.</p>
  <p>Recebemos um pedido para redefinir a senha da sua conta no <b>Sistema Financeiro</b>.</p>
  <p style="margin:24px 0">
    <a href="${link}" style="background:#2f80ed;color:#fff;padding:12px 22px;border-radius:6px;text-decoration:none;font-weight:600;display:inline-block">Criar nova senha</a>
  </p>
  <p style="font-size:12.5px;color:#718096">O link vale por <b>1 hora</b> e só pode ser usado uma vez.<br>
  Se o botão não funcionar, copie e cole no navegador:<br>
  <span style="word-break:break-all">${link}</span></p>
  <hr style="border:none;border-top:1px solid #e2e8f0;margin:20px 0">
  <p style="font-size:12px;color:#718096">Se não foi você que pediu, ignore esta mensagem — sua senha continua a mesma.</p>
</div>`
    });
    console.log(`[recuperar] link enviado para ${u.email} (usuário ${u.login})`);
    db.prepare("INSERT INTO audit_log(action,user_login,ip) VALUES('reset_solicitado',?,?)")
      .run(u.login, req.headers['x-forwarded-for'] || req.socket.remoteAddress);
  } catch (e) {
    console.error('[recuperar] erro:', e.message);
    return res.status(500).json({ error: 'Não foi possível enviar o e-mail. Avise o administrador.' });
  }
  res.json(resposta);
});

// GET /api/token-valido?t=...  — o cliente checa antes de mostrar o formulário
app.get('/api/token-valido', (req, res) => {
  const t = String(req.query.t || '');
  const r = db.prepare("SELECT login, expires_at, used FROM password_resets WHERE token=?").get(t);
  if (!r || r.used || r.expires_at < Date.now()) return res.json({ ok: false });
  const root = lerRoot();
  const u = root && (root.usuarios || []).find(x => x.login === r.login);
  res.json({ ok: true, nome: u ? u.nome : '', login: r.login });
});

// POST /api/redefinir-senha  { token, senha }
app.post('/api/redefinir-senha', (req, res) => {
  const t  = String((req.body && req.body.token) || '');
  const pw = String((req.body && req.body.senha) || '');
  if (pw.length < 6) return res.status(400).json({ error: 'A senha deve ter ao menos 6 caracteres.' });

  const r = db.prepare("SELECT login, expires_at, used FROM password_resets WHERE token=?").get(t);
  if (!r || r.used || r.expires_at < Date.now())
    return res.status(400).json({ error: 'Este link expirou ou já foi usado. Peça um novo.' });

  const root = lerRoot();
  const u = root && (root.usuarios || []).find(x => x.login === r.login);
  if (!u) return res.status(400).json({ error: 'Usuário não encontrado.' });

  u.salt = rndSalt();
  u.hash = hashPw(pw, u.salt);
  gravarRoot(root);
  db.prepare("UPDATE password_resets SET used=1 WHERE token=?").run(t);
  db.prepare("INSERT INTO audit_log(action,user_login,ip) VALUES('reset_concluido',?,?)")
    .run(u.login, req.headers['x-forwarded-for'] || req.socket.remoteAddress);
  console.log(`[recuperar] senha redefinida para ${u.login}`);
  res.json({ ok: true, login: u.login });
});

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g,
    c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}

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
