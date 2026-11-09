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