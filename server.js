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
  CREATE TABLE IF NOT EXISTS sessions (
    token      TEXT PRIMARY KEY,
    user_id    INTEGER NOT NULL,
    login      TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    last_seen  INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    ip         TEXT,
    agent      TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_sessions_exp ON sessions(expires_at);
  CREATE TABLE IF NOT EXISTS login_fails (
    login     TEXT NOT NULL,
    ts        INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_fails ON login_fails(login, ts);
`);

// ── Middlewares ───────────────────────────────────────────────────────────
app.use(express.json({ limit: '50mb' }));

// Cabeçalhos de segurança em toda resposta
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
  next();
});

// Serve o HTML principal. Não injeta mais segredo nenhum — só marca que há servidor.
function enviarApp(req, res) {
  let html = fs.readFileSync(path.join(__dirname, 'Sistema Financeiro.html'), 'utf8');
  html = html.replace('window._SF_SERVER_FLAG', 'true');
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.send(html);
}
app.get('/', enviarApp);

// ATENÇÃO: NÃO reative express.static(__dirname).
// Isso publicava por HTTP o diretório inteiro da aplicação — inclusive
// data/sistema.db (com hashes de senha e tokens de sessão), server.js,
// os .ofx/.csv e o histórico de lançamentos. O app é um arquivo único,
// servido por enviarApp(); não há assets estáticos a expor.

// ── Sessões ───────────────────────────────────────────────────────────────
const SESSAO_IDLE  = 8  * 60 * 60 * 1000;   // 8 h sem uso encerra
const SESSAO_MAX   = 24 * 60 * 60 * 1000;   // 24 h de duração máxima
const COOKIE_NOME  = 'sf_sess';

function lerCookie(req, nome) {
  const raw = req.headers.cookie || '';
  for (const parte of raw.split(';')) {
    const i = parte.indexOf('=');
    if (i < 0) continue;
    if (parte.slice(0, i).trim() === nome) return decodeURIComponent(parte.slice(i + 1).trim());
  }
  return null;
}
// Secure é ligado por padrão. Só desligue em desenvolvimento local (http://localhost),
// onde o navegador descartaria o cookie e o login entraria em laço.
const COOKIE_SECURE = String(process.env.COOKIE_INSECURE || '') !== '1';
function atributosCookie(maxAgeMs) {
  const p = [`Path=/`, 'HttpOnly', 'SameSite=Strict', `Max-Age=${Math.floor(maxAgeMs / 1000)}`];
  if (COOKIE_SECURE) p.push('Secure');
  return p;
}
function definirCookie(res, token, maxAgeMs) {
  res.setHeader('Set-Cookie',
    [`${COOKIE_NOME}=${encodeURIComponent(token)}`].concat(atributosCookie(maxAgeMs)).join('; '));
}
function limparCookie(res) {
  res.setHeader('Set-Cookie', [`${COOKIE_NOME}=`].concat(atributosCookie(0)).join('; '));
}
function limparSessoesVencidas() {
  db.prepare("DELETE FROM sessions WHERE expires_at < ?").run(Date.now());
  db.prepare("DELETE FROM login_fails WHERE ts < ?").run(Date.now() - 60 * 60 * 1000);
  db.prepare("DELETE FROM password_resets WHERE expires_at < ?").run(Date.now() - 24 * 60 * 60 * 1000);
}
setInterval(limparSessoesVencidas, 30 * 60 * 1000).unref();
limparSessoesVencidas();

// Middleware: exige sessão válida
function exigeSessao(req, res, next) {
  const tok = lerCookie(req, COOKIE_NOME);
  if (!tok) return res.status(401).json({ error: 'Sessão não encontrada.', semSessao: true });
  const s = db.prepare("SELECT * FROM sessions WHERE token=?").get(tok);
  const agora = Date.now();
  if (!s || s.expires_at < agora || (agora - s.last_seen) > SESSAO_IDLE) {
    if (s) db.prepare("DELETE FROM sessions WHERE token=?").run(tok);
    limparCookie(res);
    return res.status(401).json({ error: 'Sessão expirada. Entre novamente.', semSessao: true });
  }
  db.prepare("UPDATE sessions SET last_seen=? WHERE token=?").run(agora, tok);
  req.sessao = s;
  next();
}
function ipDe(req) { return req.headers['x-forwarded-for'] || req.socket.remoteAddress || ''; }

// ── Senhas: scrypt (novo) com aceitação do sha256 antigo durante a migração ──
function scryptHash(pw, salt) {
  return crypto.scryptSync(pw, salt, 64, { N: 16384, r: 8, p: 1 }).toString('hex');
}
function confereSenha(u, pw) {
  if (!u || !u.hash || !u.salt) return false;
  if (u.pwAlg === 'scrypt') {
    const calc = Buffer.from(scryptHash(pw, u.salt), 'hex');
    const guard = Buffer.from(u.hash, 'hex');
    return calc.length === guard.length && crypto.timingSafeEqual(calc, guard);
  }
  // formato antigo: sha256(salt + '|' + senha)
  const calc = Buffer.from(hashPw(pw, u.salt), 'hex');
  const guard = Buffer.from(u.hash, 'hex');
  return calc.length === guard.length && crypto.timingSafeEqual(calc, guard);
}
function aplicaSenha(u, pw) {   // sempre grava no formato novo
  u.salt = crypto.randomBytes(16).toString('hex');
  u.hash = scryptHash(pw, u.salt);
  u.pwAlg = 'scrypt';
}

// ── POST /api/login ───────────────────────────────────────────────────────
app.post('/api/login', (req, res) => {
  const login = String((req.body && req.body.login) || '').trim().toLowerCase();
  const senha = String((req.body && req.body.senha) || '');
  if (!login || !senha) return res.status(400).json({ error: 'Informe login e senha.' });

  // Bloqueio por tentativas: 5 falhas em 15 min, contadas por login E por IP.
  // Só por login, um atacante trancaria a conta alheia de propósito; só por IP,
  // ele testaria uma senha em centenas de logins diferentes.
  const janela = Date.now() - 15 * 60 * 1000;
  const ip = ipDe(req);
  const porLogin = db.prepare("SELECT COUNT(*) n FROM login_fails WHERE login=? AND ts>?").get(login, janela).n;
  const porIp    = db.prepare("SELECT COUNT(*) n FROM login_fails WHERE login=? AND ts>?").get('ip:' + ip, janela).n;
  if (porLogin >= 5 || porIp >= 20) {
    db.prepare("INSERT INTO audit_log(action,user_login,ip) VALUES('login_bloqueado',?,?)").run(login, ip);
    return res.status(429).json({ error: 'Muitas tentativas. Aguarde 15 minutos e tente de novo.' });
  }

  const root = lerRoot();
  const u = root && (root.usuarios || []).find(x => String(x.login || '').toLowerCase() === login);

  if (!u || !confereSenha(u, senha)) {
    // Usuário inexistente também paga o custo do scrypt: sem essa linha, a
    // diferença de tempo de resposta revelaria quais logins existem.
    if (!u) { try { scryptHash(senha, 'dummy-salt-constante'); } catch (e) {} }
    const agora = Date.now();
    db.prepare("INSERT INTO login_fails(login, ts) VALUES(?,?)").run(login, agora);
    db.prepare("INSERT INTO login_fails(login, ts) VALUES(?,?)").run('ip:' + ip, agora);
    db.prepare("INSERT INTO audit_log(action,user_login,ip) VALUES('login_falhou',?,?)").run(login, ip);
    // Mensagem idêntica em todos os casos — nada de "restam N tentativas",
    // que confirmaria a existência do login.
    return res.status(401).json({ error: 'Login ou senha incorretos.' });
  }

  // Sucesso: migra o hash antigo para scrypt sem o usuário perceber
  if (u.pwAlg !== 'scrypt') {
    aplicaSenha(u, senha);
    console.log(`[login] hash de ${u.login} migrado para scrypt`);
  }
  u.lastLogin = new Date().toISOString();
  gravarRoot(root);

  db.prepare("DELETE FROM login_fails WHERE login=?").run(login);
  const token = crypto.randomBytes(32).toString('hex');
  const agora = Date.now();
  db.prepare(`INSERT INTO sessions(token,user_id,login,created_at,last_seen,expires_at,ip,agent)
              VALUES(?,?,?,?,?,?,?,?)`)
    .run(token, u.id, u.login, agora, agora, agora + SESSAO_MAX, ipDe(req), String(req.headers['user-agent'] || '').slice(0, 200));
  definirCookie(res, token, SESSAO_MAX);
  db.prepare("INSERT INTO audit_log(action,user_login,ip) VALUES('login_ok',?,?)").run(u.login, ipDe(req));
  res.json({ ok: true, id: u.id, nome: u.nome, login: u.login });
});

// ── POST /api/logout ──────────────────────────────────────────────────────
app.post('/api/logout', (req, res) => {
  const tok = lerCookie(req, COOKIE_NOME);
  if (tok) {
    const s = db.prepare("SELECT login FROM sessions WHERE token=?").get(tok);
    db.prepare("DELETE FROM sessions WHERE token=?").run(tok);
    if (s) db.prepare("INSERT INTO audit_log(action,user_login,ip) VALUES('logout',?,?)").run(s.login, ipDe(req));
  }
  limparCookie(res);
  res.json({ ok: true });
});

// ── GET /api/me — o cliente checa se a sessão continua de pé ──────────────
app.get('/api/me', (req, res) => {
  const tok = lerCookie(req, COOKIE_NOME);
  if (!tok) return res.status(401).json({ error: 'Sem sessão.' });
  const s = db.prepare("SELECT * FROM sessions WHERE token=?").get(tok);
  const agora = Date.now();
  if (!s || s.expires_at < agora || (agora - s.last_seen) > SESSAO_IDLE) {
    if (s) db.prepare("DELETE FROM sessions WHERE token=?").run(tok);
    limparCookie(res);
    return res.status(401).json({ error: 'Sessão expirada.' });
  }
  db.prepare("UPDATE sessions SET last_seen=? WHERE token=?").run(agora, tok);
  res.json({ ok: true, id: s.user_id, login: s.login });
});

// Remove credenciais antes de qualquer coisa sair do servidor.
// Sem isso, o usuário de menor privilégio baixa os hashes de todos os admins
// e ataca offline à vontade.
function semSegredos(root) {
  const copia = JSON.parse(JSON.stringify(root));
  copia.usuarios = (copia.usuarios || []).map(u => {
    const { salt, hash, pwAlg, ...resto } = u;
    return resto;
  });
  return copia;
}

// ── GET /api/load  — retorna o ROOT JSON (sem credenciais) ───────────────
app.get('/api/load', exigeSessao, (req, res) => {
  const row = db.prepare("SELECT value FROM app_data WHERE key='root'").get();
  if (!row) return res.json(null);
  try { res.json(semSegredos(JSON.parse(row.value))); }
  catch(e) { res.status(500).json({ error: 'Erro ao ler dados.' }); }
});

// Resolve as permissões efetivas de um usuário a partir do perfil dele.
function permsDe(root, u) {
  if (!u) return {};
  if (u.admin) return { all: true };
  const pf = (root.perfis || []).find(p => p.id === (u.perfilId || 2));
  return (pf && pf.perms) || {};
}
function podeGravar(root, u) {
  const p = permsDe(root, u);
  return !!(p.all || p.editar);
}

// ── POST /api/save  — grava o ROOT JSON ──────────────────────────────────
app.post('/api/save', exigeSessao, (req, res) => {
  const data = req.body;
  // Validação estrita. Aceitar payload incompleto já apagou a lista de usuários
  // em teste — e com ela some o controle de acesso inteiro.
  if (!data || !Array.isArray(data.empresas) || !Array.isArray(data.usuarios))
    return res.status(400).json({ error: 'Payload inválido.' });

  const atual = lerRoot();
  if (!atual || !Array.isArray(atual.usuarios))
    return res.status(500).json({ error: 'Base inconsistente — gravação recusada.' });

  const eu = atual.usuarios.find(x => x.id === req.sessao.user_id);
  if (!eu) return res.status(403).json({ error: 'Usuário da sessão não existe mais.' });

  // Perfil somente leitura não grava, ponto. A checagem no navegador é conforto
  // de interface; a que vale é esta.
  if (!podeGravar(atual, eu))
    return res.status(403).json({ error: 'Seu perfil é somente leitura.' });

  const souAdmin = !!eu.admin;
  if (!souAdmin) {
    // Não-admin não mexe em usuários nem em perfis, nem por acidente
    data.usuarios = atual.usuarios;
    data.perfis   = atual.perfis;
  } else {
    // Credenciais NUNCA vêm do cliente — nem para usuário novo.
    // Quem define senha é o /api/definir-senha, que audita e derruba sessões.
    const logins = new Set();
    for (const nu of data.usuarios) {
      delete nu.salt; delete nu.hash; delete nu.pwAlg;
      const velho = atual.usuarios.find(x => x.id === nu.id);
      if (velho) { nu.salt = velho.salt; nu.hash = velho.hash; nu.pwAlg = velho.pwAlg; }
      const lg = String(nu.login || '').toLowerCase();
      if (logins.has(lg)) return res.status(400).json({ error: 'Há dois usuários com o mesmo login: ' + lg });
      logins.add(lg);
    }
    if (!data.usuarios.some(u => u.admin))
      return res.status(400).json({ error: 'É preciso manter ao menos um administrador.' });
  }

  const json = JSON.stringify(data);
  db.prepare(`
    INSERT INTO app_data(key, value, updated_at)
    VALUES('root', ?, datetime('now','localtime'))
    ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at
  `).run(json);
  // Auditoria com o login da SESSÃO — o cliente não escolhe quem assina a gravação
  db.prepare("INSERT INTO audit_log(action,user_login,ip) VALUES('save',?,?)")
    .run(req.sessao.login, ipDe(req));
  res.json({ ok: true, ts: new Date().toISOString() });
});

// ── POST /api/definir-senha — admin define a senha de alguém; ou você troca a sua ──
app.post('/api/definir-senha', exigeSessao, (req, res) => {
  const alvoId = +((req.body && req.body.userId) || 0);
  const nova   = String((req.body && req.body.senha) || '');
  const atualPw= String((req.body && req.body.senhaAtual) || '');
  if (nova.length < 6) return res.status(400).json({ error: 'A senha deve ter ao menos 6 caracteres.' });

  const root = lerRoot();
  if (!root) return res.status(500).json({ error: 'Base indisponível.' });
  const eu   = (root.usuarios || []).find(x => x.id === req.sessao.user_id);
  const alvo = (root.usuarios || []).find(x => x.id === (alvoId || req.sessao.user_id));
  if (!eu || !alvo) return res.status(404).json({ error: 'Usuário não encontrado.' });

  const proprio = alvo.id === eu.id;
  if (!proprio && !eu.admin) return res.status(403).json({ error: 'Apenas administradores alteram a senha de outros usuários.' });
  // Trocar a própria senha exige confirmar a atual
  if (proprio && !confereSenha(eu, atualPw)) return res.status(401).json({ error: 'Senha atual incorreta.' });

  aplicaSenha(alvo, nova);
  gravarRoot(root);
  // Encerra as outras sessões do usuário afetado
  db.prepare("DELETE FROM sessions WHERE user_id=? AND token<>?").run(alvo.id, lerCookie(req, COOKIE_NOME) || '');
  db.prepare("INSERT INTO audit_log(action,user_login,ip) VALUES(?,?,?)")
    .run(proprio ? 'senha_alterada' : 'senha_definida_por_admin', alvo.login, ipDe(req));
  res.json({ ok: true });
});

// ── GET /api/tem-usuarios — o cliente decide entre tela de login e setup inicial ──
app.get('/api/tem-usuarios', (req, res) => {
  const root = lerRoot();
  res.json({ tem: !!(root && (root.usuarios || []).length) });
});

// ── POST /api/setup-inicial — cria o primeiro administrador (só se não houver nenhum) ──
const criarPrimeiroAdmin = db.transaction((base, u) => {
  // Relê dentro da transação: fecha a janela entre checar e gravar,
  // que permitiria dois "primeiros administradores" simultâneos.
  const atual = lerRoot();
  if (atual && (atual.usuarios || []).length) throw new Error('JA_TEM_USUARIOS');
  base.usuarios = [u];
  gravarRoot(base);
});
app.post('/api/setup-inicial', (req, res) => {
  const root = lerRoot();
  if (root && (root.usuarios || []).length) return res.status(403).json({ error: 'O sistema já possui usuários.' });
  const nome  = String((req.body && req.body.nome) || '').trim();
  const login = String((req.body && req.body.login) || '').trim().toLowerCase();
  const senha = String((req.body && req.body.senha) || '');
  const email = String((req.body && req.body.email) || '').trim().toLowerCase();
  if (!nome || !login) return res.status(400).json({ error: 'Informe nome e login.' });
  if (senha.length < 6) return res.status(400).json({ error: 'A senha deve ter ao menos 6 caracteres.' });

  const base = root || { empresas: [], usuarios: [], perfis: [], cfg: { ai: null }, empAtual: 1, lastBkp: null };
  const u = { id: 1, nome, login, email, admin: true, perfilId: 1, empresas: [], lastLogin: null };
  aplicaSenha(u, senha);
  try { criarPrimeiroAdmin(base, u); }
  catch (e) {
    if (e.message === 'JA_TEM_USUARIOS') return res.status(403).json({ error: 'O sistema já possui usuários.' });
    throw e;
  }
  db.prepare("INSERT INTO audit_log(action,user_login,ip) VALUES('setup_inicial',?,?)").run(login, ipDe(req));
  res.json({ ok: true });
});

// ── GET /api/backup  — download do banco em JSON ─────────────────────────
app.get('/api/backup', exigeSessao, (req, res) => {
  const root = lerRoot();
  if (!root) return res.status(404).json({ error: 'Sem dados.' });
  const eu = (root.usuarios || []).find(x => x.id === req.sessao.user_id);
  if (!eu || !eu.admin) return res.status(403).json({ error: 'Apenas administradores baixam o backup completo.' });
  const filename = `backup_${new Date().toISOString().slice(0,10)}.json`;
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Content-Type', 'application/json');
  db.prepare("INSERT INTO audit_log(action,user_login,ip) VALUES('backup_baixado',?,?)").run(eu.login, ipDe(req));
  res.send(JSON.stringify(semSegredos(root)));
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
    // Responde já: esperar o envio faria o tempo de resposta denunciar
    // quais logins existem de verdade.
    res.json(resposta);
    mailer.sendMail({
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
    })
    .then(()  => console.log(`[recuperar] link enviado para ${u.email} (usuário ${u.login})`))
    .catch(e  => console.error('[recuperar] falha no envio:', e.message));
    db.prepare("INSERT INTO audit_log(action,user_login,ip) VALUES('reset_solicitado',?,?)").run(u.login, ipDe(req));
    return;   // a resposta já foi enviada acima
  } catch (e) {
    console.error('[recuperar] erro:', e.message);
    if (!res.headersSent) return res.status(500).json({ error: 'Não foi possível processar o pedido.' });
    return;
  }
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

  aplicaSenha(u, pw);            // scrypt
  gravarRoot(root);
  db.prepare("UPDATE password_resets SET used=1 WHERE token=?").run(t);
  db.prepare("DELETE FROM sessions WHERE user_id=?").run(u.id);   // derruba sessões abertas
  db.prepare("DELETE FROM login_fails WHERE login=?").run(u.login);
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
// Usa o MESMO handler da raiz: enviar o arquivo cru deixaria o app achar que
// não há servidor e cair no modo localStorage, com autenticação no navegador.
app.get('*', (req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Rota não encontrada.' });
  enviarApp(req, res);
});

app.listen(PORT, () => {
  console.log(`✅ Sistema Financeiro rodando na porta ${PORT}`);
  console.log(`   Banco: ${DB_PATH}`);
});
