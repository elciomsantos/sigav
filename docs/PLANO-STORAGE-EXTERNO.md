# Plano de implementação — compartilhamento por referência externa

**Status:** proposta para revisão
**Objetivo:** permitir criar um link de compartilhamento para um vídeo que já existe em um disco externo (SMB/Windows), **sem copiar o arquivo** para o storage interno do app.
**Cenário de referência:** Windows Server 2012 como host Hyper-V, disco de 40 TB (RAID1) com o acervo, VM Debian 13 rodando Docker. Segundo disco previsto.

---

## 1. Escopo

### Dentro do escopo

- Modo `EXTERNAL` por arquivo: o backend lê o vídeo de uma biblioteca montada e faz streaming.
- Suporte a **N bibliotecas** (um mount por disco), com subpastas.
- Registro de arquivo existente por caminho relativo (sem upload, sem cópia).
- Navegação/lista de bibliotecas para a UI.
- Expiração/exclusão removendo apenas a referência.
- Auditoria, limites, healthcheck e mensagens de erro claras.

### Fora do escopo (nesta entrega)

- Upload de arquivos externos para dentro do app.
- Transcoder/player próprio.
- Gerenciamento de bibliotecas pela UI (fase opcional futura).
- Migração do Windows Server 2012.
- Cache local automático de vídeos “quentes”.

---

## 2. Premissas

- O vídeo é lido pelo backend e reenviado ao cliente; não há acesso direto do navegador ao disco.
- O disco de origem é **somente leitura** para o app (ACL no Windows + mount `ro` + bind `:ro`).
- O banco SQLite e os certificados permanecem no disco local da VM.
- O acervo pode mudar fora do app; a referência pode quebrar se o arquivo for movido/renomeado.

---

## 3. Decisões de arquitetura

| # | Decisão | Justificativa |
|---|---|---|
| D1 | SMB 3.0 read-only do Windows 2012 → mount CIFS no Debian → bind `:ro` no container | Evita passthrough de disco e mantém o acervo intacto |
| D2 | Modelo de **bibliotecas** com `libraryId` + `sourcePath` relativo | Suporta 2+ discos e subpastas sem ambiguidade |
| D3 | Roots definidos em arquivo de configuração de infraestrutura, não no banco | Caminho de mount é configuração de host; evita expor “caminho livre” pela UI |
| D4 | `File.storageProvider` decide o comportamento **por arquivo** | Um share pode misturar arquivos locais e externos |
| D5 | Exclusão/expiração **nunca** toca no arquivo de origem | Expirar = despublicar, não destruir o acervo |
| D6 | ZIP persistente desabilitado para arquivos externos | Evita copiar 40 TB para o disco da VM |
| D7 | Assinatura de vídeo (ffmpeg) desabilitada para externos | Geraria uma cópia no storage interno |

---

## 4. Modelo de dados

### 4.1 Prisma (`backend/prisma/schema.prisma`)

Adicionar em `model File`:

```prisma
model File {
  // ... campos existentes ...

  // LOCAL = upload interno; EXTERNAL = referência a biblioteca montada
  storageProvider   String    @default("LOCAL")
  externalLibraryId String?   // id da biblioteca (ex.: "videos-a")
  sourcePath        String?   // caminho relativo à raiz da biblioteca
  sourceMtime       DateTime? // detecta alteração/renomeação na origem

  // Evita registrar o mesmo arquivo duas vezes na mesma biblioteca.
  // No SQLite, NULLs são distintos, então linhas LOCAL não colidem.
  @@unique([externalLibraryId, sourcePath])
  @@index([externalLibraryId])
}
```

> `Share.storageProvider` já existe e continua sendo gravado como `"LOCAL"` por compatibilidade. A lógica nova deve usar `File.storageProvider`.

### 4.2 Migration

- Criar `backend/prisma/migrations/<timestamp>_add_external_storage/migration.sql` com `ALTER TABLE "File" ADD COLUMN ...` (SQLite).
- Backfill: `storageProvider = 'LOCAL'` para linhas existentes.
- Rodar `npm run prisma:generate` e `prisma migrate deploy` no entrypoint (já previsto no Dockerfile/compose).
- Migration é **aditiva** → rollback não perde dados.

### 4.3 Configuração das bibliotecas

Novo arquivo `libraries.yaml` (caminho via env `STORAGE_LIBRARIES_FILE`, default `../libraries.yaml`):

