import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { logDir } from "./paths.js";

function ensureDir() {
  try { fs.mkdirSync(logDir(), { recursive: true }); } catch { /* ignore */ }
}

function append(file, record) {
  ensureDir();
  const line = JSON.stringify({ ts: new Date().toISOString(), ...record }) + "\n";
  try {
    fs.appendFileSync(path.join(logDir(), file), line);
  } catch (e) {
    console.error(`[logger] failed to write ${file}:`, e.message);
  }
}

export function newRequestId() {
  return "req_" + crypto.randomBytes(8).toString("hex");
}

export function logHttp(rec) { append("http.jsonl", rec); }
export function logInput(rec) { append("input.jsonl", rec); }
export function logOutput(rec) { append("output.jsonl", rec); }
export function logError(rec) {
  append("errors.jsonl", rec);
  console.error(`[${rec.req_id ?? "-"}] ${rec.where ?? "error"}: ${rec.message ?? ""}`);
}
