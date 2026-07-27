// Ambient declaration for the Cloudflare Workers runtime module.
//
// `cloudflare:workers` is a virtual module provided by the Workers runtime (and
// resolved by the Cloudflare Vite plugin at build time), so `tsc` has no way to
// find it on its own. Declaring the small surface we import keeps typecheck
// green without affecting the actual build, which resolves the real module.
declare module "cloudflare:workers" {
  /** Extend the lifetime of the current invocation until `promise` settles. */
  export function waitUntil(promise: Promise<unknown>): void;
}