```yaml
libraries:
  - id: videos-a
    name: "Acervo principal (40 TB)"
    mountPath: /media/videos-a
    enabled: true
  - id: videos-b
    name: "Acervo secundário"
    mountPath: /media/videos-b
    enabled: true
```

Regras:

- `id`: `^[a-z0-9-]{3,32}$`, único.
- `mountPath`: absoluto, existente e **mountpoint**; validado no boot.
- `enabled: false` mantém os registros, mas responde 503 para os arquivos daquela biblioteca.
- Se uma biblioteca referenciada no banco não existir no YAML, os arquivos dela ficam indisponíveis (503), sem quebrar o app.

Novo serviço `backend/src/storage/external-library.registry.ts`:

- Carrega e valida o YAML no `onModuleInit`.
- Expõe `get(id)`, `list()`, `assertEnabled(id)`.
- Falha o boot se houver `id` duplicado ou `mountPath` inválido (fail-fast), mas **não** derruba o app se um mount estiver offline (apenas marca indisponível).

---

## 5. Backend

### 5.1 Novo repositório externo

`backend/src/storage/external-library.repository.ts` + interface:

```ts
export interface IExternalLibraryRepository {
  stat(libraryId: string, relativePath: string): Promise<StoredFileStat>;
  readSample(libraryId: string, relativePath: string, maxBytes: number): Promise<Buffer>;
  createReadStream(
    libraryId: string,
    relativePath: string,
    opts?: { start?: number; end?: number },
  ): Readable;
  list(libraryId: string, relativePath: string): Promise<UploadRepositoryDirectoryEntry[]>;
  availableSpaceBytes(libraryId: string): Promise<number>;
  resolveAbsolute(libraryId: string, relativePath: string): string;
}
```

Implementação `FilesystemExternalLibraryRepository`:

- `resolveAbsolute`:
  1. rejeita caminho absoluto e `..`;
  2. `path.resolve(root, relativePath)`;
  3. `fs.realpath` e confirma que o resultado está dentro de `root` (bloqueia symlink/junction que escape);
  4. rejeita se o caminho resolvido não existir.
- `list` usa `readdir({ withFileTypes: true })`, ordena pastas primeiro, filtra entradas de sistema (`$RECYCLE.BIN`, `System Volume Information`, `.`/`..`).
- `availableSpaceBytes` usa `statfs(root)`.
- Timeout/erros de mount → `ServiceUnavailableException` com mensagem genérica (sem vazar caminho).

Registrar no `StorageModule` (`backend/src/storage/storage.module.ts`).

### 5.2 `LocalFileService` (`backend/src/file/local.service.ts`)

- `create()` continua sendo o fluxo de upload interno (LOCAL).
- Novo `createExternal(shareId, dto, actor)`:
  - carrega share, valida `uploadLocked`, permissão (no controller), biblioteca habilitada;
  - valida extensão na allowlist existente e magic bytes via `readSample`;
  - `stat` para `size`/`mtime`;
  - não chama `availableSpaceBytes()` nem aplica `share.maxSize` (opcional: cota separada por biblioteca);
  - cria `File` com `storageProvider: "EXTERNAL"`, `externalLibraryId`, `sourcePath`, `size`, `sourceMtime`;
  - **não** calcula SHA-256 por padrão (arquivo grande via SMB); hash sob demanda/na geração de certificado.
- `get()`:
  - busca `File`;
  - se `LOCAL`, comportamento atual;
  - se `EXTERNAL`, `externalRepo.createReadStream(...)` com Range;
  - antes de servir, revalida `stat` (tamanho/mtime). Se mudou, atualiza `size`/`sourceMtime`; se sumiu, 404 com mensagem “arquivo de origem indisponível”.
- `remove()`:
  - `LOCAL`: apaga o arquivo interno (atual);
  - `EXTERNAL`: **não** chama `unlinkIfExists`; apenas remove a linha.
- `deleteAllFiles(shareId)` continua removendo só o diretório interno (`{shareId}`); referências externas não são tocadas.
- `getZip()`: se o share tiver arquivo externo, retornar `409 Conflict` (“ZIP indisponível para bibliotecas externas”).
- `getFileZip()` / `getVideoWithCertificateZip()`: podem funcionar on-the-fly (stream externo + certificado interno), sem gravar cópia. Custo de CPU aceitável; documentar.
- `getCertificatesZip()`: inalterado (PDFs são internos).
- `resolveDiskPath()`: substituir por uma resolução discriminada (`{ kind: "local", path } | { kind: "external", libraryId, sourcePath }`) para não misturar conceitos.

