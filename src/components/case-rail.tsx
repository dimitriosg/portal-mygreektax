import { formatDate } from "@/lib/utils";
import { athensDayKey } from "@/lib/case-thread";
import { isOverdueEligibleStatus } from "@/lib/airtable-shared";
import type { CaseRailData } from "@/lib/case-workspace.functions";

// Left rail of the case workspace: who the client is, the money position, and
// the open items. Read only. Everything here comes from rows that already
// exist (clients, payments, jobs); fields the schema does not hold yet are
// simply absent rather than faked.

export interface RailClient {
  full_name: string | null;
  email: string | null;
  client_code: string | null;
  nationality: string | null;
  afm: string | null;
  taxisnet_access: boolean | null;
  quote_amount: number | null;
  deposit: number | null;
  balance_due: number | null;
}

interface Props {
  client: RailClient | null;
  rail: CaseRailData | null;
  railError: string;
  loading: boolean;
}

function euro(value: number | null, currency = "EUR"): string {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return "—";
  return new Intl.NumberFormat("en-GB", { style: "currency", currency }).format(Number(value));
}

// sla_deadline is a plain date; a deadline is past once the Athens calendar
// has moved beyond it, regardless of the viewer's timezone. Due today is not
// yet overdue.
function isPastDue(iso: string | null): boolean {
  if (!iso) return false;
  const today = athensDayKey(new Date().toISOString());
  return !!today && iso < today;
}

// An actionable next action; completing a job auto-writes the literal "None".
function actionLabel(value: string | null): string | null {
  return value && value !== "None" ? value : null;
}

export function CaseRail({ client, rail, railError, loading }: Props) {
  const payments = rail?.payments ?? [];
  const jobs = rail?.jobs ?? [];
  // Finished jobs keep their sla_deadline and get next_action_needed "None"
  // written at completion, so both the status gate and the "None" check are
  // load-bearing here; without them every completed job reads as open and
  // overdue forever.
  const openJobs = jobs.filter(
    (j) =>
      isOverdueEligibleStatus(j.status) && (actionLabel(j.next_action_needed) || j.sla_deadline),
  );

  return (
    <>
      <section className="card">
        <div className="card-head">
          <h2>Client profile</h2>
        </div>
        <div className="card-body">
          {loading && <p className="empty">Loading...</p>}
          {!loading && !client && (
            <p className="empty">No client record linked to this case yet.</p>
          )}
          {!loading && client && (
            <div className="kv-list">
              <div className="kv">
                <span className="k">Nationality</span>
                <span className="v">{client.nationality || "not on record"}</span>
              </div>
              <div className="kv">
                <span className="k">AFM</span>
                <span className="v">{client.afm || "not on record"}</span>
              </div>
              <div className="kv">
                <span className="k">TAXISnet</span>
                <span className="v">
                  {client.taxisnet_access === null
                    ? "not on record"
                    : client.taxisnet_access
                      ? "active"
                      : "no access"}
                </span>
              </div>
              <div className="kv">
                <span className="k">Client code</span>
                <span className="v">{client.client_code || "not on record"}</span>
              </div>
            </div>
          )}
        </div>
      </section>

      <section className="card">
        <div className="card-head">
          <h2>Money</h2>
        </div>
        <div className="card-body">
          {loading && <p className="empty">Loading...</p>}
          {!loading && !client && <p className="empty">Nothing to show without a client record.</p>}
          {!loading && client && (
            <>
              <div className="kv-list">
                <div className="kv">
                  <span className="k">Quote</span>
                  <span className="v">{euro(client.quote_amount)}</span>
                </div>
                <div className="kv">
                  <span className="k">Deposit paid</span>
                  <span className="v">{euro(client.deposit)}</span>
                </div>
                <div className="kv">
                  <span className="k">Balance due</span>
                  <span className={`v ${Number(client.balance_due) > 0 ? "due-over" : ""}`}>
                    {euro(client.balance_due)}
                  </span>
                </div>
              </div>

              <div className="rail-div" />

              {railError && <p className="empty">{railError}</p>}
              {!railError && payments.length === 0 && (
                <p className="empty">No payments recorded for this client.</p>
              )}
              {!railError && payments.length > 0 && (
                <div className="kv-list">
                  {payments.map((p) => (
                    <div className="kv" key={p.id} title={p.payer_reference ?? undefined}>
                      <span className="k">
                        {formatDate(p.received_at)}
                        {p.status !== "confirmed" ? ` (${p.status})` : ""}
                      </span>
                      <span className="v">{euro(p.amount, p.currency)}</span>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      </section>

      <section className="card">
        <div className="card-head">
          <h2>Open items</h2>
          {openJobs.length > 0 && <span className="count">{openJobs.length}</span>}
        </div>
        <div className="card-body">
          {loading && <p className="empty">Loading...</p>}
          {!loading && railError && <p className="empty">{railError}</p>}
          {!loading && !railError && openJobs.length === 0 && (
            <p className="empty">No open items on this case's jobs.</p>
          )}
          {!loading && !railError && openJobs.length > 0 && (
            <ul className="rail-items">
              {openJobs.map((j) => (
                <li key={j.id}>
                  <span>{actionLabel(j.next_action_needed) || j.status || "Job in progress"}</span>
                  <span className={`stamp ${isPastDue(j.sla_deadline) ? "due-over" : ""}`}>
                    {j.job_code ? `${j.job_code} ` : ""}
                    {j.sla_deadline ? `due ${formatDate(j.sla_deadline)}` : ""}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>
    </>
  );
}
