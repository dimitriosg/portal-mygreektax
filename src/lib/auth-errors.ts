export function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error instanceof Response) {
    return `${error.status}${error.statusText ? ` ${error.statusText}` : ""}`.trim();
  }
  if (typeof error === "string") return error;
  return "Something went wrong";
}

export function isAuthSessionError(error: unknown): boolean {
  if (!error) return false;
  if (error instanceof Response) return error.status === 401;

  const message = getErrorMessage(error).toLowerCase();
  return (
    message.includes("no active session") ||
    message.includes("unauthorized") ||
    message.includes("401")
  );
}