### 5.3 API

Respeitando o prefixo global existente:

```http
GET  /api/v1/libraries
GET  /api/v1/libraries/:libraryId/browse?path=2024/formatura&page=1&perPage=100
POST /api/v1/shares/:shareId/files/external
```

Corpo do `POST`:

```json
{
  "libraryId": "videos-a",
  "path": "2024/formatura/video.mp4",
  "name": "Formatura 2024",
  "description": "opcional"
}
```

Regras:

- `@StrictShareOwnerAccess()` + reautenticação (mesmo padrão de operações críticas) + throttle.
- DTO com `class-validator`: `libraryId` (regex), `path` (sem `..`, sem começar com `/`, máx. 1024), `name` opcional (máx. 255).
- Respostas de erro: 400 (caminho inválido/extensão), 404 (não existe), 409 (duplicado), 503 (biblioteca indisponível).
- `GET /libraries` retorna `{ id, name, available, freeBytes }` **sem** `mountPath`.
- `GET /libraries/:id/browse` retorna `{ folders: [...], files: [...], page, total }`, com `available: false` se offline.
- **Nunca** expor `sourcePath`/`mountPath` em endpoints públicos de share.

Arquivos: `backend/src/file/dto/createExternalFile.dto.ts`, `backend/src/file/file.controller.ts`, `backend/src/storage/library.controller.ts`.

### 5.4 Auditoria (`backend/src/audit/audit-events.ts`)

- Novo evento `SHARE_EXTERNAL_ADDED` com `metadata: { libraryId, sourcePath, fileId }`.
- (Opcional, recomendado) novo evento `SHARE_EXPIRED` no job de expiração, registrando `shareId`, quantidade de arquivos e se havia externos.
- Download logs: incluir `libraryId` em `reason`/`metadata` ou em campo próprio se necessário. Não logar o caminho absoluto.

### 5.5 Jobs (`backend/src/jobs/jobs.service.ts`)

- `deleteExpiredShares` / `deleteUnfinishedShares`: continuam iguais; `File` é apagado por cascade. Confirmar que `deleteAllFiles` só remove o diretório interno.
- `deleteTemporaryFiles`: inalterado.
- Novo job/healthcheck (a cada 5 min): verifica `statfs`/`access` de cada biblioteca, atualiza métrica `external_library_available{library="..."}` e loga quando cair/voltar.
- Sempre que a remoção de um share com arquivos externos ocorrer, **não** tentar deletar a origem.

### 5.6 Certificados, ffmpeg e ZIP

- `backend/src/share/share.service.ts` (`generateCertificates`):
  - gerar PDF normalmente para arquivos externos (pequeno, fica interno);
  - **pular** `embedCertificateInVideo` para `storageProvider === "EXTERNAL"`;
  - hash SHA-256 opcional: config `storage.hashExternalFiles` (default `false`); se habilitado, avisar que lê o arquivo inteiro.
- `backend/src/share/share-archive.service.ts` (`createZip`):
  - se houver qualquer `File` EXTERNAL, lançar `BadRequestException` e deixar `isZipReady = false`;
  - `complete()` já captura o erro e apenas loga.
- `backend/src/certificate/certificate.service.ts`: aceitar apenas `srcRelPath` local para `embedCertificateInVideo`; nunca escrever no mount externo.

---

## 6. Frontend

### 6.1 Fluxo de criação

- Na página de upload (`frontend/src/pages/upload/index.tsx`), nova opção **“Compartilhar da biblioteca”** (visível para dono/admin):
  1. escolher biblioteca;
  2. navegar pelas subpastas (`/libraries/:id/browse`);
  3. selecionar um ou mais vídeos (ou “selecionar pasta inteira” — fase 2);
  4. criar o share normalmente (nome, expiração, senha, destinatários);
  5. registrar os arquivos via `POST .../files/external`.
- Não reutilizar o `Dropzone` para esse fluxo; criar `ExternalLibraryBrowser` em `frontend/src/components/upload/`.

### 6.2 Exibição

- `frontend/src/types/File.type.ts`: adicionar `storageProvider?` e `libraryName?` (sem `sourcePath` para o público).
- No `FileList`/detalhe do share: badge “Biblioteca: Acervo principal” e o caminho relativo apenas para o dono/admin.
- Botão “Baixar tudo (.zip)” desabilitado quando houver externos, com tooltip explicando.
- Estados de erro: 503 “Biblioteca indisponível” e 404 “Arquivo não encontrado na origem”.
- i18n em `frontend/src/i18n/` (pt-BR).

