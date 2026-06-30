# Como colocar o sistema no ar (Railway.app)

## Pré-requisitos (fazer uma vez só)
- Conta no GitHub: https://github.com
- Conta no Railway: https://railway.app  (login com o GitHub)

---

## Passo 1 — Criar repositório no GitHub

1. Acesse https://github.com/new
2. Nome do repositório: `sistema-financeiro`
3. Marque **Privado** (seus dados ficam seguros)
4. Clique **Create repository**

---

## Passo 2 — Enviar os arquivos pela primeira vez

Abra o Terminal (Windows: pesquise "cmd" no menu iniciar) e rode:

```bash
cd "C:\Users\ric_m\Claude\Projects\SISTEMA FINANCEIRO"
git init
git add .
git commit -m "versão inicial"
git remote add origin https://github.com/SEU_USUARIO/sistema-financeiro.git
git push -u origin main
```

> Substitua `SEU_USUARIO` pelo seu nome de usuário do GitHub

---

## Passo 3 — Criar o projeto no Railway

1. Acesse https://railway.app e clique em **New Project**
2. Escolha **Deploy from GitHub repo**
3. Selecione o repositório `sistema-financeiro`
4. Railway detecta o `package.json` e inicia o deploy automaticamente

---

## Passo 4 — Configurar o token secreto

No Railway, acesse seu projeto → **Variables** → **Add Variable**:

| Nome         | Valor                              |
|--------------|------------------------------------|
| `APP_TOKEN`  | (gere em uuidgenerator.net)        |
| `NODE_ENV`   | production                         |

> O token é como a senha do sistema — guarde-o bem

---

## Passo 5 — Acessar o sistema

Railway gera um link como: `https://sistema-financeiro-production.up.railway.app`

Acesse pelo link, faça login e pronto — todos na equipe usam o mesmo link.

---

## Como atualizar após edições no Claude/Cowork

Cada vez que o arquivo for editado aqui, basta rodar no Terminal:

```bash
cd "C:\Users\ric_m\Claude\Projects\SISTEMA FINANCEIRO"
git add .
git commit -m "atualização sistema"
git push
```

Railway detecta o push e **redeploya automaticamente** em ~1 minuto.
O banco de dados e os lançamentos são preservados.

---

## Backup dos dados

Acesse: `https://seu-link.railway.app/api/backup?token=SEU_TOKEN`

Isso baixa um arquivo JSON com todos os dados — salve periodicamente.

---

## Custo estimado
- Railway Hobby Plan: **~US$ 5/mês** (~R$ 28/mês)
- Banco de dados: incluído (SQLite no próprio servidor)
