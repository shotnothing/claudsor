import lt from "localtunnel";

export async function startTunnel({ port, subdomain } = {}) {
  const opts = { port };
  if (subdomain) opts.subdomain = subdomain;
  const t = await lt(opts);
  t.on("close", () => console.warn("[tunnel] closed"));
  t.on("error", (e) => console.warn(`[tunnel] error: ${e.message}`));
  return t;
}
