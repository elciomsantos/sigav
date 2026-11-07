# ATIVAR-DEPLOY-GITHUB — Deploy automático via GitHub Actions

> Runbook passo a passo para habilitar o job **`Deploy (produção)`** do
> workflow `CI` (`.github/workflows/ci.yml`).
> Versão do documento: 1.0 · Criado em 2026-11-07

---

## 1. Como o deploy funciona

O deploy é **opt-in**: só executa quando todas as condições abaixo são
verdadeiras.

1. O evento é um **push na branch `main`** (branches `fix/*` não fazem deploy).
2. A variável de repositório **`DEPLOY_ENABLED`** existe e vale exatamente
   `true`.
3. Os jobs `Backend`, `Frontend`, `E2E (Playwright)` e `Build Docker Images`
   terminaram com sucesso.
4. Os **4 secrets** de deploy existem e são válidos.

Fluxo resumido:

```text
push na main
   └─ CI: backend + frontend + e2e + build docker
        └─ Deploy (produção)  [environment: production]
             └─ SSH no servidor
                  └─ scripts/deploy/deploy-prod.sh
                       ├─ backup pré-deploy (RUN_BACKUP=1)
                       ├─ git fetch + checkout do SHA deployado
                       ├─ docker compose build
                       ├─ docker compose up -d
                       ├─ healthcheck do backend
                       └─ rollback automático em caso de falha
```

O job usa `environment: production`. Isso permite adicionar regras de proteção
(ex.: aprovação manual) em **Settings → Environments → production**.

---

## 2. Pré-requisitos no servidor

Execute os passos desta seção **no servidor de produção**.

### 2.1 Usuário de deploy

Recomenda-se um usuário dedicado (ex.: `deploy`), sem login interativo
necessário.

```bash
sudo useradd --create-home --shell /bin/bash deploy
sudo usermod -aG docker deploy
```

> Após adicionar ao grupo `docker`, o usuário precisa de uma **nova sessão
> SSH** para o grupo valer.

Valide o acesso ao Docker:

```bash
sudo -u deploy docker compose version
```

Saída esperada: versão do Docker Compose v2.

### 2.2 Repositório no caminho esperado

O workflow usa por padrão:

```text
/opt/controle-share-videos-v1.0
```

Crie o diretório e clone o repositório como o usuário `deploy`:

```bash
sudo mkdir -p /opt/controle-share-videos-v1.0
sudo chown -R deploy:deploy /opt/controle-share-videos-v1.0
sudo -u deploy git clone https://github.com/elciomsantos/controle-share-videos.git \
  /opt/controle-share-videos-v1.0
```

> Se o repositório for privado, o servidor também precisa de credencial de
> leitura (deploy key ou token) para o `git fetch` do script.

Garanta que o Git aceita o diretório:

```bash
sudo -u deploy git -C /opt/controle-share-videos-v1.0 status
```

Se aparecer `detected dubious ownership`, corrija o dono ou registre:

```bash
sudo -u deploy git config --global --add safe.directory \
  /opt/controle-share-videos-v1.0
```

### 2.3 Identificar o compose usado pelo sistema

O script de deploy usa **`docker-compose.prod.yml`** por padrão. Confirme qual
arquivo a stack em execução utiliza:

```bash
docker inspect controle-share-videos-backend \
  --format '{{ index .Config.Labels "com.docker.compose.project.config_files" }}'
```

- Retornou `docker-compose.yml` → produção padrão (backend/frontend/caddy com
  TLS via Caddy). Veja o ajuste na §4.
- Retornou `docker-compose.prod.yml` → produção Swarm/RAID6 com secrets
  externos. O padrão do script já atende.

### 2.4 Testar o backup pré-deploy (obrigatório)

O script executa `scripts/backup.sh` antes do deploy (`RUN_BACKUP=1`). **Se o
backup falhar, o deploy é abortado por segurança.**

Teste manualmente com o mesmo usuário do deploy:

```bash
sudo -u deploy bash -c '
  cd /opt/controle-share-videos-v1.0
  BACKUP_DIR=/opt/app/backups \
  NODE_ENV=production \
  GPG_RECIPIENT="seu-email-ou-key-id" \
  ./scripts/backup.sh
'
```

O script exige no host:

