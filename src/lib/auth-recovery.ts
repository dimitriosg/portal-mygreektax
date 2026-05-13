export const MIN_PASSWORD_LENGTH = 12;

export const GENERIC_RECOVERY_SUCCESS_MESSAGE =
  "If this email is authorized, you will receive an access link shortly.";

export function getRecoveryRedirectUrl() {
  if (typeof window === "undefined") return undefined;
  return `${window.location.origin}/login?mode=recovery`;
}
