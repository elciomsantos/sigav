# Ensaio pré-produção no servidor final (dress rehearsal)

> **Objetivo:** validar o stack de produção completo (`docker-compose.prod.yml`)
> no mesmo servidor que será usado em produção, **antes** do go-live. Depois do
> aceite, todo o ensaio é removido e a produção é criada limpa.
>
> **Quando usar:** você tem **um único servidor** e quer reduzir risco antes da
> implantação definitiva. O ensaio valida storage em `/opt/app/data`, secrets do
> Swarm, permissões, TLS, backup/restore e o pipeline de deploy.
>
> **O que este roteiro NÃO é:** staging permanente. É um ensaio descartável.

---

## 1. Premissas e avisos

- O servidor ainda **não** roda produção. Se já roda, **não** execute este
  roteiro nele.
- Os **secrets do Swarm são globais e imutáveis**: os valores do ensaio serão
  removidos no final (Fase 7) e recriados com os valores reais (Fase 8).
- O bind mount `/opt/app/data` **não** é removido por `docker compose down -v`;
  a remoção é manual (Fase 7).
- **Let's Encrypt tem limite de emissão** (5 certificados idênticos/semana).
  Por isso o ensaio usa `tls internal` (autoassinado). A emissão real fica
  para a Fase 8, uma única vez.
- Se for usar uma cópia do banco de produção, **anonimize os dados** antes
  (LGPD). No ensaio inicial, use dados sintéticos.
- Todos os comandos abaixo assumem Debian/Ubuntu com `sudo` e o repo em
  `/opt/controle-share-videos-v1.0`.

---

## 2. Visão geral das fases

| Fase | O que faz | Destrutivo? |
|---|---|---|
| 0 | Inventário e decisões (acesso, portas, disco) | Não |
| 1 | Pré-requisitos do host | Não |
| 2 | Código + diretórios de dados | Não |
| 3 | Secrets de ensaio | Não |
| 4 | Subir o stack de ensaio | Não |
| 5 | Validação (storage, funcional, backup, segurança) | Não |
| 6 | Evidências e aceite | Não |
| 7 | Desmontar e limpar tudo | **Sim** |
| 8 | Deploy final limpo | **Sim** |

---

## 3. Fase 0 — Inventário e decisões

### 3.1 Definir o acesso do ensaio

| Modo | Quando | TLS |
|---|---|---|
| **IP/LAN (padrão deste roteiro)** | Sem domínio ainda, acesso interno | `tls internal` (autoassinado) |
| Domínio temporário | Você já tem subdomínio que pode apontar | Let's Encrypt staging (Anexo A) |

Este roteiro usa **IP/LAN** e o overlay `docker-compose.preprod.yml`
(que monta o `Caddyfile.lan` e usa `LAN_HOST`).

### 3.2 Confirmar recursos

```bash
# Portas 80/443 livres (o Caddy do ensaio vai usá-las)
ss -ltnp 'sport = :80 or sport = :443'   # deve vir vazio

# Disco/partição onde /opt/app vai ficar
df -h /opt
lsblk -f

# Criptografia em repouso (item #2 do checklist de segurança)
findmnt -no SOURCE,FSTYPE /
```

Anote o **IP fixo** do servidor (`LAN_HOST`) e o **hash/tag** do release
candidate que será validado.

---

## 4. Fase 1 — Pré-requisitos do host

```bash
# Docker + Compose + git
docker --version
docker compose version
git --version

# Dependências apenas para TESTAR backup/restore no host
sudo apt-get update
sudo apt-get install -y sqlite3 gnupg curl
```

Opcional (recomendado): fuso horário e sincronismo de hora.

```bash
sudo timedatectl set-timezone America/Sao_Paulo
timedatectl status
```

---

## 5. Fase 2 — Código e diretórios

```bash
cd /opt
sudo git clone <URL-DO-REPO> controle-share-videos-v1.0
sudo chown -R "$USER":"$USER" /opt/controle-share-videos-v1.0
cd /opt/controle-share-videos-v1.0

# Fixe o release candidate que será validado
git fetch --tags
git checkout v1.0.0-rc1

# Diretórios de dados no MESMO caminho da produção
sudo mkdir -p /opt/app/data/images /opt/app/backups
sudo chown -R 1002:1002 /opt/app/data
sudo chmod 750 /opt/app/data

# Conferência: dono 1002:1002
ls -ldn /opt/app/data /opt/app/data/images
```

