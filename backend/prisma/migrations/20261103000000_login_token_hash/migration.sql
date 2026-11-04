-- P0-01 (Plano de correções 2026-11-03): login tokens passam a ser
-- persistidos apenas como SHA-256 (`tokenHash`, PK), tal como Session/
-- RefreshToken/RecoveryCode. Os registros são efêmeros (TTL de 5 minutos e
-- limpeza horária em jobs), portanto a tabela é recriada sem preservação de
-- dados — loginTokens pendentes ativos são invalidados pela troca.
PRAGMA foreign_keys=OFF;

DROP TABLE "LoginToken";

CREATE TABLE "LoginToken" (
    "tokenHash" TEXT NOT NULL PRIMARY KEY,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" DATETIME NOT NULL,
    "userId" TEXT NOT NULL,
    "used" BOOLEAN NOT NULL DEFAULT false,
    CONSTRAINT "LoginToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "LoginToken_userId_idx" ON "LoginToken"("userId");

PRAGMA foreign_keys=ON;
