const HELP = `claudsor - OpenAI-compatible proxy for Anthropic Claude

Usage:
  claudsor [options]

Options:
  -p, --port <n>         Port to listen on (default: 5090)
      --no-tunnel        Do not start localtunnel
      --subdomain <name> Requested localtunnel subdomain
      --config-dir <p>   Override config dir (default: ~/.claudsor)
      --log-dir <p>      Override log dir (default: <config-dir>/logs)
  -h, --help             Show this help
  -v, --version          Show version

Environment:
  CLAUDSOR_HOME          Same as --config-dir
  CLAUDSOR_LOG_DIR       Same as --log-dir
`;

function needValue(flag, v) {
  if (v === undefined) {
    console.error(`error: ${flag} requires a value`);
    process.exit(2);
  }
  return v;
}

export function parseArgs(argv) {
  const out = {
    port: Number(process.env.PORT) || 5090,
    noTunnel: false,
    subdomain: undefined,
    configDir: undefined,
    logDir: undefined,
    help: false,
    version: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    let key = a;
    let val;
    const eq = a.indexOf("=");
    if (a.startsWith("--") && eq !== -1) {
      key = a.slice(0, eq);
      val = a.slice(eq + 1);
    }
    const take = () => (val !== undefined ? val : argv[++i]);

    switch (key) {
      case "-p":
      case "--port": {
        const v = needValue(key, take());
        const n = Number(v);
        if (!Number.isInteger(n) || n <= 0 || n > 65535) {
          console.error(`error: invalid port "${v}"`);
          process.exit(2);
        }
        out.port = n;
        break;
      }
      case "--no-tunnel":
        out.noTunnel = true;
        break;
      case "--subdomain":
        out.subdomain = needValue(key, take());
        break;
      case "--config-dir":
        out.configDir = needValue(key, take());
        break;
      case "--log-dir":
        out.logDir = needValue(key, take());
        break;
      case "-h":
      case "--help":
        out.help = true;
        break;
      case "-v":
      case "--version":
        out.version = true;
        break;
      default:
        console.error(`error: unknown argument "${a}"`);
        console.error(HELP);
        process.exit(2);
    }
  }
  return out;
}

export function printHelp() {
  process.stdout.write(HELP);
}