- comando `sqlite3`;
- comando `gpg`;
- `GPG_RECIPIENT` definido quando `NODE_ENV=production`;
- caminho correto do banco em `DB_FILE` (padrão:
  `/opt/app/backend/data/controle-videos.db`).

> **Atenção:** o deploy padrão (`docker-compose.yml`) guarda os dados em volume
> Docker, não em `/opt/app/backend/data`. Se o teste acima falhar por banco
> inexistente, ajuste `DB_FILE`/`DATA_DIR` ou o workflow antes de ativar o
> deploy. Veja a §4.3.

### 2.5 Criar a chave SSH de deploy

No seu computador (não no servidor de produção):

```bash
ssh-keygen -t ed25519 -a 100 -N "" \
  -C "github-actions-deploy" \
  -f ~/.ssh/gha-deploy
```

Isso gera:

- `~/.ssh/gha-deploy` — chave **privada** (vai para o secret `DEPLOY_SSH_KEY`);
- `~/.ssh/gha-deploy.pub` — chave **pública** (vai para o servidor).

Instale a chave pública no servidor:

```bash
ssh-copy-id -i ~/.ssh/gha-deploy.pub deploy@SEU_HOST
```

Alternativa sem `ssh-copy-id`:

```bash
cat ~/.ssh/gha-deploy.pub | ssh deploy@SEU_HOST '
  mkdir -p ~/.ssh &&
  chmod 700 ~/.ssh &&
  cat >> ~/.ssh/authorized_keys &&
  chmod 600 ~/.ssh/authorized_keys
'
```

Teste o login e o Docker com a chave:

```bash
ssh -i ~/.ssh/gha-deploy -o IdentitiesOnly=yes \
  deploy@SEU_HOST 'docker compose version'
```

O comando deve funcionar **sem pedir senha**.

---

## 3. Configurar no GitHub

Acesse o repositório no GitHub e vá em
**Settings → Secrets and variables → Actions**.

> **Erro comum:** criar um único secret/variable chamado `DEPLOY_PROD`
> contendo todos os valores. O workflow **não lê** esse nome. É preciso criar
> um item separado para cada nome abaixo.

### 3.1 Criar a variável

Aba **Variables** → **New repository variable**:

| Name | Value |
|---|---|
| `DEPLOY_ENABLED` | `true` |

`DEPLOY_ENABLED` é **variable**, não secret. O valor precisa ser exatamente
`true` (minúsculo).

### 3.2 Criar os 4 secrets

Aba **Secrets** → **New repository secret**. Crie uma entrada para cada nome:

| Name | Valor |
|---|---|
| `DEPLOY_HOST` | IP ou domínio do servidor, sem `http://` (ex.: `192.168.1.50`) |
| `DEPLOY_USER` | Usuário SSH de deploy (ex.: `deploy`) |
| `DEPLOY_PORT` | Porta SSH (ex.: `22`) |
| `DEPLOY_SSH_KEY` | Conteúdo completo da chave privada `~/.ssh/gha-deploy`, incluindo `BEGIN`/`END` |

Para o `DEPLOY_SSH_KEY`, copie o arquivo inteiro:

```bash
cat ~/.ssh/gha-deploy
```

### 3.3 Alternativa via GitHub CLI

```bash
REPO=elciomsantos/controle-share-videos

gh variable set DEPLOY_ENABLED --body true -R "$REPO"

gh secret set DEPLOY_HOST --body "SEU_HOST" -R "$REPO"
gh secret set DEPLOY_USER --body "deploy" -R "$REPO"
gh secret set DEPLOY_PORT --body "22" -R "$REPO"
gh secret set DEPLOY_SSH_KEY < ~/.ssh/gha-deploy -R "$REPO"
```

Para usar secrets no nível do environment `production` (em vez de repositório):

```bash
gh secret set DEPLOY_HOST --env production -R "$REPO"
```

Escolha **um** nível (repositório **ou** environment), não os dois.

### 3.4 Remover configuração antiga

Se existir um secret/variable `DEPLOY_PROD` criado por engano, remova:

```bash
gh variable delete DEPLOY_PROD -R "$REPO" 2>/dev/null || true
gh secret delete DEPLOY_PROD -R "$REPO" 2>/dev/null || true
```

### 3.5 Conferir os nomes cadastrados