Validação estática antes de subir:

```bash
docker compose -f docker-compose.prod.yml config >/dev/null && echo "compose base OK"
LAN_HOST=192.168.0.10 \
  docker compose -f docker-compose.prod.yml -f docker-compose.preprod.yml config >/dev/null \
  && echo "overlay preprod OK"
CI=true bash scripts/ci/prod-readiness-check.sh
```

---

## 6. Fase 3 — Secrets de ensaio

> **Guarda:** se já existirem secrets neste Swarm, aborte — provavelmente é um
> servidor em produção.

```bash
docker swarm init 2>/dev/null || true
docker info --format '{{.Swarm.LocalNodeState}}'   # esperado: active

# Abortar se já houver secrets
if docker secret ls --format '{{.Name}}' | grep -q '^domain$'; then
  echo "ERRO: já existem secrets neste Swarm. Abortando." >&2
  exit 1
fi

# Valores de ENSAIO (serão removidos na Fase 7)
export PREPROD_ADMIN_PASSWORD="$(openssl rand -base64 32)"
export PREPROD_JWT_SECRET="$(openssl rand -base64 48 | tr -d '\n')"

printf '%s' 'preprod@empresa.local' | sudo docker secret create admin_email -
printf '%s' 'admin'                  | sudo docker secret create admin_username -
printf '%s' "$PREPROD_ADMIN_PASSWORD" | sudo docker secret create admin_password -
printf '%s' 'preprod-smtp'           | sudo docker secret create smtp_password -
printf '%s' 'preprod@empresa.local'  | sudo docker secret create acme_email -
printf '%s' 'preprod.local'          | sudo docker secret create domain -
printf '%s' "$PREPROD_JWT_SECRET"    | sudo docker secret create jwt_secret -

docker secret ls
```

> Guarde a senha do admin de ensaio (`echo "$PREPROD_ADMIN_PASSWORD"`) para
> fazer login. No primeiro acesso o sistema exige troca de senha.

---

## 7. Fase 4 — Subir o stack de ensaio

```bash
cd /opt/controle-share-videos-v1.0
export LAN_HOST=192.168.0.10   # troque pelo IP fixo do servidor

docker compose -f docker-compose.prod.yml -f docker-compose.preprod.yml \
  up -d --build
```

Acompanhar (o backend tem `start_period` de 120s):

```bash
docker compose -f docker-compose.prod.yml -f docker-compose.preprod.yml ps

for c in preprod-controle-share-videos-backend \
         preprod-controle-share-videos-frontend \
         preprod-controle-share-videos-caddy; do
  printf '%-45s ' "$c"
  docker inspect --format '{{.State.Health.Status}}' "$c"
done
```

Após o boot, ajuste em **Admin → Configurações → Geral**:

- `general.appUrl = https://<LAN_HOST>` (ex.: `https://192.168.0.10`)
- `general.secureCookies` permanece **`true`** — há TLS (mesmo autoassinado).

---

## 8. Fase 5 — Validação

### 8.1 Containers e health

```bash
export LAN_HOST=192.168.0.10

# Health via Caddy (use -k por ser certificado autoassinado)
curl -kfsS "https://${LAN_HOST}/api/health"; echo

# Health interno do backend
docker exec preprod-controle-share-videos-backend \
  curl -fsS http://127.0.0.1:8080/api/health; echo

# Caddy valida o Caddyfile
docker exec preprod-controle-share-videos-caddy \
  caddy validate --config /etc/caddy/Caddyfile
```

### 8.2 Storage e banco

```bash
# Variáveis efetivas
docker exec preprod-controle-share-videos-backend \
  sh -lc 'echo "DATABASE_URL=$DATABASE_URL"; echo "DATA_DIRECTORY=$DATA_DIRECTORY"'

# Arquivos no host (mesmo caminho do container)
ls -la /opt/app/data

# Integridade + contagens (better-sqlite3 já vem na imagem)
docker exec -w /opt/app/backend preprod-controle-share-videos-backend \
  node -e "const D=require('better-sqlite3');const db=new D(process.env.DATABASE_URL.replace('file:',''),{readonly:true});console.log('integrity:',db.pragma('integrity_check'));console.log('users:',db.prepare('select count(*) c from User').get().c);console.log('configs:',db.prepare('select count(*) c from Config').get().c);"
```

