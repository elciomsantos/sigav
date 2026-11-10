import argon from "argon2";
import { UserService } from "./user.service";
import { AuditEvent } from "../audit/audit.service";

jest.mock("argon2", () => ({
  hash: jest.fn(),
  verify: jest.fn(),
}));

describe("UserService.update", () => {
  let prisma: {
    user: { findUnique: jest.Mock; update: jest.Mock; count: jest.Mock };
    refreshToken: { deleteMany: jest.Mock };
  };
  let config: { getNumber: jest.Mock; getBoolean: jest.Mock };
  let auditService: { record: jest.Mock };
  let service: UserService;

  const existingUser = {
    id: "u1",
    username: "user",
    email: "user@example.com",
    role: "operador",
    isAdmin: false,
    isActivated: true,
  };

  beforeEach(() => {
    jest.clearAllMocks();
    prisma = {
      user: {
        findUnique: jest.fn().mockResolvedValue(existingUser),
        // Devolve o registro com os campos efetivamente gravados.
        update: jest
          .fn()
          .mockImplementation(
            async ({ data }: { data: Record<string, unknown> }) => ({
              ...existingUser,
              ...data,
            }),
          ),
        count: jest.fn().mockResolvedValue(2),
      },
      refreshToken: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }) },
    };
    config = {
      getNumber: jest.fn().mockReturnValue(12),
      getBoolean: jest.fn(),
    };
    auditService = { record: jest.fn().mockResolvedValue(undefined) };
    service = new UserService(
      prisma as never,
      { sendInviteEmail: jest.fn() } as never,
      {} as never,
      { t: jest.fn((key: string) => `t:${key}`) } as never,
      config as never,
      auditService as never,
    );

    (argon.hash as jest.Mock).mockImplementation(
      async (plain: string) => `hash:${plain}`,
    );
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it("gera senha aleatória e a devolve uma única vez quando generatePassword está ativo", async () => {
    const result = await service.update("u1", { generatePassword: true });

    expect(result.temporaryPassword).toBeDefined();
    expect(result.temporaryPassword).toHaveLength(12);
    // A senha em texto puro nunca é persistida — só o hash.
    expect(result.user.password).toBe(`hash:${result.temporaryPassword}`);
    expect(result.user.password).not.toBe(result.temporaryPassword);
    expect(argon.hash).toHaveBeenCalledWith(
      result.temporaryPassword,
      expect.anything(),
    );
  });

  it("não devolve senha temporária quando o admin define a senha manualmente", async () => {
    const result = await service.update("u1", { password: "senha-manual-1" });

    expect(result.temporaryPassword).toBeUndefined();
    expect(result.user.password).toBe("hash:senha-manual-1");
    expect(argon.hash).toHaveBeenCalledWith(
      "senha-manual-1",
      expect.anything(),
    );
  });

  it("mantém a senha atual quando nenhuma senha é informada", async () => {
    const result = await service.update("u1", { username: "novo-nome" });

    expect(result.temporaryPassword).toBeUndefined();
    expect(argon.hash).not.toHaveBeenCalled();
    expect(prisma.user.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.not.objectContaining({ password: expect.anything() }),
      }),
    );
  });

  it("revoga as sessões e audita a troca de senha administrativa", async () => {
    await service.update("u1", { generatePassword: true });

    expect(prisma.refreshToken.deleteMany).toHaveBeenCalledWith({
      where: { userId: "u1" },
    });
    expect(auditService.record).toHaveBeenCalledWith(
      AuditEvent.PASSWORD_CHANGED,
      expect.objectContaining({ userId: "u1", result: "success" }),
    );
  });
});
