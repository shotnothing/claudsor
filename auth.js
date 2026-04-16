import crypto from "node:crypto";
import fs from "node:fs/promises";
import readline from "node:readline";
import { exec } from "node:child_process";
import { tokenPath } from "./paths.js";

const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const REDIRECT_URI = "https://console.anthropic.com/oauth/code/callback";
const AUTH_URL = "https://claude.ai/oauth/authorize";
const TOKEN_URL = "https://console.anthropic.com/v1/oauth/token";
const SCOPES = "org:create_api_key user:profile user:inference";
const LEGACY_TOKEN_FILE = "./claude.txt";

function b64url(buf) {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function openBrowser(url) {
  const cmd =
    process.platform === "win32"
      ? `start "" "${url}"`
      : process.platform === "darwin"
      ? `open "${url}"`
      : `xdg-open "${url}"`;
  exec(cmd, () => {});
}

function ask(q) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((r) => rl.question(q, (a) => { rl.close(); r(a.trim()); }));
}

async function readFile() {
  try {
    const raw = await fs.readFile(tokenPath(), "utf8");
    return JSON.parse(raw);
  } catch {
    try {
      const raw = await fs.readFile(LEGACY_TOKEN_FILE, "utf8");
      const parsed = JSON.parse(raw);
      await writeFile(parsed);
      await fs.rm(LEGACY_TOKEN_FILE, { force: true });
      return parsed;
    } catch {
      return null;
    }
  }
}

async function writeFile(data) {
  await fs.writeFile(tokenPath(), JSON.stringify(data, null, 2), "utf8");
}

export async function invalidate() {
  await fs.rm(tokenPath(), { force: true });
}

async function refresh(refreshToken) {
  const r = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: CLIENT_ID,
    }),
  });
  if (!r.ok) return null;
  const j = await r.json();
  const record = {
    access_token: j.access_token,
    refresh_token: j.refresh_token ?? refreshToken,
    expires_at: Math.floor(Date.now() / 1000) + (j.expires_in ?? 3600),
  };
  await writeFile(record);
  return record;
}

async function login() {
  const verifier = b64url(crypto.randomBytes(32));
  const challenge = b64url(crypto.createHash("sha256").update(verifier).digest());

  const url = new URL(AUTH_URL);
  url.searchParams.set("code", "true");
  url.searchParams.set("client_id", CLIENT_ID);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", REDIRECT_URI);
  url.searchParams.set("scope", SCOPES);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", verifier);

  console.log("\nOpen this URL and approve, then copy the code#state shown on the callback page:\n");
  console.log(url.toString() + "\n");
  openBrowser(url.toString());

  const pasted = await ask("Paste code#state: ");
  const [code, state] = pasted.split("#");
  if (!code) throw new Error("no code pasted");

  const r = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "authorization_code",
      code,
      state: state ?? "",
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT_URI,
      code_verifier: verifier,
    }),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`token exchange failed (${r.status}): ${text}`);
  const j = JSON.parse(text);
  const record = {
    access_token: j.access_token,
    refresh_token: j.refresh_token,
    expires_at: Math.floor(Date.now() / 1000) + (j.expires_in ?? 3600),
  };
  await writeFile(record);
  return record;
}

export async function ensureToken() {
  const now = Math.floor(Date.now() / 1000);
  const existing = await readFile();
  if (existing?.access_token && existing.expires_at - 60 > now) return existing.access_token;
  if (existing?.refresh_token) {
    const refreshed = await refresh(existing.refresh_token);
    if (refreshed) return refreshed.access_token;
  }
  const fresh = await login();
  return fresh.access_token;
}

export async function getToken() {
  return ensureToken();
}