Esperado: `integrity: [ { integrity_check: 'ok' } ]`, `users >= 1`,
`configs >= 1`.

### 8.3 Funcional (pela interface)

1. Acesse `https://<LAN_HOST>` (aceite o aviso de certificado).
2. Faça login com `admin` / senha do ensaio; troque a senha.
3. Crie um usuário comum, um grupo e um share.
4. Faça upload de um vídeo pequeno e de um grande (> 100 MB).
5. Abra o link público em uma aba anônima e baixe/assista.
6. Confirme a gravação no host:

```bash
find /opt/app/data/uploads -type f -mmin -30 | head
ls -la /opt/app/data/uploads/shares
```

Esperado: arquivos com dono `1002:1002`.

### 8.4 Persistência

```bash
# Contagem antes
docker exec -w /opt/app/backend preprod-controle-share-videos-backend \
  node -e "const D=require('better-sqlite3');const db=new D(process.env.DATABASE_URL.replace('file:',''),{readonly:true});console.log(db.prepare('select count(*) c from User').get())"

# Restart dos containers (o entrypoint roda migrate/seed de novo — deve ser idempotente)
docker compose -f docker-compose.prod.yml -f docker-compose.preprod.yml restart backend

# Aguarde healthy e repita a contagem; depois teste o ciclo completo
docker compose -f docker-compose.prod.yml -f docker-compose.preprod.yml down
docker compose -f docker-compose.prod.yml -f docker-compose.preprod.yml up -d
```

Esperado: mesmos usuários/shares e arquivos intactos.

### 8.5 Backup e restore

```bash
# Chave GPG de teste (válida por 1 dia)
gpg --batch --passphrase '' --quick-generate-key \
  "Preprod Test <preprod-test@local>" rsa3072 default 1d

NODE_ENV=production \
GPG_RECIPIENT=preprod-test@local \
BACKUP_DIR=/opt/app/backups \
./scripts/backup.sh

ls -lh /opt/app/backups | tail

GPG_RECIPIENT=preprod-test@local \
BACKUP_DIR=/opt/app/backups \
./scripts/restore-test.sh
```

Esperado: arquivo `controle-videos_*.db.gz.gpg` e `restore-test.sh` com
`integrity_check: ok` e schema completo.

### 8.6 Segurança e prontidão

```bash
export LAN_HOST=192.168.0.10

# Gate de prontidão
CI=true bash scripts/ci/prod-readiness-check.sh

# Configs de debug/produção
sudo LOG_FILE=/var/log/debug-prod-verify.log bash scripts/security/debug-prod-verify.sh

# Swagger desabilitado (esperado 404)
curl -ks -o /dev/null -w 'swagger=%{http_code}\n' "https://${LAN_HOST}/api/swagger"

# Headers de segurança
curl -ksI "https://${LAN_HOST}" | grep -iE 'strict-transport-security|content-security-policy|x-frame-options'

# Nenhum segredo em variáveis de ambiente do container
docker inspect preprod-controle-share-videos-backend \
  --format '{{json .Config.Env}}' | grep -iE 'password|secret' || echo "nenhum segredo em env OK"

# Secrets montados como arquivos
docker exec preprod-controle-share-videos-backend sh -c 'ls -l /run/secrets'
```

### 8.7 Migração com cópia de dados (opcional)

Se existir um sistema antigo, valide o caminho de upgrade:

1. Gere um backup **anonimizado** do banco atual.
2. Pare o backend, substitua `/opt/app/data/controle-videos.db` pela cópia.
3. Suba novamente: o entrypoint executa `prisma migrate deploy`.
4. Rode o `integrity_check` e valide contagens/anexos.

> Nunca use dados reais sem anonimização (LGPD).

### 8.8 Checklist de aceite

