const PRODUCTION_PORTAL_ORIGIN = "https://portal.mygreektax.eu";

function isLocalHost(hostname: string) {
  return hostname === "localhost" || hostname === "127.0.0.1";
}

function isLovablePreviewHost(hostname: string) {
  return hostname === "lovable.app" || hostname.endsWith(".lovable.app");
}

export function getTrackingPortalOrigin() {
  if (typeof window === "undefined") return PRODUCTION_PORTAL_ORIGIN;

  const { hostname, origin } = window.location;
  const normalizedHostname = hostname.toLowerCase();

  if (isLocalHost(normalizedHostname) || isLovablePreviewHost(normalizedHostname)) {
    return origin;
  }

  if (
    normalizedHostname === "portal.mygreektax.eu" ||
    normalizedHostname === "www.portal.mygreektax.eu" ||
    normalizedHostname.endsWith(".workers.dev")
  ) {
    return PRODUCTION_PORTAL_ORIGIN;
  }

  return origin;
}

export function buildTrackingLink(token: string) {
  return `${getTrackingPortalOrigin()}/track/${token}`;
}
