import { NotFoundException } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import { AuditEvent } from "../audit/audit-events";
import { PrivacyService } from "./privacy.service";

describe("PrivacyService (LGPD DSR)", () => {
  let prisma: {
    user: Record<string, jest.Mock>;
    share: { findMany: jest.Mock };
    downloadLog: { findMany: jest.Mock };
    session: { findMany: jest.Mock; updateMany: jest.Mock };
    refreshToken: { deleteMany: jest.Mock };
    loginToken: { deleteMany: jest.Mock };
    recoveryCode: { deleteMany: jest.Mock };
    resetPasswordToken: { deleteMany: jest.Mock };
    auditLog: { groupBy: jest.Mock };
    $transaction: jest.Mock;
  };
  let audit: { record: jest.Mock };
  let service: PrivacyService;

  beforeEach(() => {
    prisma = {
      user: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
      share: { findMany: jest.fn() },
      downloadLog: { findMany: jest.fn() },
      session: { findMany: jest.fn(), updateMany: jest.fn() },
      refreshToken: { deleteMany: jest.fn() },
      loginToken: { deleteMany: jest.fn() },
      recoveryCode: { deleteMany: jest.fn() },
      resetPasswordToken: { deleteMany: jest.fn() },
      auditLog: { groupBy: jest.fn() },
      $transaction: jest.fn(),
    };
    audit = { record: jest.fn().mockResolvedValue(undefined) };
    service = new PrivacyService(
      prisma as unknown as PrismaService,
      audit as unknown as AuditService,
    );
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe("exportUserData", () => {
    it("consulta o usuário via whitelist — password/totpSecret/tokens fora do select", async () => {
      const safeProfile = {
        id: "u1",
        username: "ana",
        email: "ana@x.com",
        role: "operador",
        isAdmin: false,
        totpEnabled: true,
        totpVerified: true,
        createdAt: new Date(),
        updatedAt: new Date(),
        isActivated: true,
        lastReviewedAt: null,
        shareSizeLimit: null,
      };
      prisma.user.findUnique.mockResolvedValue(safeProfile);
      prisma.share.findMany.mockResolvedValue([]);
      prisma.downloadLog.findMany.mockResolvedValue([]);
      prisma.session.findMany.mockResolvedValue([]);
      prisma.auditLog.groupBy.mockResolvedValue([
        { eventType: "LOGIN_SUCCESS", _count: { _all: 4 } },
      ]);

      const result = await service.exportUserData("u1");

      const select = prisma.user.findUnique.mock.calls[0][0].select;
      expect(Object.keys(select)).not.toContain("password");
      expect(Object.keys(select)).not.toContain("totpSecret");
      expect(Object.keys(select)).not.toContain("activationToken");
      expect(Object.keys(select)).not.toContain("resetPasswordToken");

      const serialized = JSON.stringify({
        ...result,
        profile: safeProfile,
      });
      expect(serialized).not.toContain("password");
      expect(serialized).not.toContain("totpSecret");
      expect(result.profile).not.toHaveProperty("password");
      expect(result.profile).not.toHaveProperty("totpSecret");
      expect(result.shares).toEqual([]);
      expect(result.notes.length).toBeGreaterThan(0);
      expect(result.auditSummary).toEqual([
        { eventType: "LOGIN_SUCCESS", count: 4 },
      ]);
      expect(prisma.user.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: "u1" } }),
      );
    });

    it("inclui sha256 dos arquivos — mas nunca tokenHash de shares", async () => {
      prisma.user.findUnique.mockResolvedValue({ id: "u1" });
      prisma.share.findMany.mockResolvedValue([
        {
          id: "s1",
          name: "backup",
          files: [{ id: "f1", name: "a.mp4", sha256: "abc123", size: 1n }],
          recipients: [{ email: "bob@y.com" }],
        },
      ]);
      prisma.downloadLog.findMany.mockResolvedValue([]);
      prisma.session.findMany.mockResolvedValue([]);
      prisma.auditLog.groupBy.mockResolvedValue([]);

      const result = await service.exportUserData("u1");

      const serialized = JSON.stringify(result, (_, v: unknown) =>
        typeof v === "bigint" ? v.toString() : v,
      );
      expect(serialized).toContain("abc123");
      expect(serialized).toContain("bob@y.com");
      expect(serialized).not.toContain("tokenHash");
    });

    it("falha 404 quando usuário não existe", async () => {
      prisma.user.findUnique.mockResolvedValue(null);
      await expect(service.exportUserData("ghost")).rejects.toThrow(
        NotFoundException,
      );
      expect(audit.record).not.toHaveBeenCalled();
    });

    it("registra DSR_EXPORT_REQUESTED na trilha de auditoria", async () => {
      prisma.user.findUnique.mockResolvedValue({ id: "u1" });
      prisma.share.findMany.mockResolvedValue([]);
      prisma.downloadLog.findMany.mockResolvedValue([]);
      prisma.session.findMany.mockResolvedValue([]);
      prisma.auditLog.groupBy.mockResolvedValue([]);

      await service.exportUserData("u1");

      expect(audit.record).toHaveBeenCalledWith(
        AuditEvent.DSR_EXPORT_REQUESTED,
        expect.objectContaining({ userId: "u1" }),
      );
    });
  });

  describe("eliminatePersonalData (Art. 18, VI)", () => {
    it("anonimiza perfil, revoga sessões e elimina credenciais em transação", async () => {
      prisma.session.updateMany.mockResolvedValue({ count: 2 });
      prisma.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) =>
        fn(prisma),
      );
      prisma.user.update.mockResolvedValue({ id: "u1" });

      const result = await service.eliminatePersonalData("u1");

      expect(result.anonymized).toBe(true);
      expect(result.sessionsRevoked).toBe(2);
      expect(prisma.session.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { userId: "u1", revokedAt: null } }),
      );
      expect(prisma.refreshToken.deleteMany).toHaveBeenCalledWith({
        where: { userId: "u1" },
      });
      expect(prisma.loginToken.deleteMany).toHaveBeenCalledWith({
        where: { userId: "u1" },
      });
      expect(prisma.recoveryCode.deleteMany).toHaveBeenCalledWith({
        where: { userId: "u1" },
      });
      expect(prisma.resetPasswordToken.deleteMany).toHaveBeenCalledWith({
        where: { userId: "u1" },
      });

      const updateData = prisma.user.update.mock.calls[0][0].data;
      expect(updateData.password).toBeNull();
      expect(updateData.totpSecret).toBeNull();
      expect(updateData.isActivated).toBe(false);
      expect(updateData.isAdmin).toBe(false);
      expect(updateData.username).toMatch(/^anon-[a-f0-9]{18}$/);
      expect(updateData.email).toMatch(/@eliminado\.lgpd\.invalid$/);
      // Emails/username anonimizados não devem repetir o original
      expect(updateData.username).not.toBe(updateData.email);
      // dados identificáveis antigos nunca reaparecem
      expect(JSON.stringify(updateData)).not.toContain("ana@x.com");
    });

    it("registra DSR_ELIMINATION_REQUESTED na trilha de auditoria", async () => {
      prisma.session.updateMany.mockResolvedValue({ count: 0 });
      prisma.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) =>
        fn(prisma),
      );
      prisma.user.update.mockResolvedValue({ id: "u1" });

      await service.eliminatePersonalData("u1");

      expect(audit.record).toHaveBeenCalledWith(
        AuditEvent.DSR_ELIMINATION_REQUESTED,
        expect.objectContaining({ userId: "u1", result: "anonymized" }),
      );
    });
  });
});