| # | Critério | OK |
|---|---|---|
| 1 | `docker compose config` sem erro (base + overlay) | ☐ |
| 2 | `prod-readiness-check.sh` com 0 FAIL | ☐ |
| 3 | 3 containers `healthy`, nenhum `Restarting` | ☐ |
| 4 | `/api/health` → 200 | ☐ |
| 5 | DB em `/opt/app/data`, `integrity_check = ok` | ☐ |
| 6 | Upload grava em `/opt/app/data/uploads` como `1002:1002` | ☐ |
| 7 | Dados sobrevivem a `restart` e `down`/`up` | ☐ |
| 8 | Backup criado e `restore-test.sh` OK | ☐ |
| 9 | Swagger 404, headers HSTS/CSP presentes | ☐ |
| 10 | Nenhum segredo em `docker inspect` | ☐ |
| 11 | Aviso de certificado ausente após importar a CA (opcional) | ☐ |
| 12 | Usuários de teste validaram login/upload/share | ☐ |

Para eliminar o aviso de certificado nos clientes, exporte e instale a CA local:

```bash
docker compose -f docker-compose.prod.yml -f docker-compose.preprod.yml \
  cp caddy:/data/caddy/pki/authorities/local/root.crt ./caddy-root.crt
```

---

## 9. Fase 6 — Evidências e aceite

Registre as evidências em um diretório de ensaio:

```bash
mkdir -p /opt/controle-share-videos-v1.0/.preprod-evidence

{
  echo "== git =="; git rev-parse HEAD; git describe --tags --always
  echo "== compose ps =="; docker compose -f docker-compose.prod.yml -f docker-compose.preprod.yml ps
  echo "== health =="; curl -kfsS "https://${LAN_HOST}/api/health"
  echo "== readiness =="; CI=true bash scripts/ci/prod-readiness-check.sh
  echo "== data =="; ls -la /opt/app/data
} > .preprod-evidence/aceite-$(date +%Y%m%d_%H%M%S).txt 2>&1

tar czf /opt/app/backups/evidencias-preprod-$(date +%Y%m%d).tar.gz \
  .preprod-evidence caddy-root.crt 2>/dev/null || true
```

Aceite = checklist 8.8 completo + evidências arquivadas + aprovação formal.

---

## 10. Fase 7 — Desmontar o ensaio (limpeza total)

> **Destrutivo.** Confirme que as evidências e backups de teste foram copiados
> para fora antes de continuar.

```bash
cd /opt/controle-share-videos-v1.0
export LAN_HOST=192.168.0.10

# 1. Parar e remover containers + volumes nomeados do ensaio
docker compose -f docker-compose.prod.yml -f docker-compose.preprod.yml \
  down -v --remove-orphans

# 2. Remover os secrets de ensaio
docker secret rm admin_email admin_username admin_password smtp_password \
  acme_email domain jwt_secret

# 3. Remover dados e backups de ensaio (bind mounts NÃO saem no down -v)
sudo rm -rf /opt/app/data /opt/app/backups
sudo rm -rf /opt/controle-share-videos-v1.0/.preprod-evidence

# 4. (Opcional) remover imagens do ensaio para forçar build limpo
docker image ls | grep controle-share-videos-preprod
# docker image rm <ids listados acima>

# 5. (Opcional) remover a chave GPG de teste
gpg --batch --yes --delete-secret-keys preprod-test@local 2>/dev/null || true
gpg --batch --yes --delete-keys preprod-test@local 2>/dev/null || true

# 6. (Opcional) limpar build cache antigo
docker builder prune -f
```

### Verificação final de limpeza

```bash
docker ps -a --format '{{.Names}}' | grep preprod || echo "sem containers preprod OK"
docker volume ls --format '{{.Name}}' | grep preprod || echo "sem volumes preprod OK"
docker network ls --format '{{.Name}}' | grep preprod || echo "sem redes preprod OK"
docker secret ls
[ ! -e /opt/app/data ] && echo "/opt/app/data removido OK"
ss -ltnp 'sport = :80 or sport = :443'   # deve voltar a ficar vazio
```

> Se quiser desmontar o Swarm (só se este host não for mais usar secrets):
> `docker swarm leave --force`. **Não faça isso** se já houver outra stack
> usando Swarm neste host.

---

## 11. Fase 8 — Deploy final limpo

