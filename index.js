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
  const getWiseWords = () => {
    if (Math.random() > 0.2) {
      return "Hello!"
    }

    const wiseWords = [
      "Prompt engineering: turning \'do it\' into a 200-word essay", 
      "Never put off until tomorrow what you can put off forever",
      "Nothing is as permanent as a temporary solution that works",
      "Compatibility means deliberately repeating other people\'s mistakes",
      "“I use AI for boilerplate and still somehow get novel bugs",
      "It's not a bug, it's an undocumented feature!",
      "AI-generated code is just technical debt with better grammar",
      "Prompt engineering = arguing with autocomplete",
    ]
    return wiseWords[Math.floor(Math.random() * wiseWords.length)];
  }

  const lines = [
    ``,
    `彡(._.)ミ ${getWiseWords()}`,
    `  ^   ^`,
    `claudsor v${version}`,
    `  local:   http://localhost:${port}`,
    `  tunnel:  ${tunnelUrl ?? "(disabled)"}`,
    `  config:  ${configDir}`,
  ];
  if (logs) lines.push(`  logs:    ${logs}`);
  lines.push(
    "",
    "Paste into Cursor -> Settings -> Models -> OpenAI Base URL:",
    `  ${tunnelUrl ?? `http://localhost:${port}`}`,
    "",
  );
  process.stdout.write(lines.join("\n"));
}
