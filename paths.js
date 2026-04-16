import os from "node:os";
import path from "node:path";
import fs from "node:fs";

let baseDir = null;
let logDirOverride = null;

export function setBaseDir(dir) {
  baseDir = path.resolve(dir);
  fs.mkdirSync(baseDir, { recursive: true });
}

export function resolveBaseDir({ flag } = {}) {
  const dir = flag || process.env.CLAUDSOR_HOME || path.join(os.homedir(), ".claudsor");
  setBaseDir(dir);
  return baseDir;
}

export function setLogDir(dir) {
  logDirOverride = dir ? path.resolve(dir) : null;
}

export function baseDirPath() {
  if (!baseDir) resolveBaseDir();
  return baseDir;
}

export function tokenPath() {
  return path.join(baseDirPath(), "token.json");
}

export function logDir() {
  if (logDirOverride) return logDirOverride;
  if (process.env.CLAUDSOR_LOG_DIR) return path.resolve(process.env.CLAUDSOR_LOG_DIR);
  return null;
}
