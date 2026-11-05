import {
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { createHash, randomBytes } from "crypto";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import { AuditEvent } from "../audit/audit-events";

/**
 * LGPD — Art. 18 (Direitos do Titular / DSR) — Item 13 do
 * `docs/lgpd-lawful-basis.md`.
 *
 * Endpoint `/api/privacy/dsr`:
 *  - `GET  /data` — Acesso (Art. 18, II + IX) e Portabilidade (Art. 18, V):
 *    exportação estruturada (JSON) de todos os dados pessoais do titular.
 *  - `POST /delete` — Eliminação (Art. 18, VI): anonimização dos dados de
 *    identificação do titular e revogação de todas as credenciais/sessões.
 *
 * Regras de segurança:
 *  - `ReauthRequired` (reautenticação recente de senha, janela de 5 min) +
 *    TOTP herdado do fluxo de reautenticação — atendem a "verificação de
 *    identidade (MFA)";
 *  - Exportação usa **whitelist** de campos — senha, totpSecret, tokenHash e
 *    segredos de config nunca entram na saída;
 *  - Registros de auditoria (WORM) NÃO são reescritos nem deletados: a
 *    eliminação anonimiza o perfil; o vínculo nominal nas trilhas permanece
 *    com FK `SetNull` sobre o user_id (Art. 16 — providências + finalidade de
 *    segurança/auditoria; retenção 7 anos conforme lgpd-lawful-basis Item 13);
 *  - Ambos os eventos são registrados na trilha de auditoria (fail-safe —
 *    AuditService.record nunca lança).
 */

/**
 * Domínio de e-mail usado na anonimização (DSR). O job de limpeza de
 * usuários não-ativados NÃO pode remover essas contas (o cascade apagaria
 * os shares do titular — registros de negócio/auditoria).
 */
export const ELIMINATED_EMAIL_DOMAIN = "eliminado.lgpd.invalid";

@Injectable()
export class PrivacyService {
  constructor(
    private prisma: PrismaService,
    private audit: AuditService,
  ) {}

  /**
   * Exportação de dados do titular (acesso + portabilidade).
   * Somente campos seguros, em formato estruturado (JSON).
   */
  async exportUserData(userId: string): Promise<{
    generatedAt: string;
    profile: Record<string, unknown>;
    shares: Array<Record<string, unknown>>;
    downloadLogs: Array<Record<string, unknown>>;
    sessions: Array<Record<string, unknown>>;
    auditSummary: Array<{ eventType: string; count: number }>;
    notes: string[];
  }> {
    const profile = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        createdAt: true,
        updatedAt: true,
        username: true,
        email: true,
        role: true,
        isAdmin: true,
        shareSizeLimit: true,
        totpEnabled: true,
        totpVerified: true,
        isActivated: true,
        lastReviewedAt: true,
        // NUNCA: password, totpSecret, tokens, códigos de recuperação
      },
    });

    if (!profile) throw new NotFoundException("user_not_found");

    const shares = await this.prisma.share.findMany({
      where: { creatorId: userId },
      select: {
        id: true,
        createdAt: true,
        updatedAt: true,
        name: true,
        description: true,
        uploadLocked: true,
        views: true,
        downloads: true,
        expiration: true,
        removedReason: true,
        files: {
          select: {
            id: true,
            createdAt: true,
            name: true,
            size: true,
            sha256: true,
          },
        },
        recipients: {
          select: {
            email: true,
            // ShareRecipient não tem createdAt no schema; id omitido p/
            // minimizar dados de terceiros na exportação.
          },
        },
      },
      orderBy: { createdAt: "desc" },
    });

    const downloadLogs = await this.prisma.downloadLog.findMany({
      where: { userId },
      select: {
        createdAt: true,
        fileName: true,
        mimeType: true,
        success: true,
        reason: true,
        event: true,
        ip: true,
      },
      orderBy: { createdAt: "desc" },
      take: 1000,
    });

    const sessions = await this.prisma.session.findMany({
      where: { userId },
      select: {
        id: true,
        createdAt: true,
        lastActivityAt: true,
        expiresAt: true,
        revokedAt: true,
        ipAddress: true,
        userAgent: true,
      },
    });

    const auditSummary = await this.prisma.auditLog.groupBy({
      by: ["eventType"],
      where: { userId },
      _count: { _all: true },
    });

    const result = {
      generatedAt: new Date().toISOString(),
      profile,
      shares,
      downloadLogs,
      sessions,
      auditSummary: auditSummary.map((row) => ({
        eventType: row.eventType,
        count: row._count._all,
      })),
      notes: [
        "Exportação gerada conforme LGPD Art. 18, II (acesso) e V (portabilidade).",
        "Campos sensíveis (senha, segundo fator, tokens e códigos) são omitidos por design.",
        "Trilhas de auditoria (WORM) são registros de segurança da plataforma: incluídas aqui apenas como resumo agregado, não editáveis pelo titular.",
      ],
    };

    await this.audit.record(AuditEvent.DSR_EXPORT_REQUESTED, {
      userId,
      resource: "privacy/dsr/data",
    });

    return result;
  }

  /**
   * Eliminação dos dados pessoais do titular (Art. 18, VI): anonimização
   * irredutível do perfil + revogação de todas as credenciais ativas.
   *
   * O usuário permanece cadastrado (FKs de shares/auditoria preservam a
   * integridade referencial e a trilha WORM), mas sem qualquer dado
   * identificável: username/email passam a pseudônimo random, senha e 2º
   * fator são removidos, conta desativada — login impossível.
   */
  async eliminatePersonalData(userId: string): Promise<{
    anonymized: boolean;
    sessionsRevoked: number;
    retainedFor: string;
  }> {
    const anon = randomBytes(9).toString("hex");
    const userIdHash = createHash("sha256").update(userId).digest("hex").slice(0, 16);

    const sessionsRevoked = await this.prisma.$transaction(async (tx) => {
      // 1. Revoga todas as sessões ativas (auditável e imediato).
      const revoked = await tx.session.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: new Date() },
      });

      // 2. Invalida credenciais: refresh/login tokens, recovery codes e
      //    reset de senha (cascateiam / são dados transitórios do titular).
      await tx.refreshToken.deleteMany({ where: { userId } });
      await tx.loginToken.deleteMany({ where: { userId } });
      await tx.recoveryCode.deleteMany({ where: { userId } });
      await tx.resetPasswordToken.deleteMany({ where: { userId } });

      // 3. Anonimização do perfil identificável.
      await tx.user.update({
        where: { id: userId },
        data: {
          username: `anon-${anon}`,
          email: `${userIdHash}@${ELIMINATED_EMAIL_DOMAIN}`,
          password: null,
          totpEnabled: false,
          totpVerified: false,
          totpSecret: null,
          isActivated: false,
          passwordMustChange: false,
          isAdmin: false,
        },
      });

      return revoked.count;
    });

    await this.audit.record(AuditEvent.DSR_ELIMINATION_REQUESTED, {
      userId,
      resource: "privacy/dsr/delete",
      result: "anonymized",
      metadata: { sessionsRevoked },
    });

    return {
      anonymized: true,
      sessionsRevoked,
      retainedFor:
        "Trilhas de auditoria (WORM) preservadas com retenção legislada (7 anos); link nominal com o titular foi pseudonimizado.",
    };
  }
}
