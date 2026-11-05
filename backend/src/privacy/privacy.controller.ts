import { Controller, Get, Post } from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import { User } from "../../prisma/generated/prisma/client";
import { GetUser } from "../auth/decorator/getUser.decorator";
import { Authenticated } from "../auth/decorator/guards.decorator";
import { ReauthRequired } from "../auth/decorator/reauth.decorator";
import { PrivacyService } from "./privacy.service";

/**
 * LGPD — Art. 18 (Direitos do Titular / DSR) — `docs/lgpd-lawful-basis.md`
 * Item 13 e action items (implementação do endpoint `/api/privacy/dsr`).
 *
 * Autenticação: sessão válida + marca de reautenticação recente (senha, com
 * TOTP quando ativo — `ReauthRequired`). Limite dedicado e restritivo: DSR
 * não é fluxo de UI normal e não deve absorver o limite global.
 */
@Controller("privacy")
@Throttle({ default: { limit: 10, ttl: 60_000 } })
export class PrivacyController {
  constructor(private privacy: PrivacyService) {}

  /** Acesso (Art. 18, II) + Portabilidade (Art. 18, V). */
  @Get("dsr/data")
  @Authenticated()
  @ReauthRequired()
  async exportData(@GetUser() user: User) {
    return this.privacy.exportUserData(user.id);
  }

  /** Eliminação/Anonimização (Art. 18, VI). */
  @Post("dsr/delete")
  @Authenticated()
  @ReauthRequired()
  async deleteData(@GetUser() user: User) {
    return this.privacy.eliminatePersonalData(user.id);
  }
}