```bash
cd /opt/controle-share-videos-v1.0

# 1. Checkout do commit validado (mesma tag do ensaio)
git fetch --tags
git checkout v1.0.0        # ou o commit final aprovado

# 2. Diretórios de produção
sudo mkdir -p /opt/app/data/images /opt/app/backups
sudo chown -R 1002:1002 /opt/app/data
sudo chmod 750 /opt/app/data
ls -ldn /opt/app/data

# 3. Secrets REAIS (valores definitivos)
docker swarm init 2>/dev/null || true

printf '%s' 'app.suaempresa.com'   | sudo docker secret create domain -
printf '%s' 'sre@suaempresa.com'   | sudo docker secret create acme_email -
printf '%s' 'admin@empresa.local'  | sudo docker secret create admin_email -
printf '%s' 'admin'                | sudo docker secret create admin_username -
printf '%s' "$ADMIN_PASSWORD"      | sudo docker secret create admin_password -
printf '%s' "$SMTP_PASSWORD"       | sudo docker secret create smtp_password -
openssl rand -base64 48 | tr -d '\n' | sudo docker secret create jwt_secret -

# 4. Subir PRODUÇÃO pura (sem overlay de ensaio; Caddyfile.prod + Let's Encrypt)
docker compose -f docker-compose.prod.yml up -d --build
docker compose -f docker-compose.prod.yml ps
docker compose -f docker-compose.prod.yml logs -f caddy   # emissão do certificado

# 5. Validação final
curl -fsS https://app.suaempresa.com/api/health
./scripts/security/check-tls-cert.sh app.suaempresa.com
CI=true bash scripts/ci/prod-readiness-check.sh
```

> **Produção final também por IP (sem domínio):** não use o overlay de ensaio.
> Defina um modo definitivo (`CADDYFILE=ip`, ou um `Caddyfile` próprio com
> `tls internal`) e ajuste `general.appUrl`/`secureCookies` conforme o
> `docs/operacional/DEPLOY.md` §6.2.

Ao final, faça o **primeiro backup real** com a chave GPG definitiva:

```bash
NODE_ENV=production GPG_RECIPIENT='<chave-real>' BACKUP_DIR=/opt/app/backups ./scripts/backup.sh
GPG_RECIPIENT='<chave-real>' BACKUP_DIR=/opt/app/backups ./scripts/restore-test.sh
```

---

## Anexo A — Variante com domínio temporário (Let's Encrypt staging)

Se você já tem um subdomínio que pode apontar para o servidor, é possível
testar o caminho real do Caddy sem consumir a cota do Let's Encrypt de
produção. Crie um Caddyfile de ensaio com a CA de staging:

```bash
cp reverse-proxy/Caddyfile.prod reverse-proxy/Caddyfile.preprod
# No Caddyfile.preprod, troque o bloco TLS por:
#   tls {$ACME_EMAIL} {
#       ca https://acme-staging-v02.api.letsencrypt.org/directory
#   }
```

Monte-o via um override mínimo:

```yaml
services:
  caddy:
    volumes:
      - ./reverse-proxy/Caddyfile.preprod:/etc/caddy/Caddyfile:ro
```

E crie os secrets `domain`/`acme_email` com os valores temporários. Ao final do
ensaio, volte para o `Caddyfile.prod` e recrie os secrets com os valores reais.

---

## Anexo B — Troubleshooting

| Sintoma | Causa provável | Ação |
|---|---|---|
| `EACCES`/`EROFS` em `/opt/app/data` | dono/permissão errados | `chown -R 1002:1002 /opt/app/data`; `chmod 750` |
| Caddy não emite certificado | porta 80/443 fechada ou DNS errado | `ss -ltnp`, `dig <dominio>`, logs do caddy |
| `secret ... not found` no `up` | secret ausente | `docker secret ls` e recriar |
| Login falha com `csrf_invalid` | `secureCookies=true` sobre HTTP | use TLS interno (C2) ou `secureCookies=false` (só em HTTP) |
| Certificado autoassinado rejeitado | CA local não instalada | importar `caddy-root.crt` |
| Backup aborta | `GPG_RECIPIENT` ausente (fail-closed) | definir `GPG_RECIPIENT` |

---

## Anexo C — Rollback

- **Ensaio:** basta `down -v` e repetir a Fase 4.
- **Produção:** use `scripts/deploy/deploy-prod.sh` com `TARGET_REF` apontando
  para a tag anterior; o script já faz backup e rollback automático em falha
  de healthcheck. Detalhes em `docs/rollback-runbook.md`.
