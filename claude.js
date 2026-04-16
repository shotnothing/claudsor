import { ensureToken, invalidate } from "./auth.js";

const API_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";
const ANTHROPIC_BETA = "oauth-2025-04-20,prompt-caching-2024-07-31";

async function doFetch(body, token) {
  return fetch(API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${token}`,
      "anthropic-version": ANTHROPIC_VERSION,
      "anthropic-beta": ANTHROPIC_BETA,
    },
    body: JSON.stringify(body),
  });
}

export async function callMessages(body) {
  let token = await ensureToken();
  let r = await doFetch(body, token);
  if (r.status === 401) {
    await invalidate();
    token = await ensureToken();
    r = await doFetch(body, token);
  }
  if (body.stream) return r;
  if (!r.ok) {
    const text = await r.text();
    throw new Error(`anthropic ${r.status}: ${text}`);
  }
  return r.json();
}