```bash
gh variable list -R "$REPO"
gh secret list -R "$REPO"
```

O `DEPLOY_ENABLED` deve aparecer em **variables** e os quatro `DEPLOY_*` em
**secrets**.

---

## 4. Ajustes no workflow (conforme o servidor)

Os ajustes desta seção só são necessários se o servidor **não** usar os
padrões do script.

### 4.1 Compose diferente de `docker-compose.prod.yml`

O script `scripts/deploy/deploy-prod.sh` usa por padrão
`docker-compose.prod.yml`. Se o servidor usa `docker-compose.yml`, edite o
step `Deploy via SSH` em `.github/workflows/ci.yml` e passe `COMPOSE_FILE` no
comando remoto:

```yaml
          ssh -i ~/.ssh/deploy_key \
            -o StrictHostKeyChecking=no \
            -o UserKnownHostsFile=/dev/null \
            -o ConnectTimeout=20 \
            -p "${DEPLOY_PORT:-22}" \
            "${DEPLOY_USER}@${DEPLOY_HOST}" \
            "APP_DIR='/opt/controle-share-videos-v1.0' \
             RUN_BACKUP=1 \
             TARGET_REF='${TARGET_REF}' \
             COMPOSE_FILE='docker-compose.yml' bash -s" \
            < scripts/deploy/deploy-prod.sh
```

### 4.2 Caminho do repositório diferente

O trecho `${APP_DIR:-/opt/controle-share-videos-v1.0}` é expandido **no runner
do GitHub**, onde `APP_DIR` não está definido; portanto, o valor sempre cai no
default. Para usar outro caminho, troque o literal no comando remoto:

```yaml
            "APP_DIR='/srv/controle-share-videos' RUN_BACKUP=1 ..."
```

### 4.3 Backup incompatível com o compose padrão

Se o backup da §2.4 não funcionar com o volume Docker padrão, você tem duas
opções:

1. **Ajustar o backup** para apontar para o banco correto (`DB_FILE`/`DATA_DIR`)
   e garantir `GPG_RECIPIENT` no ambiente do deploy; ou
2. **Desativar o backup automático** no workflow, trocando `RUN_BACKUP=1` por
   `RUN_BACKUP=0` e mantendo o backup por rotina externa.

> A opção 2 reduz a segurança do deploy. Prefira corrigir o backup.

Para levar `GPG_RECIPIENT` ao servidor via GitHub, crie o secret
`GPG_RECIPIENT` e acrescente ao comando remoto:

```yaml
            "APP_DIR='...' RUN_BACKUP=1 TARGET_REF='${TARGET_REF}' \
             GPG_RECIPIENT='${{ secrets.GPG_RECIPIENT }}' bash -s"
```

Depois de qualquer alteração no workflow, faça merge na `main` para o job usar
a nova versão.

---

## 5. Primeiro deploy de teste

O job só roda em push na `main`. Escolha uma das opções.

### Opção A — merge de uma branch (recomendado)

1. Abra um Pull Request de `fix/proximas-correcoes` para `main`.
2. Aguarde o CI ficar verde.
3. Faça o merge.
4. Acompanhe em **Actions → CI → execução do merge → Deploy (produção)**.

### Opção B — commit vazio na `main` (teste rápido)

```bash
git switch main
git pull --ff-only origin main
git commit --allow-empty -m "ci: valida deploy automatico"
git push origin main
```

> Isso dispara o pipeline completo e o deploy. Use apenas quando o servidor já
> estiver com os pré-requisitos concluídos.

### Opção C — executar o script manualmente no servidor

Serve para validar o script, mas **não** testa a configuração do GitHub:

```bash
cd /opt/controle-share-videos-v1.0
TARGET_REF="$(git rev-parse origin/main)" \
APP_DIR=/opt/controle-share-videos-v1.0 \
COMPOSE_FILE=docker-compose.yml \
RUN_BACKUP=1 \
./scripts/deploy/deploy-prod.sh
```

---

## 6. Verificar o deploy

No GitHub, confirme que o job **`Deploy (produção)`** ficou verde. Se ele
aparecer como *skipped*, veja a §8.

No servidor:

```bash
cd /opt/controle-share-videos-v1.0
git log -1 --oneline
docker compose ps
docker exec controle-share-videos-backend \
  curl -fs http://127.0.0.1:8080/api/health
```

