const DEBUG_FLAG = "VITE_ENABLE_DEBUG_DIAGNOSTICS";

type DebugEnv = {
  DEV?: boolean;
  VITE_ENABLE_DEBUG_DIAGNOSTICS?: string | boolean;
};

function parseDebugFlag(value: string | boolean | undefined) {
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") return false;
  return value.toLowerCase() === "true";
}

function getImportMetaEnv(): DebugEnv | undefined {
  return typeof import.meta !== "undefined" ? (import.meta.env as DebugEnv | undefined) : undefined;
}

function getProcessEnvFlag() {
  return typeof process !== "undefined" ? process.env?.[DEBUG_FLAG] : undefined;
}

export function isDebugEnabled() {
  const importMetaEnv = getImportMetaEnv();
  return (
    Boolean(importMetaEnv?.DEV) ||
    parseDebugFlag(importMetaEnv?.VITE_ENABLE_DEBUG_DIAGNOSTICS) ||
    parseDebugFlag(getProcessEnvFlag())
  );
}

function writeDebug(method: "info" | "warn" | "error", ...args: Parameters<typeof console.info>) {
  if (!isDebugEnabled()) return;
  console[method](...args);
}

export function debugLog(...args: Parameters<typeof console.info>) {
  writeDebug("info", ...args);
}

export function debugWarn(...args: Parameters<typeof console.warn>) {
  writeDebug("warn", ...args);
}

export function debugError(...args: Parameters<typeof console.error>) {
  writeDebug("error", ...args);
}

export function createErrorReferenceId(prefix = "err") {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