### 6.3 Serviços

- `frontend/src/services/library.service.ts` (`list`, `browse`).
- `frontend/src/services/share.service.ts` (`addExternalFile`).

---

## 7. Segurança

| Controle | Implementação |
|---|---|
| **Allowlist de raízes** | Somente `mountPath` do `libraries.yaml`; nada de caminho absoluto vindo do cliente |
| **Path traversal** | Rejeitar `..`, caminho absoluto, NUL; `realpath` + containment por biblioteca |
| **Symlink/junction** | `realpath` obrigatório; se escapar da raiz, 400 |
| **TOCTOU** | Origem somente leitura para o app; montagem `ro`; documentar que escrita na origem é responsabilidade do admin |
| **Menor privilégio** | Conta SMB read-only por share; container com bind `:ro` |
| **RBAC** | Apenas dono do share/admin; reautenticação para registrar externo |
| **Rate limit** | Throttle em `browse` e no `POST` de registro |
| **Vazamento de caminho** | Não retornar `mountPath`/`sourcePath` em endpoints públicos; mensagens de erro genéricas |
| **Conteúdo ativo** | Manter allowlist de extensões, magic bytes, `nosniff`, `Content-Disposition` e bloqueio de inline para SVG/HTML |
| **Auditoria** | Registrar quem registrou, qual biblioteca e qual caminho (hash opcional) |
| **Logs** | Não logar caminho absoluto; usar `libraryId` + caminho relativo |

---

## 8. Infraestrutura

### 8.1 Windows Server 2012

- Um share por disco: `\\host\VideosA`, `\\host\VideosB`.
- Conta de serviço read-only por share; ACL de compartilhamento e NTFS somente leitura.
- `Set-SmbServerConfiguration -EnableSMB1Protocol $false`.
- `Set-SmbShare -Name "VideosA" -EncryptData $true`.
- Firewall 445 apenas para o IP da VM.
- Excluir a pasta do antivírus.
- Se um dos discos for o de 1 TB do SO: **não** compartilhar `C:\`; criar pasta dedicada e compartilhar só ela.

### 8.2 Debian

```bash
sudo apt install -y cifs-utils
sudo mkdir -p /media/videos-a /media/videos-b
```

`/etc/fstab` (ou units systemd independentes):

```fstab
//IP/VideosA /media/videos-a cifs credentials=/etc/cifs-a.cred,vers=3.0,seal,ro,soft,nofail,_netdev,uid=1002,gid=1002,iocharset=utf8 0 0
//IP/VideosB /media/videos-b cifs credentials=/etc/cifs-b.cred,vers=3.0,seal,ro,soft,nofail,_netdev,uid=1002,gid=1002,iocharset=utf8 0 0
```

- `nofail` + `x-systemd.automount` para o boot não travar.
- `soft` para não deixar o container em D-state se o Windows cair.
- Testar `findmnt`, `ffprobe` e throughput (`dd`, `fio`).

### 8.3 Docker

```yaml
services:
  backend:
    volumes:
      - /srv/controle-share-videos/data:/opt/app/backend/data:rw,z
      - /media/videos-a:/media/videos-a:ro
      - /media/videos-b:/media/videos-b:ro
      - ./libraries.yaml:/opt/app/libraries.yaml:ro
    environment:
      - STORAGE_LIBRARIES_FILE=/opt/app/libraries.yaml
