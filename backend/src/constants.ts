import { LogLevel } from "@nestjs/common";
import * as path from "path";

export const CONFIG_FILE = process.env.CONFIG_FILE || "../config.yaml";

// DATA_DIRECTORY é o diretório de dados persistente da aplicação (DB,
// uploads, audit-worm). O padrão `../data` resolve para /opt/app/data no
// container (cwd=/opt/app/backend) e para <repo>/data em desenvolvimento.
export const DATA_DIRECTORY = process.env.DATA_DIRECTORY || "../data";
// Imagens usadas no cabeçalho padrão dos certificados (logo + brasão). Em
// produção o build copia backend/assets/images para o container; localmente
// aponta para ./assets/images relativo ao cwd do backend.
export const CERTIFICATE_ASSETS_DIRECTORY =
  process.env.CERTIFICATE_ASSETS_DIRECTORY ||
  path.resolve("assets/images");
export const SHARE_DIRECTORY = `${DATA_DIRECTORY}/uploads/shares`;
export const DATABASE_URL =
  process.env.DATABASE_URL ||
  "file:../data/controle-videos.db";

export const LOG_LEVEL_AVAILABLE: LogLevel[] = ['verbose', 'debug', 'log', 'warn', 'error', 'fatal'];
export const LOG_LEVEL_DEFAULT: LogLevel = process.env.NODE_ENV === 'development' ? "verbose" : "log";
export const LOG_LEVEL_ENV = `${process.env.PV_LOG_LEVEL || ""}`;

// SEC-1.2/22 — Limite de tentativas dos endpoints de autenticação (login,
// TOTP, reautenticação, recovery). Padrão de 5 por minuto, alinhado ao
// §22.1, e a chave é conta+IP (RequestThrottlerGuard).
//
// O limite é configurável por ambiente porque o harness E2E loga com o mesmo
// admin em vários specs dentro da mesma janela de 60s: com 5/min a 6ª
// tentativa levava 429, a tela voltava para /auth/signIn e os asserts de
// /auth/totp falham de forma intermitente (run 42622993563). O valor só sai
// do padrão quando o env é explicitamente definido — produção permanece 5.
const authLoginThrottleLimitEnv = Number(
  process.env.AUTH_LOGIN_THROTTLE_LIMIT ?? 5,
);
const authLoginThrottleTtlEnv = Number(
  process.env.AUTH_LOGIN_THROTTLE_TTL_MS ?? 60_000,
);

export const AUTH_LOGIN_THROTTLE = {
  limit:
    Number.isFinite(authLoginThrottleLimitEnv) &&
    authLoginThrottleLimitEnv > 0
      ? authLoginThrottleLimitEnv
      : 5,
  ttl:
    Number.isFinite(authLoginThrottleTtlEnv) && authLoginThrottleTtlEnv > 0
      ? authLoginThrottleTtlEnv
      : 60_000,
};

// Argon2id options: memory=128MB, timeCost=4, parallelism=2
// Stronger than library defaults (64MB/3/4) for internal-only use
export const ARGON2_OPTIONS = {
  type: 2, // argon2id
  memoryCost: 131072,
  timeCost: 4,
  parallelism: 2,
} as const;

// SEC-TIMING (VULN-04): hash Argon2id pré-computado (mesmos parâmetros de
// ARGON2_OPTIONS) verificado contra a senha informada quando o usuário não
// existe — mantém a latência do login constante e elimina o oráculo de
// enumeração via diferença de tempo. O valor não corresponde a nenhum
// usuário; é apenas um alvo de custo.
export const ARGON2_TIMING_DUMMY_HASH =
  "$argon2id$v=19$m=131072,p=2,t=4$d6aXaeG5Jn47GUeYuTjtKQ$TSi89ms1dcRq/IFuZS5aWqnkQebzQUo1IUTIlLlZ8yk";