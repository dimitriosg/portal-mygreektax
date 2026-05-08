## Why verification is failing

Plausible verifies installation by fetching the HTML of `portal.mygreektax.eu` and searching for a `<script src="…plausible.io…">` tag inside `<head>`.

The current loader in `src/routes/__root.tsx` (line 117) is an IIFE that:
1. Checks `window.location.hostname` at runtime, then
2. Calls `document.createElement("script")` to inject the real tag.

Both steps require JavaScript execution. The verifier sees only the inline IIFE source, never a `plausible.io` script URL — so it reports "We couldn't detect Plausible on your site".

## Fix

Replace the dynamic loader with a **static** `<script>` entry in `head().scripts` so SSR emits it directly into `<head>` of the rendered HTML. Plausible's bundled script already ignores `localhost` and unknown domains by default, so the host-gating IIFE is unnecessary.

### Change in `src/routes/__root.tsx`

Replace the current `scripts: [...]` block inside `head()` with:

```ts
scripts: [
  {
    src: "https://plausible.io/js/pa-jHCy-4-ii1HrtB2pU_pbx.js",
    defer: true,
    "data-domain": "portal.mygreektax.eu",
  },
  {
    children:
      'window.plausible=window.plausible||function(){(window.plausible.q=window.plausible.q||[]).push(arguments)}',
  },
],
```

- The first entry renders `<script defer src="…pa-jHCy-…js" data-domain="portal.mygreektax.eu">` directly in `<head>` — what the verifier looks for.
- The second entry installs the queue shim so `plausible(...)` calls from `@/lib/analytics` never throw before the script loads (and on preview/localhost where the script no-ops).

### Preview / localhost behavior

Plausible's script automatically refuses to send events from hostnames that don't match `data-domain` (and from `localhost`), so no host gating is needed. Calls from the app become no-ops on `*.lovable.app` and `localhost`.

### Verification steps

1. After deploy, view source of `https://portal.mygreektax.eu/` and confirm the `<script src="…plausible.io/js/pa-jHCy-4-ii1HrtB2pU_pbx.js" data-domain="portal.mygreektax.eu">` tag is present inside `<head>`.
2. Click "Verify installation again" in Plausible — it should succeed.
3. Confirm preview (`*.lovable.app`) still loads without console errors and that `plausible(...)` calls don't throw.
