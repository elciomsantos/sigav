import { Injectable } from "@nestjs/common";
import { toBytes } from "@/shared/dto";
import { File, ShareRecipient, ShareSecurity, User } from "../../prisma/generated/prisma/client";

interface ShareLike {
  id?: string;
  createdAt?: unknown;
  updatedAt?: unknown;
  name?: unknown;
  description?: unknown;
  expiration?: unknown;
  uploadLocked?: unknown;
  isZipReady?: unknown;
  views?: unknown;
  downloads?: unknown;
  removedReason?: unknown;
  storageProvider?: unknown;
  files?: File[];
  creator?: User | null;
  security?: ShareSecurity | null;
  recipients?: ShareRecipient[];
}

/**
 * P1-03 (PLANO-CORRECOES-2026-11-03, Item 4 do checklist): whitelist
 * explícita de campos de saída — substitui o `{ ...share }` que era seguro
 * apenas porque nenhum `include` extra era usado. Um `include: { shareTokens:
 * true }` futuro vaziaria `tokenHash` silenciosamente através do spread.
 *
 * Campos novos do modelo Share NÃO aparecem na resposta até serem
 * adicionados aqui deliberadamente (teste abaixo garante).
 */
const SHARE_WHITELIST = [
  "id",
  "createdAt",
  "updatedAt",
  "name",
  "description",
  "expiration",
  "uploadLocked",
  "isZipReady",
  "views",
  "downloads",
  "removedReason",
  "storageProvider",
] as const;

@Injectable()
export class ShareMapper {
  transformShare(share: ShareLike): Record<string, unknown> {
    const whitelist: Record<string, unknown> = {};
    for (const field of SHARE_WHITELIST) {
      whitelist[field] = share[field] ?? null;
    }

    return {
      ...whitelist,
      size: share.files?.reduce((acc: number, file: File) => acc + toBytes(file.size), 0) ?? 0,
      files: share.files ?? [],
      // creator sanitizado: apenas campos públicos — a linha inteira do User
      // (incl. hash de senha, TOTP secret) nunca sai pela resposta.
      creator: share.creator
        ? {
            id: share.creator.id,
            email: share.creator.email,
            username: share.creator.username,
          }
        : null,
      recipients: share.recipients?.map((recipient: ShareRecipient) => recipient.email) ?? [],
      security: {
        maxViews: share.security?.maxViews ?? null,
        maxDownloads: share.security?.maxDownloads ?? null,
        passwordProtected: !!share.security?.password,
      },
    };
  }
}
