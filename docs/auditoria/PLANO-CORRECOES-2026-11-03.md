# Plano de Correções — Reavaliação do Checklist de Segurança

**Data:** 2026-11-03
**Fonte:** auditoria de re-verificação do `CHECKLIST-SEGURANCA-FINAL.md` (2026-08-22) contra o código atual.
**Método:** verificação direta no código-fonte (3 trilhas paralelas: crypto/auth, uploads/secrets/CI, infra/monitoring).
**Resultado da reavaliação:** 8 ✅ · 5 🟡 PARCIAL · 2 🟡 mantidos · 0 🔴, com 6 riscos novos fora do escopo do checklist original.
**Pré-requisito (P0-00):** branch local `main` está **30 commits atrás de `origin/main`** — sincronizar antes de iniciar qualquer correção abaixo, para não corrigir código desatualizado.

> **Decisão 2026-11-03:** o item original P0-02 (limite por arquivo `share.maxFileSize` default `0`) foi **removido do plano** — o limite será configurado manualmente pela operação no painel de configurações (Item 8 do checklist segue ✅; o código continua validando `maxFileSize > 0` corretamente).

---

## Legenda

| Prazo | Significado |
|---|---|
| **P0** | Segurança real — corrigir **antes** do go-live |
| **P1** | Antes do deploy/hard freeze (qualidade, consistência, gate de CI) |
| **P2** | Risco aceito documentado ou melhoria pós-go-live |

Cada item tem: problema → evidência → ação → critério de aceite → esforço (S ≤ 1h · M ≤ 1 dia · L > 1 dia).

---

## P0 — Segurança (bloqueantes de go-live)

### P0-01 · Token de 2º fator (TOTP) persistido em texto claro — Item 1 · **✅ CONCLUÍDO 2026-11-03**
- **Problema:** `LoginToken.token String @id @default(uuid())` é gravado e consultado em plaintext. Viola a regra do checklist: *apenas SHA-256 persistido*.
- **Evidência:** `backend/prisma/schema.prisma:96-101` · `token.service.ts:176-190` (cria UUID sem hash) · `authTotp.service.ts:55-56` (lookup por plaintext).
- **Ação:**
  1. Adicionar coluna `tokenHash String @unique` em `LoginToken` (migration + `prisma migrate`);
  2. `token.service.ts`: reutilizar `hashShareableToken()` ao criar; retornar o valor plaintext só uma vez (mesma vida de 5 min, uso único);
  3. `authTotp.service.ts`: lookup por `tokenHash`;
  4. Migration deve invalidar tokens antigos (DROP da coluna plaintext) — efeito colateral aceitável: enroll TOTP em andamento precisa ser refeito.
- **Aceite:** nenhum campo de token plaintext no DB (`grep` no schema); testes unitários de enroll/verificação TOTP passando.
- **Esforço:** M

### P0-02 · Garantir `secureCookies: true` em produção — Item 3
- **Problema:** default de `config.example.yaml:12` é `false` (correto para LAN/dev). Em produção TLS os cookies precisam do modo `__Host-` (VULN-13).
- **Ação:** alinhar com o `config.example.yaml`/RUNBOOK prod: declarar explicitamente `secureCookies: true` no config de produção + checar no `prod-readiness-check.sh` (script já existente em `scripts/ci/`) — fail-fast se TLS habilitado e secureCookies false.
- **Aceite:** readiness check falha se combinação TLS-desligado-for-one estiver em prod.
- **Esforço:** S

### P0-03 · Rotacionar secrets do `.env.local` (operacional)
- **Problema:** `ADMIN_PASSWORD` e `JWT_SECRET` reais em arquivo local não versionado (perms 600, fora do git — verificado). Risco se a pasta for copiada/backupeada para fora.
- **Ação:** rotacionar as duas credenciais antes do go-live (elas eram de ambiente de dev); refutar cópias: HSTS já copiado para `.gitignore` (ok).
- **Aceite:** segredos antigos considerados queimados; prod usa segredos novos gerados na Fase 2 do go-live.
- **Esforço:** S (operacional)

### P0-04 · Fechar o item 🟡 #2 — documento LUKS não existe
- **Problema:** o plano de fechamento do checklist aponta para "HOST-PROVISIONING §1" para LUKS, mas o guia (116 linhas) **não menciona LUKS/cryptsetup**.
- **Evidência:** `docs/operacional/HOST-PROVISIONING-ONPREMISE.md` (grep = 0).
- **Ação:** adicionar seção "§X Criptografia de disco" com `cryptsetup luksFormat` sobre a RAID6, `/etc/crypttab`, desbloqueio e como validar no go-live (Fase 1) — ou, se a empresa optar por volume LVMLUK gerenciado, documentar essa decisão.
- **Aceite:** item #2 do checklist sai de 🟡 quando marcado como executado na Fase 1 do go-live.
- **Esforço:** M

---

## P1 — Antes do hard freeze / deploy

### P1-01 · Sincronizar repositório e commitar doc pendente
- **Problema:** local main 30 commits atrás de origin; `docs/PLANO-STORAGE-EXTERNO.md` untracked.
- **Ação:** `git pull --ff-only`; revisar diff desde o checklist; commitar o doc pendente.
- **Esforço:** S

