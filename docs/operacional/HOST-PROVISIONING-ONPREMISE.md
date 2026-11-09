# Provisionamento do Host On-Premise — Guia Executável

**Cenário:** servidor físico da organização (GML), domínio próprio a definir, SMTP interno disponível.
**Pré-requisito:** Debian 13 "trixie" (64-bit) instalado, acesso SSH. Ubuntu Server 22.04/24.04 LTS também funciona com os mesmos passos.
**Complemento obrigatório:** `docs/ESPECIFICACAO_SEGURANCA_DOCKER_HOST_v1.0.md` (requisitos formais).

---

## 1. Base do sistema

```bash
sudo apt update && sudo apt upgrade -y
sudo apt install -y ca-certificates curl gnupg ufw fail2ban git rsync sudo cryptsetup
# Usuário dedicado ao deploy (sem root direto)
sudo adduser deploy && sudo usermod -aG sudo deploy
```

> **Notas específicas do Debian 13 (trixie):**
>
> - Se o instalador definiu senha de root, o `sudo` pode não vir instalado —
>   por isso ele entra na linha de `apt install` acima.
> - `/tmp` agora é **tmpfs** (limite ~50% da RAM, limpo após ~10 dias): não use
>   `/tmp` para dumps ou arquivos grandes; use os diretórios em `/opt`.
> - `/etc/sysctl.conf` **não é mais lido** pelo systemd-sysctl — parâmetros de
>   kernel locais devem ficar em `/etc/sysctl.d/*.conf`.
> - OpenSSH 10: chaves **DSA não são mais aceitas** — use ed25519 (o passo 5 já usa).

## 2. Docker + Swarm (o compose de produção usa secrets de Swarm)

```bash
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker deploy
# Swarm single-node: habilita `docker secret create`
sudo docker swarm init --advertise-addr <IP-INTERNO-DO-HOST>
```

> O `get.docker.com` registra o repositório oficial
> (`download.docker.com/linux/debian`, suite `trixie` — suportada oficialmente
> pelo Docker Engine) e as atualizações passam a vir via `apt`. Para instalação
> manual do repositório, use o passo 3 do `README.md`.

## 3. Firewall e SSH

```bash
sudo ufw default deny incoming && sudo ufw default allow outgoing
sudo ufw allow 22/tcp comment 'SSH'
sudo ufw allow 80/tcp comment 'HTTP -> redirect TLS'
sudo ufw allow 443/tcp comment 'HTTPS'
sudo ufw enable
# SSH: desabilitar senha, manter chave (drop-in tem precedência no Debian 13)
sudo tee /etc/ssh/sshd_config.d/00-hardening.conf >/dev/null <<'EOF'
PasswordAuthentication no
KbdInteractiveAuthentication no
EOF
sudo sshd -t && sudo systemctl restart ssh
```

> **Docker × firewall no Debian 13:** o Docker avisa que regras criadas com
> `nft` puro não são suportadas em host com Docker — `ufw` é frontend de
> iptables e continua compatível. Portas **publicadas** pelo Docker não passam
> pelas regras do ufw: exponha apenas 80/443 (Caddy) no compose e, para filtrar
> tráfego de containers, use a chain `DOCKER-USER`.

## 4. Criptografia de disco (LUKS) — Item #2 do checklist

O checklist de segurança exige vídeos e banco **cifrados em repouso**. O compose
não cifra o volume Docker: a cifra é feita na camada de bloco do host.

> **Mudança de topologia:** os dados agora ficam no **disco local do sistema**
> em `/opt/app/data` (bind mount do `docker-compose.prod.yml`), e não mais em
> um drive externo/RAID6. Se o disco raiz já é cifrado (LUKS/dm-crypt na
> instalação do Debian), o item #2 está atendido — registre a evidência e pule
> para a §5. Se o disco local **não** é cifrado, use a camada de bloco do
> sistema antes de criar os dados.
>
> **Procedimento opcional (volume dedicado):** LUKS2 sobre um dispositivo
> dedicado (`/dev/md0` neste exemplo) montado em `/opt/app`, com passphrase
> guardada fora do host (cofre/serviço de segredos). Se a empresa optar por
> volume gerenciado com criptografia nativa (cloud/EBS, storage com SED etc.),
> anexar a comprovação ao aceite de risco da Fase 5 e marcar o item como N/A —
> não deixar a decisão implícita.

### 4.1 Pré-requisitos (apenas para volume dedicado)

- dispositivo/RAID já montado (`/dev/md0`) e **sem file system em uso**;
- `cryptsetup` instalado (seção 1);
- console/IPMI ou segundo acesso SSH disponível — se o desbloqueio falhar, o
  boot para no `initramfs`.

```bash
lsblk -f                                  # confirme o dispositivo (ex.: /dev/md0)
sudo wipefs -a /dev/md0                   # ATENÇÃO: apaga assinaturas/partições
```

