#!/usr/bin/env node
/**
 * scripts/ci/npm-audit-gate.mjs — enforcement do npm audit (P1-02,
 * PLANO-CORRECOES-2026-11-03, Item 10 do checklist).
 *
 * Uso: node scripts/ci/npm-audit-gate.mjs npm-audit-workspace.json
 *
 * Entra se houver advisory HIGH/CRITICAL fora da lista de exclusões
 * documentadas abaixo (risco aceito com revisão — cada exclusão precisa de
 * justificativa e condição de saída). Saída 0 caso contrário.
 */
import { readFileSync } from "node:fs";

const EXCLUDED = new Set([
  // braces: sem correção upstream (todas as versões <=3.0.3 vulneráveis;
  // verificado 2026-10-13). No frontend a cadeia é 100% dev-time (eslint).
  // No backend foi eliminada via override de chokidar@4 no nestjs-i18n.
  // Remover da exclusão quando upstream publicar correção.
  "GHSA-vfj7-8cjw-p6xm",
  // zod <4.6.6 (exaustão de memória, CWE-770): o fix exige downgrade do
  // @serwist/next de ^9 para ^8 (breaking change). Risco aceito; reavaliar
  // a cada bump do @serwist/next no dependabot (ver P2-02 / Fase 5 go-live).
  "GHSA-mrhx-c7xc-m3w5",
]);

const file = process.argv[2];
if (!file) {
    console.error("npm-audit-gate: informe o caminho do JSON do npm audit");
    process.exit(1);
}

let data;
try {
    data = JSON.parse(readFileSync(file, "utf8"));
} catch (err) {
    console.error(`npm-audit-gate: não foi possível ler ${file}: ${err.message}`);
    process.exit(1);
}

const findings = Object.values(data.advisories ?? {})
    .filter((adv) => (adv.severity === "high" || adv.severity === "critical") && !EXCLUDED.has(adv.id))
    .map((adv) => `${adv.id} [${adv.severity}] ${adv.module_name}: ${adv.title}`);

if (findings.length > 0) {
    console.error(`npm-audit-gate: ${file} — ${findings.length} advisory(s) HIGH/CRITICAL fora das exclusões documentadas:`);
    for (const f of findings) console.error(`  - ${f}`);
    process.exit(1);
}

console.log(`npm-audit-gate: ${file} OK (nenhum HIGH/CRITICAL fora das exclusões documentadas)`);
