/**
 * P1-05 (PLANO-CORRECOES-2026-11-03): com a remoção da JwtStrategy (passport
 * era usado por nenhuma guard — a autenticação vai via JwtGuard/SessionService
 * com token opaco), o `user` no Request perde a declaração implícita das
 * @types/passport. Declaramos explicitamente aqui: o `req.user` é sempre um
 * User do Prisma, anexado pelo JwtGuard/guards opcionais.
 */
import { User } from "../../prisma/generated/prisma/client";

declare global {
  namespace Express {
    interface Request {
      user?: User;
    }
  }
}

export {};
