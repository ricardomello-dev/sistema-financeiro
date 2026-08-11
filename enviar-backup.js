// Envia um arquivo de backup por e-mail, usando o mesmo SMTP do sistema.
//   node enviar-backup.js /caminho/do/arquivo.enc "assunto opcional"
// Lê SMTP_* e BACKUP_EMAIL do .env.

try { require('dotenv').config(); } catch (e) {}
const fs   = require('fs');
const path = require('path');

const arquivo = process.argv[2];
if (!arquivo || !fs.existsSync(arquivo)) {
  console.error('ERRO: informe o caminho de um arquivo existente.');
  process.exit(1);
}

const SMTP_HOST = process.env.SMTP_HOST || '';
const SMTP_PORT = +(process.env.SMTP_PORT || 587);
const SMTP_USER = process.env.SMTP_USER || '';
const SMTP_PASS = process.env.SMTP_PASS || '';
const SMTP_FROM = process.env.SMTP_FROM || SMTP_USER;
const DESTINO   = process.env.BACKUP_EMAIL || SMTP_USER;

if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS) {
  console.error('ERRO: SMTP não configurado no .env.');
  process.exit(1);
}

const st = fs.statSync(arquivo);
const mb = (st.size / 1024 / 1024).toFixed(2);
if (st.size > 20 * 1024 * 1024) {
  console.error(`ERRO: arquivo de ${mb} MB — grande demais para anexo de e-mail (limite ~20 MB).`);
  process.exit(1);
}

const nodemailer = require('nodemailer');
const mailer = nodemailer.createTransport({
  host: SMTP_HOST, port: SMTP_PORT, secure: SMTP_PORT === 465,
  auth: { user: SMTP_USER, pass: SMTP_PASS }
});

const nome = path.basename(arquivo);
const hoje = new Date().toLocaleString('pt-BR');
const cifrado = nome.endsWith('.enc');

mailer.sendMail({
  from: SMTP_FROM,
  to: DESTINO,
  subject: `[Backup] Sistema Financeiro — ${new Date().toISOString().slice(0, 10)}`,
  text:
`Cópia de segurança do Sistema Financeiro.

Arquivo:  ${nome}
Tamanho:  ${mb} MB
Gerado:   ${hoje}
${cifrado ? `
O arquivo está CRIPTOGRAFADO. Para abrir, é preciso a senha guardada
no servidor em /var/www/sistema-financeiro/.env.backup (e, esperamos,
também no seu gerenciador de senhas).

Para descriptografar e descompactar, em um terminal Linux ou Mac:
  openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -in ${nome} -out backup.db.gz
  gunzip backup.db.gz
` : ''}
Guarde este e-mail. Ele é a sua cópia fora do servidor: se a VPS for
perdida por completo, é por aqui que os dados voltam.

--
Mensagem automática do Sistema Financeiro.`,
  attachments: [{ filename: nome, path: arquivo }]
})
.then(() => { console.log(`E-mail enviado para ${DESTINO} (${mb} MB).`); process.exit(0); })
.catch(e  => { console.error('ERRO ao enviar:', e.message); process.exit(1); });
