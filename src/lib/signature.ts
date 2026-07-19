// The MyGreekTax email signature, defined once. The review desk pre-loads
// this into the signature editor on every draft. Editing the signature there
// affects only that one email; the default always comes from here.
//
// When the hello@ vs jim@ split arrives, add more entries and pick by sender.
// For now there is a single default.
//
// This HTML must stay in sync with what the email should look like. It is the
// SINGLE source of truth for the signature; Make no longer appends one.

export const SIGNATURE_HTML = `<p>Με εκτίμηση,</p>
<p><strong>MyGreekTax Team</strong><br>
<span style="color: #6b7280;">Greek tax &amp; admin, in English</span><br>
<span style="color: #6b7280;"><a href="mailto:hello@mygreektax.eu" style="color: #6b7280;">hello@mygreektax.eu</a> &middot; <a href="https://mygreektax.eu" style="color: #6b7280;">mygreektax.eu</a></span></p>
<p><a href="https://g.page/r/CemUQExx34X1EAE/review" style="color: #C9923A; font-weight: bold; text-decoration: none;">&gt;&gt; Review Us on Google &lt;&lt;</a></p>
<p><em><span style="color: #9ca3af;">All regulated filings handled by a licensed member of the Economic Chamber of Greece (OEE).</span></em></p>`;

// Convenience for a future per-sender lookup. Unused for now.
export function getSignatureHtml(_sender?: string): string {
  return SIGNATURE_HTML;
}