```

- Entrypoint valida `mountpoint -q` de cada biblioteca e falha com mensagem clara.
- `libraries.yaml` montado read-only.

---

## 9. Testes

### Unitários

- `external-library.repository.spec.ts`:
  - caminho válido, subpasta, acento/espaço;
  - `../`, absoluto, NUL, symlink para fora da raiz;
  - biblioteca inexistente/desabilitada → 503;
  - `stat`, `readSample`, `createReadStream` com Range.
- `local.service.spec.ts` (estender):
  - `createExternal` valida extensão/magic bytes e cria `File` correto;
  - `get` externo usa o repositório externo;
  - `remove` externo **não** chama `unlinkIfExists`;
  - `getZip` retorna 409 com externos;
  - `deleteAllFiles` não toca no mount.
- `share-archive.service.spec.ts`: rejeita ZIP com externos.
- `share.service.spec.ts`: `generateCertificates` pula embed para externos.

### E2E (`e2e/`)

- Fixture com um diretório temporário como “biblioteca” (não precisa de SMB).
- Fluxo: criar share → registrar externo → download com `Range` → conferir bytes.
- Expiração: rodar o job (ou `expire()`) → `File`/`Share` somem, arquivo de origem permanece.
- Biblioteca offline: renomear o diretório → `GET` retorna 503.
- Segurança: tentar registrar `../../etc/passwd`, caminho absoluto e symlink para fora → 400.

---

## 10. Fases e critérios de aceite

### Fase 0 — Infraestrutura (½–1 dia)

- [ ] Shares SMB read-only criados e testados.
- [ ] Mounts CIFS ativos e persistentes.
- [ ] Binds `:ro` no container.
- [ ] `libraries.yaml` provisionado.
- [ ] Teste de throughput e de queda do share.

**Aceite:** `ffprobe` funciona a partir do container e um arquivo de cada disco é legível.

### Fase 1 — Núcleo backend (3–4 dias)

- [ ] Migration `File` (provider/library/sourcePath/mtime).
- [ ] Registry de bibliotecas + validação no boot.
- [ ] Repositório externo com containment.
- [ ] `createExternal`, `get`, `remove` com comportamento EXTERNAL.
- [ ] Endpoints `libraries` e `files/external`.
- [ ] Bloqueio de ZIP/embed para externos.
- [ ] Auditoria.
- [ ] Testes unitários verdes.

**Aceite:** é possível criar um share, registrar um vídeo do mount e baixar com Range, sem nenhuma cópia no disco da VM.

### Fase 2 — Frontend (2–3 dias)

- [ ] Navegador de bibliotecas/subpastas.
- [ ] Fluxo “Compartilhar da biblioteca”.
- [ ] Badge de biblioteca e caminho (somente dono/admin).
- [ ] ZIP desabilitado com explicação.
- [ ] Tratamento de 404/409/503.
- [ ] i18n pt-BR.

**Aceite:** um usuário dono consegue compartilhar um vídeo de uma subpasta em menos de 1 minuto, sem upload.

### Fase 3 — Hardening e operação (2 dias)

- [ ] Healthcheck/métrica por biblioteca.
- [ ] Testes de segurança (traversal/symlink/offline).
- [ ] Documentação operacional (mount, ACL, troubleshooting).
- [ ] Runbook de “biblioteca offline”.
- [ ] Revisão de logs/LGPD.

**Aceite:** alerta dispara quando uma biblioteca cai; documentação permite recompor o mount sem ajuda.

---

## 11. Riscos e mitigação

| Risco | Mitigação |
|---|---|
| Windows Server 2012 fora de suporte | Isolar SMB em rede interna, read-only, conta dedicada, plano de upgrade |
| Link quebra se o arquivo for movido | Não mover arquivos referenciados; `sourceMtime` + mensagem clara; re-registro |
| Biblioteca offline | 503 por biblioteca, healthcheck e alerta; a outra biblioteca continua |
| Desempenho com muitos acessos | vNIC 10 GbE/vSwitch dedicado, jumbo frames, SMB Multichannel; medir antes |
| ZIP/certificado gerando cópia | Bloquear ZIP; pular embed; hash opcional |
| Vazamento de caminho do servidor | Não expor `mountPath`/`sourcePath` em API pública |
| Disco de 1 TB do SO encher | Não copiar; manter retenção 0 para uploads internos; monitorar VHDX |
| Duplicidade de registro | `@@unique([externalLibraryId, sourcePath])` + 409 |

---

## 12. Rollback

1. Desabilitar a feature (config `storage.externalEnabled=false`) ou remover as bibliotecas do YAML → endpoints externos passam a 503; shares locais intactos.
2. Reverter a migration é opcional; as colunas são nulas para arquivos locais e não afetam o fluxo atual.
3. Nenhum arquivo de origem é alterado em nenhuma fase → rollback não tem risco de perda de acervo.

---

## 13. Checklist final

- [ ] Nenhuma cópia de vídeo externo no disco da VM.
- [ ] Nenhuma escrita no mount externo (`ro` em todas as camadas).
- [ ] Caminhos validados por `realpath` + allowlist.
- [ ] `sourcePath` não aparece em resposta pública.
- [ ] Expiração apaga só a referência.
- [ ] ZIP e assinatura de vídeo bloqueados para externos.
- [ ] Logs de download e auditoria preservados após expiração.
- [ ] Healthcheck e alerta por biblioteca.
- [ ] Documentação operacional atualizada.