### 4.2 Criar o container LUKS e o file system

```bash
# LUKS2 + Argon2id (padrão do cryptsetup 2.x). Use passphrase forte e guarde-a
# fora do host: perdê-la significa perder todos os dados.
sudo cryptsetup luksFormat --type luks2 /dev/md0
sudo cryptsetup open /dev/md0 app_crypt
sudo mkfs.ext4 -L appdata /dev/mapper/app_crypt
```

### 4.3 Montagem e desbloqueio no boot

```bash
sudo mkdir -p /opt/app
echo 'appdata /opt/app ext4 defaults,nofail 0 2' | sudo tee -a /etc/fstab
# /etc/crypttab: <nome> <dispositivo> <keyfile|none> <opções>
echo 'app_crypt /dev/md0 none luks' | sudo tee -a /etc/crypttab
sudo update-initramfs -u                  # Debian/Ubuntu
```

No boot o sistema pede a passphrase no console. Para servidor sem teclado,
prefira **desbloqueio remoto (dropbear-initramfs)** ou chave em TPM2 e registre
a escolha no aceite de risco.

### 4.4 Validar (Fase 1 do go-live)

```bash
lsblk -f                                  # crypt + ext4 montado em /opt/app
sudo cryptsetup status app_crypt          # type: LUKS2, cipher: aes-xts-plain64
findmnt /opt/app                          # confirma a montagem cifrada
sudo cryptsetup luksDump /dev/md0 | grep -E 'Version|Cipher|PBKDF'
sudo touch /opt/app/.luks-test && sync
```

Registre a saída dos comandos como evidência na **Fase 1** do
`docs/GOLIVE-CHECKLIST.md`. O item #2 do `CHECKLIST-SEGURANCA-FINAL.md` só sai
de 🟡 depois dessa marcação.

## 5. Diretórios e secrets do Swarm

```bash
# Mesmo caminho bind-mountado por docker-compose.prod.yml (dados + imagens).
# Criar DEPOIS de montar o volume cifrado da seção 4 (se aplicável) — senão o
# Docker cria o diretório como root no disco raiz e o backup/criptografia ficam
# errados.
sudo mkdir -p /opt/app/data/images
sudo chown -R 1002:1002 /opt/app/data
sudo chmod 750 /opt/app/data

# Secrets exigidos por docker-compose.prod.yml (valores do .env.production.local)
printf '%s' "<ADMIN_EMAIL>"     | sudo docker secret create admin_email -
printf '%s' "admin"             | sudo docker secret create admin_username -
printf '%s' "<ADMIN_PASSWORD>"  | sudo docker secret create admin_password -
printf '%s' "<DOMAIN>"          | sudo docker secret create domain -
printf '%s' "<ACME_EMAIL>"      | sudo docker secret create acme_email -
```

> **Domínio ainda indefinido:** enquanto não houver DNS público, o Caddy pode
> emitir certificado *internal CA* (`tls internal`) para hostname local —
> adequado para rede da GML; trocar para Let's Encrypt quando o domínio for
> definido (basta preencher DOMAIN/ACME_EMAIL nos secrets).

## 6. Deploy key (CI → host)

```bash
ssh-keygen -t ed25519 -f ~/.ssh/deploy_key -N "" -C "ci-deploy@$(hostname)"
cat ~/.ssh/deploy_key.pub >> ~/.ssh/authorized_keys
cat ~/.ssh/deploy_key   # colar no GitHub Secret DEPLOY_SSH_KEY
```

No GitHub → Settings:

- **Secrets:** `DEPLOY_HOST`, `DEPLOY_USER=deploy`, `DEPLOY_PORT=22`, `DEPLOY_SSH_KEY`
- **Variables:** `DEPLOY_ENABLED=true`

## 7. Backup offsite (obrigatório antes do go-live)

Sem nuvem pública, escolher UMA opção:

| Opção | Como |
| --- | --- |
| **A. MinIO em segundo servidor/NAS** (compatível S3) | provisionar MinIO → usar `scripts/backup/backup-sqlite.sh` com `S3_BUCKET` apontando lá + criptografia GPG |
| **B. rsync p/ NAS** | cron com `rsync -az --delete` dos volumes + `age`/GPG para cifrar; testar restore mensalmente |

Regra inegociável: **backup em máquina diferente do host de produção**, com teste de restore documentado (Fase 5 do checklist).

## 8. Monitoramento

```bash
docker compose -f docker-compose.monitoring.yml up -d   # Prometheus + Alertmanager
```

Configurar webhook Slack/canal interno em `scripts/monitoring/alertmanager.template.yml`.

## 9. Validação final

1. `bash scripts/staging-validation.sh` contra o host
2. Repetir cenário de limites do pentest (#40) no host
3. Marcar Fases 0–4 do `docs/GOLIVE-CHECKLIST.md` com evidências
