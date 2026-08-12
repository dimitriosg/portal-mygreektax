// -----------------------------------------------------------------------------
// Turn a failed Mailgun send into an honest HTTP status.
//
// WHY THIS EXISTS. Every send route used to answer a Mailgun failure the same
// way, whatever the failure was:
//
//     return Response.json({ error: "Send failed", detail: mgText }, { status: 502 });
//
// On 12/08/2026 the Worker's MAILGUN_API_KEY stopped being accepted. Mailgun
// answered 401 with the body "Forbidden". The route turned that into 502 Bad
// Gateway and passed "Forbidden" through to the desk, so the portal reported a
// gateway fault and the word Forbidden for what was actually our own expired
// credential. Two people spent an afternoon reading it as an authentication
// rejection of the CALLER, and as a crash, because both are what those words
// normally mean. The send had been failing since 27/07 and nobody knew.
//
// A wrong status is not cosmetic. It aims the person reading it at the wrong
// system: 502 says "the thing upstream is broken", when the thing that was
// broken was a secret on this Worker.
//
// THE RULE HERE. Who needs to act determines the status:
//
//   Mailgun 401/403  -> 500. Our credential is wrong. Nothing about the request
//                       or the caller is at fault, and no retry will help. It
//                       is a server misconfiguration, which is what 5xx means.
//                       NOT 502: nothing upstream is down, it is refusing us.
//                       NOT passed through as 401/403 either -- these routes
//                       already return 401 and 403 for the caller's own session
//                       and role, and reusing them here would recreate exactly
//                       the ambiguity this file removes.
//   Mailgun 429      -> 503, with Retry-After when Mailgun supplies one. Real,
//                       temporary, and retrying is the correct response.
//   Mailgun 4xx      -> 400. Mailgun rejected the message itself, usually a
//                       malformed address. The caller can fix it, so they get
//                       Mailgun's own words.
//   Mailgun 5xx      -> 502. Mailgun is genuinely broken. This is the only case
//                       where "Bad Gateway" is true.
//
// WHAT REACHES THE BROWSER. For a credential failure the caller gets our
// sentence, not Mailgun's. "Forbidden" told the operator nothing and misled
// them; naming the variable to fix tells them everything. Mailgun's raw body is
// echoed only where it is genuinely about their message, and it is logged in
// every case.
// -----------------------------------------------------------------------------

const MAX_DETAIL = 500;

/** Bound an upstream body before it goes in a log line or a JSON response. */
function trim(body: string): string {
  const t = body.trim();
  return t.length > MAX_DETAIL ? `${t.slice(0, MAX_DETAIL)}...` : t;
}

/**
 * Sanitise Mailgun's Retry-After before echoing it.
 *
 * The value is upstream input, and it is going into a response header. A stray
 * newline or control character in there throws while constructing the Response,
 * which would turn a rate-limit into an unhandled exception raised by the error
 * handler itself -- the same shape of fault this whole file exists to remove.
 *
 * Retry-After is either delay-seconds or an HTTP-date. Only the numeric form is
 * accepted: it is what Mailgun sends, and anything else is dropped rather than
 * guessed at, since omitting the header is harmless and a bad one is not.
 */
function safeRetryAfter(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  const t = value.trim();
  return /^\d{1,6}$/.test(t) ? t : undefined;
}

/**
 * Build the response for a non-OK Mailgun reply, and log it.
 *
 * `route` is the log prefix, e.g. "send-approved". `retryAfter` is Mailgun's
 * Retry-After header when present.
 */
export function mailgunFailureResponse(
  route: string,
  status: number,
  body: string,
  retryAfter?: string | null,
): Response {
  // One log line, always, carrying the upstream status. The status was
  // previously only visible here and was the single most useful fact.
  console.error(`[${route}] mailgun send failed`, { upstreamStatus: status, body: trim(body) });

  if (status === 401 || status === 403) {
    return Response.json(
      {
        error: "Email provider rejected our credentials",
        detail:
          `Mailgun returned ${status}. The MAILGUN_API_KEY secret on this Worker is missing, ` +
          "expired, or belongs to a different Mailgun account than MAILGUN_DOMAIN. The message " +
          "was NOT sent and was not queued. Retrying will not help until the secret is replaced.",
        upstreamStatus: status,
      },
      { status: 500 },
    );
  }

  if (status === 429) {
    const retry = safeRetryAfter(retryAfter);
    return Response.json(
      {
        error: "Email provider is rate limiting us",
        detail: "Mailgun returned 429. The message was not sent. Try again shortly.",
        upstreamStatus: status,
      },
      { status: 503, headers: retry ? { "Retry-After": retry } : undefined },
    );
  }

  // 404 is OURS, not the caller's. This endpoint is
  // /v3/<MAILGUN_DOMAIN>/messages, so a 404 means Mailgun has no such domain:
  // MAILGUN_DOMAIN is wrong, not verified in this account, or the request went
  // to the wrong regional API. None of that is anything the sender can fix by
  // editing their message, so grouping it with the 4xx below would repeat the
  // exact mistake this file corrects -- pointing the reader at the wrong system.
  //
  // Worth its own branch because it is a live possibility rather than a
  // hypothetical: a key that is valid for one account against a domain owned by
  // another fails around here, and that is one of the candidate explanations
  // for the outage on 12/08/2026.
  if (status === 404) {
    return Response.json(
      {
        error: "Email provider does not recognise our sending domain",
        detail:
          "Mailgun returned 404 for this domain. MAILGUN_DOMAIN on this Worker is wrong, is not " +
          "verified in the Mailgun account that MAILGUN_API_KEY belongs to, or the request went " +
          "to the wrong regional API. The message was NOT sent. Retrying will not help.",
        upstreamStatus: status,
      },
      { status: 500 },
    );
  }

  if (status >= 500) {
    return Response.json(
      {
        error: "Email provider is unavailable",
        detail: `Mailgun returned ${status}. The message was not sent. This is upstream, not us.`,
        upstreamStatus: status,
      },
      { status: 502 },
    );
  }

  // Remaining 4xx: Mailgun rejected the message itself. Their wording is the
  // useful part here, so it is passed through.
  return Response.json(
    {
      error: "Mailgun rejected the message",
      detail: trim(body) || `Mailgun returned ${status}.`,
      upstreamStatus: status,
    },
    { status: 400 },
  );
}
