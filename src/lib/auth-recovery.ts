export const MIN_PASSWORD_LENGTH = 12;
const PASSWORD_RECOVERY_PENDING_KEY = "mgt:passwordRecoveryPending";

export const GENERIC_RECOVERY_SUCCESS_MESSAGE =
  "If this email is authorized, you will receive an access link shortly.";

export function getRecoveryRedirectUrl() {
  if (typeof window === "undefined") return undefined;
  return `${window.location.origin}/reset-password`;
}

export function currentUrlIndicatesRecovery() {
  if (typeof window === "undefined") return false;

  const url = new URL(window.location.href);
  if (url.searchParams.get("type") === "recovery") {
    return true;
  }

  const hash = url.hash.startsWith("#") ? url.hash.slice(1) : url.hash;
  const hashParams = new URLSearchParams(hash);
  return hashParams.get("type") === "recovery";
}

export function markPasswordRecoveryPending() {
  if (typeof window === "undefined") return;
  sessionStorage.setItem(PASSWORD_RECOVERY_PENDING_KEY, "1");
}

export function isPasswordRecoveryPending() {
  if (typeof window === "undefined") return false;
  return sessionStorage.getItem(PASSWORD_RECOVERY_PENDING_KEY) === "1";
}

export function clearPasswordRecoveryPending() {
  if (typeof window === "undefined") return;
  sessionStorage.removeItem(PASSWORD_RECOVERY_PENDING_KEY);
}
