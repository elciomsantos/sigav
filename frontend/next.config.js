/** @type {import('next').NextConfig} */
const { execFileSync } = require("node:child_process");
const { version } = require("./package.json");

// A versão exibida no rodapé acompanha o git: usa a tag + commits + sha curto
// (ex.: v1.0.0-142-g2dc1f11). Em builds de imagem o `.git` não entra no
// contexto do Docker, então o valor é passado pelo build-arg APP_VERSION.
function gitVersion(args) {
  try {
    return execFileSync("git", args, {
      cwd: __dirname,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "";
  }
}

const appVersion =
  process.env.APP_VERSION?.trim() ||
  gitVersion(["describe", "--tags", "--always", "--dirty"]) ||
  gitVersion(["rev-parse", "--short", "HEAD"]) ||
  version;

const withSerwist = require("@serwist/next").default({
  swSrc: "src/sw.ts",
  swDest: "public/sw.js",
  disable: process.env.NODE_ENV === "development",
  reloadOnOnline: false,
  register: true,
});

const apiUrl = process.env.API_URL || "http://localhost:8080";

module.exports = withSerwist({
  transpilePackages: ["@uiw/react-md-editor", "@uiw/react-markdown-preview", "@controle-share/shared"],
  output: "standalone",
  images: {
    unoptimized: true,
  },
  cacheMaxMemorySize: 0,
  env: {
    VERSION: appVersion,
  },
  async rewrites() {
    return [
      {
        source: "/api/:path*",
        destination: `${apiUrl}/api/:path*`,
      },
    ];
  },
});