Resultados esperados:

- o commit exibido é o SHA que disparou o deploy;
- containers `backend`, `frontend` e `caddy` em `running`/`healthy`;
- `/api/health` responde `OK`.

Logs em caso de problema:

```bash
docker compose logs --tail=200 backend
```

---

## 7. Rollback

O script faz rollback automático quando `build`, `up` ou o healthcheck falham.
Códigos de saída:

| Código | Significado |
|---|---|
| `0` | deploy concluído com sucesso |
| `1` | falha antes do checkout/build (nada foi alterado) |
| `2` | deploy falhou e o rollback foi executado |

Rollback manual:

```bash
cd /opt/controle-share-videos-v1.0
git fetch --prune origin
git checkout --detach <commit-anterior>
docker compose up -d --build
```

> Após um deploy automático, o repositório fica em **detached HEAD** no SHA
> deployado. Para voltar à `main`, use
> `git checkout main && git pull --ff-only origin main`.

Se a migração do Prisma for incompatível, restaure o backup conforme
`docs/operacional/BACKUP_RESTORE.md`.

---

## 8. Troubleshooting

| Sintoma | Causa provável | Correção |
|---|---|---|
| Job `Deploy (produção)` não aparece | `DEPLOY_ENABLED` ausente ou diferente de `true` | Criar a variable com valor exato `true` |
| Job aparece como *skipped* | Push não foi na `main`, ou a variável não está `true` | Verificar branch e variable |
| `Permission denied (publickey)` | Chave privada errada, usuário errado, chave pública não instalada ou porta incorreta | Refazer §2.5 e conferir `DEPLOY_HOST`/`DEPLOY_USER`/`DEPLOY_PORT` |
| `ssh: connect ... timed out` | Firewall, porta fechada ou DNS incorreto | Liberar a porta SSH e testar com `ssh -p PORTA` |
| `permission denied ... docker.sock` | Usuário fora do grupo `docker` ou sessão antiga | `usermod -aG docker deploy` e abrir nova sessão |
| `detected dubious ownership` | Dono do diretório diferente do usuário do deploy | Ajustar `chown` ou `safe.directory` (§2.2) |
| `backup pré-deploy falhou` | `sqlite3`/`gpg` ausente, `GPG_RECIPIENT` vazio ou `DB_FILE` errado | Corrigir §2.4 antes de reativar |
| `no such file or directory: docker-compose.prod.yml` | Compose errado para o servidor | Ajustar `COMPOSE_FILE` (§4.1) |
| `dependency failed to start` / `unhealthy` | Aplicação não subiu | Ver `docker compose logs`; o script executa rollback (exit `2`) |
| Deploy não inicia mesmo com CI verde | Algum job da cadeia (`backend`, `frontend`, `e2e`, `docker-build`) falhou | Corrigir o job vermelho primeiro |

---

## 9. Checklist final

- [ ] Usuário `deploy` criado e no grupo `docker`
- [ ] Repositório clonado em `/opt/controle-share-videos-v1.0`
- [ ] Compose do servidor identificado (§2.3)
- [ ] Backup pré-deploy testado com sucesso (§2.4)
- [ ] Chave SSH de deploy criada e testada sem senha (§2.5)
- [ ] Variable `DEPLOY_ENABLED=true` criada
- [ ] Secrets `DEPLOY_HOST`, `DEPLOY_USER`, `DEPLOY_PORT`, `DEPLOY_SSH_KEY` criados
- [ ] `DEPLOY_PROD` antigo removido
- [ ] Workflow ajustado ao compose/caminho do servidor, se necessário (§4)
- [ ] Primeiro deploy de teste concluído (§5)
- [ ] Healthcheck validado no servidor (§6)

---

## 10. Referências

- `.github/workflows/ci.yml` — definição do job `Deploy (produção)`
- `scripts/deploy/deploy-prod.sh` — script executado no servidor
- `scripts/backup.sh` — backup pré-deploy
- `docs/operacional/DEPLOY.md` — implantação e upgrade manual
- `docs/operacional/BACKUP_RESTORE.md` — backup e restore
- `docs/operacional/HOST-PROVISIONING-ONPREMISE.md` — provisionamento do host