### P1-02 · Enforcement real do `npm audit` no security-gate — Item 10
- **Problema:** em `.github/workflows/security-gate.yml:84,88` o npm audit roda com `|| true` (só publica artefato). Enforcement existe apenas no `ci.yml` (root/shared) e no osv-scanner.
- **Ação:** remover `|| true` e aplicar o mesmo gate (exit 1 em high/critical) aos jobs backend/frontend, alinhado com a exclusão documentada (braces/GHSA-vfj7-8cjj-p6jm, sem fix).
- **Aceite:** PR de teste com vuln high simulada (override artificial) bloqueia o pipeline.
- **Esforço:** S

### P1-03 · Whitelist explícita no `ShareMapper` (defesa em profundidade) — Item 4
- **Problema:** `...share` spread (`share/share.mapper.ts:14`) é seguro hoje porque `ShareToken` nunca é `include`d, mas um `include` futuro vaza `tokenHash` silenciosamente.
- **Ação:** substituir spread por whitelist explícita de campos + teste que falha se campo novo aparecer na saída.
- **Esforço:** S

### P1-04 · Decidir responsabilidade única por HSTS/CSP — Itens 3 e 7
- **Problema:** helmet aplica HSTS (2 anos, preload) e CSP incondicionalmente no backend (`main.ts:163-191`) enquanto Caddy injeta os mesmos headers (`Caddyfile.prod:24,43`) — primeira fonte vence no browser; risco de drift quando alguém editar só um lado.
- **Ação (decisão de arquitetura):** recomendação — **Caddy como fonte da verdade** para headers de edge; no helmet, desativar HSTS/CSP quando `TRUST_PROXY`/produção-via-Caddy (ou manter CSP idêntica e registrar a duplicação deliberada em comentário + doc de runbook).
- **Aceite:** resposta via Caddy e resposta direta ao container têm a MESMA CSP (script de verificação nos e2e de seguridad).
- **Esforço:** M

### P1-05 · Limpar dívida de auth legada
- **Problema:** `JwtStrategy` (passport-jwt) está registrado em `auth.module.ts:7,39` mas **nenhum guard a usa** — todos validam via `SessionService` (token opaco). Superfície morta + `RefreshToken.token @default(uuid())` mortos/misleading (`schema.prisma:53`).
- **Ação:** remover `JwtStrategy` + dependência passport-jwt (se sem outro uso); schema: renomear/limpar default (a coluna `tokenHash` no P0-01 já cobre LoginToken; RefreshToken segue o mesmo padrão).
- **Aceite:** e2e security + auth passando; grep `PassportStrategy` retorna zero.
- **Esforço:** S/M

### P1-06 · Atualizar o checklist de segmentos desatualizados
- **Problema:** referências de linha defasadas (local.service.ts:54→55), `safeRedirectPath` agora está no **frontend** (`frontend/src/utils/router.util.ts`), Item 10 npm audit não é gate direto, Item 12 Samba é doc-only.
- **Ação:** edit de CHECKLIST-SEGURANCA-FINAL.md — corrigir evidências e re-marcar #1/#3/#10/#12 como 🟡 PARCIAL até fechamento deste plano; referenciar este plano.
- **Esforço:** S

### P1-07 · Comentário desatualizado em `alerts.yml`
- **Problema:** cabeçalho menciona `kubectl apply` (origem K8s); o carregamento real é via `--config.file` no compose.
- **Ação:** corrigir comentário.
- **Esforço:** S

---

## P2 — Risco aceito / pós-go-live

### P2-01 · SVG + extensões instaláveis no allowlist sem AV — Item 8
- **Problema:** allowlist aceita `.svg` (XSS armazenado na renderização), `.sh/.ps1/.bat/.apk/.msi/.iso/.dmg` (`local.service.ts:61-77`) — distribuição de payload para destinatários do share.
- **Decisão recomendada:** (a) retirar `.svg` do allowlist OU servi-los com `Content-Disposition: attachment` + CSP sanitizada; (b) formalizar aceite de risco de executáveis no aceite de risco AV (Fase 5, já previsto) OU implementar antivírus (ClamAV) antes.
- **Esforço:** M

### P2-02 · Fase 5 do go-live
- Sign-off LGPD/DPIA, DR drill, pentest externo, aceite de risco AV — conforme `docs/GOLIVE-CHECKLIST.md` (fases 0–5, tudo pendente).

### P2-03 · Gate de deps git+/URL para backend/frontend
- **Status:** `ci.yml:87-122` valida apenas manifest raiz; backend verificado manualmente (limpo), frontend não. Estender script aos 3 manifests.

---

## Ordem de execução sugerida

| Semana | Itens | Saída |
|---|---|---|
| 1 | P1-01 (sync) → P0-01 → P0-02 → P0-03 → P1-07 | Segurança do código fechada |
| 2 | P1-02 → P1-03 → P1-04 → P1-05 → P1-06 | CI/gates + dívida limpa |
| 3 | P0-04 + Fases 0–3 do GOLIVE-CHECKLIST | Infra + staging prontos |
| 4 | Fases 4–5 do GOLIVE-CHECKLIST + P2 | Go-live + aceite de risco |

## Critério global de fechamento

Todos os itens P0 e P1 ✅ + verificar Fase 1 (LUKS) e Fase 2 (segredos novos) do go-live marcadas no `docs/GOLIVE-CHECKLIST.md` + CI verde no repo da empresa + pentest share rodado em build candidate.
