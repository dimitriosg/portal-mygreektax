import {
  AuthSessionError,
  InvalidSupabaseSessionTokenError,
} from "@/integrations/supabase/auth-client-middleware";

export function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error instanceof Response) {
    return `${error.status}${error.statusText ? ` ${error.statusText}` : ""}`.trim();
  }
  if (
    error &&
    typeof error === "object" &&
    "message" in error &&
    typeof error.message === "string"
  ) {
    return error.message;
  }
  if (typeof error === "string") return error;
  return "Something went wrong";
}

export function isAuthSessionError(error: unknown): boolean {
  if (!error) return false;
  if (error instanceof AuthSessionError) return true;
  if (error instanceof InvalidSupabaseSessionTokenError) return true;
  if (error instanceof Response) return error.status === 401;
  return (
    typeof error === "object" &&
    "code" in error &&
    (error.code === "NO_ACTIVE_SESSION" || error.code === "INVALID_SESSION_TOKEN")
  );
}
