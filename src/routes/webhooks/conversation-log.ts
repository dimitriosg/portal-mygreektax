import { createFileRoute } from "@tanstack/react-router";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Lazy, request-time client creation. Nothing touches the database or the
// environment at module load, so a missing variable can never crash the
// whole route module again. A misconfiguration returns a readable JSON
// error to Make instead of an HTML error page.
let cachedClient: SupabaseClient | undefined;

function getSupabase(): { client: SupabaseClient } | { configError: string } {
  if (cachedClient) return { client: cachedClient };

  const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !key) {
    const missing = [
      ...(!url ? ["SUPABASE_URL (or VITE_SUPABASE_URL)"] : []),
      ...(!key ? ["SUPABASE_SERVICE_ROLE_KEY"] : []),
    ];
    return {
      configError: `Missing environment variable(s): ${missing.join(", ")}. Set SUPABASE_URL in wrangler.jsonc vars and SUPABASE_SERVICE_ROLE_KEY as a Secret in the Cloudflare dashboard, then redeploy.`,
    };
  }

  cachedClient = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return { client: cachedClient };
}

function readString(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.slice(0, maxLength);
}

// Length-independent comparison. These secrets are high-entropy and this is
// over the network, so a timing attack is not realistic, but not leaking a
// comparison costs five lines.
function secretsMatch(provided: string, expected: string): boolean {
  if (provided.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < provided.length; i++) {
    diff |= provided.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return diff === 0;
}

// Turn whatever Make sends for sent_at into an ISO timestamp. Falls back to
// null (endpoint then uses the DB default of now()) if it is unparseable.
function parseSentAt(value: unknown): string | undefined {
  const raw = readString(value, 40);
  if (!raw) return undefined;
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return undefined;
  return d.toISOString();
}

export const Route = createFileRoute("/webhooks/conversation-log")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        // Shared secret, MANDATORY.
        //
        // This guard used to read `if (expectedSecret)`, enforced only when the
        // secret happened to be set, so the file could ship first and the
        // secret be added to Cloudflare and Make afterwards. The secret was
        // never added. The route then spent months accepting unauthenticated
        // POSTs and writing them into the case spine that both the portal and
        // the Brain read, which means anyone who found the path could inject
        // fabricated client correspondence.
        //
        // The deploy-first-secure-later pattern is not the problem on its own.
        // The problem is that it leaves no trace when the second half never
        // happens: everything keeps working, so nothing prompts anyone. The
        // identical guard on /webhooks/mailgun-events failed the same way and
        // was found the same day. Fail closed instead, so a missing secret is
        // loud and immediate rather than silent and indefinite.
        // DUAL-ACCEPT, TEMPORARY. Two headers are accepted:
        //
        //   x-mgt-webhook-secret   checked against MGT_WEBHOOK_SECRET   (target)
        //   x-lead-intake-secret   checked against LEAD_INTAKE_SECRET   (legacy)
        //
        // WHY: a sweep of the Make blueprints found SEVEN scenarios posting
        // here, not one, and none of them send x-mgt-webhook-secret. Six send
        // x-lead-intake-secret, which this route has been receiving and
        // ignoring the whole time it was unauthenticated. Requiring only the
        // target header would 401 all seven at once and take conversation
        // capture down until every module had been edited.
        //
        // Accepting the header they already send closes the hole immediately at
        // the cost of one secret temporarily authenticating two routes. That is
        // weaker than distinct secrets per route and is not the end state, but
        // it is enormously better than no authentication, which is what this
        // route had.
        //
        // REMOVE THE LEGACY BRANCH once the Make modules send the target
        // header. The log line below names which path authenticated, so
        // migration progress is visible rather than guessed at: when
        // "lead-intake-legacy" stops appearing, this block can go.
        //
        // The caller to watch is scenario 6289179, the one module whose header
        // could not be read from the blueprint because it uses keychain 206586.
        // The keychain is inferred to emit x-lead-intake-secret, since the same
        // keychain authenticates /webhooks/lead-intake successfully, but that is
        // an inference. If 6289179's error count jumps after this deploys, the
        // inference was wrong for it and it needs its header set explicitly.
        const mgtSecret = process.env.MGT_WEBHOOK_SECRET;
        const leadSecret = process.env.LEAD_INTAKE_SECRET;

        if (!mgtSecret && !leadSecret) {
          console.error(
            "[conversation-log] neither MGT_WEBHOOK_SECRET nor LEAD_INTAKE_SECRET configured",
          );
          return Response.json({ error: "Server configuration error" }, { status: 500 });
        }

        const mgtProvided = request.headers.get("x-mgt-webhook-secret");
        const leadProvided = request.headers.get("x-lead-intake-secret");

        let authenticatedVia: "mgt" | "lead-intake-legacy" | null = null;
        if (mgtSecret && mgtProvided && secretsMatch(mgtProvided, mgtSecret)) {
          authenticatedVia = "mgt";
        } else if (leadSecret && leadProvided && secretsMatch(leadProvided, leadSecret)) {
          authenticatedVia = "lead-intake-legacy";
        }

        if (!authenticatedVia) {
          console.error("[conversation-log] rejected: missing or invalid shared secret");
          return Response.json({ error: "Unauthorized" }, { status: 401 });
        }
        console.log("[conversation-log] authenticated", { via: authenticatedVia });

        let body: unknown;
        try {
          body = await request.json();
        } catch {
          return Response.json({ error: "Invalid JSON body" }, { status: 400 });
        }
        if (typeof body !== "object" || body === null) {
          return Response.json({ error: "Invalid JSON body" }, { status: 400 });
        }
        const b = body as Record<string, unknown>;

        const email = readString(b.email, 200);
        const direction = readString(b.direction, 20);
        const caseSerialId = readString(b.case_serial_id, 100);
        const textContent = readString(b.text_content, 100000);
        const subject = readString(b.subject, 500);
        const sentAt = parseSentAt(b.sent_at);
        const sourceMessageId = readString(b.source_message_id, 200);

        // Which side of the case this message belongs to. Absent means customer,
        // so the existing client sync keeps working untouched.
        const party = (readString(b.party, 20) ?? "customer").toLowerCase();
        const isPartner = party === "partner";

        if (!email || !EMAIL_PATTERN.test(email)) {
          return Response.json({ error: "Valid email is required" }, { status: 400 });
        }

        const supabaseResult = getSupabase();
        if ("configError" in supabaseResult) {
          console.error("[conversation-log] configuration error:", supabaseResult.configError);
          return Response.json(
            { error: "Server misconfigured", detail: supabaseResult.configError },
            { status: 500 },
          );
        }
        const supabase = supabaseResult.client;

        try {
          const isOutbound = (direction ?? "").toLowerCase() === "outbound";
          const isInternal = (direction ?? "").toLowerCase() === "internal";

          // 1. Resolve the conversation this event belongs to. The serial is the
          //    authority (it comes straight from the case), so try it first via
          //    brain_conversations. Everything writes to brain_events, the live
          //    spine the portal and the Brain both read.
          //
          //    For partner mail the serial is the ONLY acceptable route. The
          //    email fallback matches an address against customer_email, which
          //    for a partner address is meaningless at best and wrong at worst.
          //    A partner message with no resolvable serial is reported back as
          //    unassigned rather than guessed at.
          let conversationId: string | undefined;

          if (caseSerialId) {
            const { data: convRows, error: convError } = await supabase
              .from("brain_conversations")
              .select("id")
              .eq("case_serial_id", caseSerialId)
              .limit(1);
            if (convError) {
              throw new Error(`conversation lookup by serial failed: ${convError.message}`);
            }
            conversationId = convRows?.[0]?.id;
          }

          if (!conversationId && !isPartner) {
            const { data: convRows, error: convError } = await supabase
              .from("brain_conversations")
              .select("id")
              .ilike("customer_email", email)
              .order("created_at", { ascending: false })
              .limit(1);
            if (convError) {
              throw new Error(`conversation lookup by email failed: ${convError.message}`);
            }
            conversationId = convRows?.[0]?.id;
          }

          if (!conversationId) {
            // Nothing to attach to: 200 so the Make scenario does not error.
            return Response.json({
              found: false,
              party,
              reason: isPartner ? "unassigned: no case code on this partner message" : undefined,
            });
          }

          // 2. Dedupe. A provider message id (Gmail/Mailgun) keeps re-syncs of an
          //    overlapping window from double-logging. The unique key on
          //    brain_events.external_event_id is the real guard; this is a cheap
          //    pre-check so a duplicate returns cleanly instead of throwing.
          const externalEventId = sourceMessageId
            ? `mg:${sourceMessageId}`
            : `${isOutbound ? "outbound" : isInternal ? "internal" : "inbound"}:${email}:${Date.now()}`;

          if (sourceMessageId) {
            const { data: dupes, error: dupeError } = await supabase
              .from("brain_events")
              .select("id")
              .eq("external_event_id", externalEventId)
              .limit(1);
            if (dupeError) {
              throw new Error(`dedupe lookup failed: ${dupeError.message}`);
            }
            if (dupes && dupes.length > 0) {
              return Response.json({ found: true, conversationId, duplicate: true });
            }
          }

          // 3. Write the event into brain_events with constraint-valid values.
          //    actor is one of customer/partner/dimitris/system; direction is
          //    inbound/outbound/internal; event_type is from the fixed enum.
          //
          //    Partner mail gets partner_email_received / partner_email_sent and
          //    actor "partner" on the inbound side. The case page reads those
          //    two markers to decide which pane a message belongs in, so getting
          //    this wrong puts partner correspondence in front of the client.
          if (textContent) {
            const row: Record<string, unknown> = isPartner
              ? {
                  conversation_id: conversationId,
                  external_event_id: externalEventId,
                  event_type: isOutbound ? "partner_email_sent" : "partner_email_received",
                  actor: isOutbound ? "dimitris" : "partner",
                  direction: isOutbound ? "outbound" : "inbound",
                  from_email: isOutbound ? "hello@mygreektax.eu" : email,
                  to_emails: isOutbound ? [email] : [],
                  subject: subject ?? null,
                  body_text: textContent,
                }
              : {
                  conversation_id: conversationId,
                  external_event_id: externalEventId,
                  event_type: isOutbound
                    ? "customer_email_sent"
                    : isInternal
                      ? "internal_note"
                      : "customer_email_received",
                  actor: isOutbound || isInternal ? "dimitris" : "customer",
                  direction: isOutbound ? "outbound" : isInternal ? "internal" : "inbound",
                  from_email: isOutbound || isInternal ? "hello@mygreektax.eu" : email,
                  to_emails: isOutbound ? [email] : [],
                  subject: subject ?? null,
                  body_text: textContent,
                };

            // Backfilled messages must land at their real send time, not now(),
            // or the case history reads out of order.
            if (sentAt) row.occurred_at = sentAt;

            const { error: eventError } = await supabase.from("brain_events").insert(row);

            if (eventError) {
              console.error("[conversation-log] brain_events insert failed:", eventError);
              throw new Error(`event insert failed: ${eventError.message}`);
            }
            console.log(
              `[conversation-log] logged ${party} ${direction ?? "event"} for conversation ${conversationId}`,
            );
          }

          // 4. Best-effort activity stamp on the client row. Never fail the whole
          //    request over this: the event is already logged, which is the point.
          //    Skipped for partner mail: the address belongs to the accountant,
          //    not a client, and stamping on it would be meaningless.
          let clientId: string | null = null;
          if (!isPartner) {
            const { data: clientRows } = await supabase
              .from("clients")
              .select("id")
              .ilike("email", email)
              .limit(1);
            clientId = clientRows?.[0]?.id ?? null;
            if (clientId) {
              await supabase
                .from("clients")
                .update({ last_activity: new Date().toISOString() })
                .eq("id", clientId);
            }
          }

          return Response.json({
            found: true,
            conversationId,
            clientId,
            party,
            direction: direction ?? null,
          });
        } catch (error) {
          console.error("[conversation-log] failed processing event", { error });
          return Response.json(
            {
              error: "Failed to process conversation log",
              detail: error instanceof Error ? error.message : String(error),
            },
            { status: 500 },
          );
        }
      },
    },
  },
});
