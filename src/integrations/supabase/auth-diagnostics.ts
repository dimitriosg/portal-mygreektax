export type SupabaseTokenPrefixType = "eyJ" | "sb_" | "other" | "missing";

export type SupabaseTokenDiagnostics = {
  exists: boolean;
  length: number;
  hasThreeSegments: boolean;
  prefixType: SupabaseTokenPrefixType;
  headerValue: string;
  isLikelyJwt: boolean;
};

export function getSupabaseProjectHost(value: string | undefined) {
  if (!value) return null;

  try {
    return new URL(value).host;
  } catch (error) {
    console.error("[supabase-auth] invalid Supabase URL", {
      hasSupabaseUrl: true,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

export function describeSupabaseToken(token: string | null | undefined): SupabaseTokenDiagnostics {
  const normalizedToken = typeof token === "string" ? token.trim() : "";
  const exists = normalizedToken.length > 0;
  const length = normalizedToken.length;
  const hasThreeSegments = exists && normalizedToken.split(".").length === 3;
  const prefixType: SupabaseTokenPrefixType = !exists
    ? "missing"
    : normalizedToken.startsWith("eyJ")
      ? "eyJ"
      : normalizedToken.startsWith("sb_")
        ? "sb_"
        : "other";

  const isLikelyJwt = exists && hasThreeSegments && prefixType !== "sb_";
  const headerValue = !exists
    ? "missing"
    : prefixType === "sb_"
      ? "sb_prefix"
      : hasThreeSegments
        ? "jwt_3_segment"
        : prefixType === "eyJ"
          ? "jwt_bad_segments"
          : "other";

  return {
    exists,
    length,
    hasThreeSegments,
    prefixType,
    headerValue,
    isLikelyJwt,
  };
}
