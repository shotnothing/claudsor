#!/usr/bin/env node
import { createRequire } from "node:module";
import { parseArgs, printHelp } from "./cli.js";
import { resolveBaseDir, setLogDir, logDir } from "./paths.js";

const require = createRequire(import.meta.url);
const pkg = require("./package.json");

const args = parseArgs(process.argv.slice(2));

if (args.help) {
  printHelp();
  process.exit(0);
}
if (args.version) {
  process.stdout.write(`${pkg.version}\n`);
  process.exit(0);
}

const base = resolveBaseDir({ flag: args.configDir });
if (args.logDir) setLogDir(args.logDir);

const { ensureToken } = await import("./auth.js");
const { startServer } = await import("./server.js");
const { startTunnel } = await import("./tunnel.js");

await ensureToken();

const server = startServer(args.port);

let tunnel = null;
if (!args.noTunnel) {
  try {
    tunnel = await startTunnel({ port: args.port, subdomain: args.subdomain });
  } catch (e) {
    console.warn(`[tunnel] failed: ${e.message} (continuing local-only)`);
  }
}

printBanner({
  port: args.port,
  tunnelUrl: tunnel?.url,
  configDir: base,
  logs: logDir(),
  version: pkg.version,
});

let shuttingDown = false;
const shutdown = () => {
  if (shuttingDown) return;
  shuttingDown = true;
  try { tunnel?.close(); } catch { /* ignore */ }
  try { server.close(); } catch { /* ignore */ }
  setTimeout(() => process.exit(0), 250).unref();
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

function printBanner({ port, tunnelUrl, configDir, logs, version }) {
  const lines = [
    "",
    `claudsor v${version}`,
    `  local:   http://localhost:${port}`,
    `  tunnel:  ${tunnelUrl ?? "(disabled)"}`,
    `  config:  ${configDir}`,
    `  logs:    ${logs}`,
    "",
    "Paste into Cursor -> Settings -> Models -> OpenAI Base URL:",
    `  ${tunnelUrl ?? `http://localhost:${port}`}`,
    "",
  ];
  process.stdout.write(lines.join("\n"));
}
