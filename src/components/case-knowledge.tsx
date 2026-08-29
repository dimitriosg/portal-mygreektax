import { useCallback, useEffect, useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { formatDate } from "@/lib/utils";
import { knowledgeIdsFromContext, type DraftVersionRow } from "@/lib/case-draft-versions";

// The Knowledge tab: the knowledge_base entries behind the current draft.
//
// The intent is to show exactly which entries a draft used. The data does not
// support that yet: case_draft_versions.context_used is an empty object on
// every row, because rows are inserted by the record_case_draft_version()
// trigger, which copies the draft text and the insights and nothing else. So
// this reads context_used first and, when it names entries, shows those; when
// it names none, it says so and falls back to the entries the Brain is
// eligible to inject, which is a statement about the knowledge base rather
// than about this draft. The distinction is on screen, because "these are the
// entries that backed this reply" and "these are the entries that exist" are
// very different claims to make to someone about to send tax advice.
//
// Read only in this change. Editing entries stays in the knowledge base tools.

interface KnowledgeRow {
  id: string;
  title: string;
  category: string | null;
  status: string;
  review_by: string | null;
}

interface Props {
  /** The version whose context_used is inspected. Null when no draft exists. */
  currentVersion: DraftVersionRow | null;
}

const SELECT = "id, title, category, status, review_by";

// Mirrors the Brain's own knowledge query (brain-mygreektax src/index.js:541,
// status canonical, is_active, visibility client_safe, newest first, capped at
// KB_MAX_ENTRIES) so the fallback list is exactly the set a draft would be
// given, not merely everything in the table. Draft-status entries are excluded
// there, which is why 11 of the 13 rows reach a prompt.
const KB_MAX_ENTRIES = 25;

function isPastReview(row: KnowledgeRow, todayIso: string): boolean {
  return !!row.review_by && row.review_by < todayIso;
}

export function CaseKnowledge({ currentVersion }: Props) {
  const [eligible, setEligible] = useState<KnowledgeRow[]>([]);
  const [recorded, setRecorded] = useState<KnowledgeRow[]>([]);
  const [recordedLoading, setRecordedLoading] = useState(false);
  const [recordedError, setRecordedError] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const recordedIds = useMemo(
    () => knowledgeIdsFromContext(currentVersion?.context_used ?? null),
    [currentVersion],
  );
  // Stable across re-renders so the effect below does not re-run on identity
  // alone; the ids themselves are what matter.
  const recordedKey = recordedIds.join(",");

  const load = useCallback(async () => {
    const { data, error: err } = await supabase
      .from("knowledge_base")
      .select(SELECT)
      .eq("status", "canonical")
      .eq("is_active", true)
      .eq("visibility", "client_safe")
      .order("updated_at", { ascending: false })
      .limit(KB_MAX_ENTRIES);

    if (err) {
      setError(`Could not load the knowledge base: ${err.message}`);
      setEligible([]);
    } else {
      setError("");
      setEligible((data as KnowledgeRow[] | null) ?? []);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // A recorded entry is shown whatever its status today: what a draft actually
  // drew on does not stop being true because the entry was later retired.
  useEffect(() => {
    const ids = recordedKey ? recordedKey.split(",") : [];
    if (ids.length === 0) {
      setRecorded([]);
      setRecordedLoading(false);
      setRecordedError("");
      return;
    }
    let cancelled = false;
    // Clear first. showing selects recorded as soon as the new version records
    // ids, so leaving the previous version's rows in place would label them,
    // and their overdue warnings, as the sources of this draft for as long as
    // the fetch takes.
    setRecorded([]);
    setRecordedError("");
    setRecordedLoading(true);
    (async () => {
      const { data, error: err } = await supabase
        .from("knowledge_base")
        .select(SELECT)
        .in("id", ids);
      if (cancelled) return;
      setRecordedError(err ? `Could not load the recorded entries: ${err.message}` : "");
      setRecorded((data as KnowledgeRow[] | null) ?? []);
      setRecordedLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [recordedKey]);

  // A fallback is decided by whether the draft recorded anything, never by
  // whether those rows came back. If a draft names entries that have since
  // been deleted, or their fetch is still in flight or failed, showing the
  // eligible list under the words "did not record which entries it used"
  // would contradict the draft's own record to someone reviewing tax advice.
  const isFallback = recordedIds.length === 0;
  const showing = isFallback ? eligible : recorded;
  const missingCount = isFallback ? 0 : recordedIds.length - recorded.length;

  // Compared in Athens terms like every other date on this page: review_by is
  // a plain date, so a string compare against today's Athens date is right.
  const todayIso = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Athens",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());

  const stale = showing.filter((r) => isPastReview(r, todayIso));

  return (
    <>
      {loading && <p className="empty">Loading knowledge entries...</p>}
      {error && (
        <p className="text-sm text-red-600 border border-red-200 bg-red-50 rounded px-3 py-2">
          {error}
        </p>
      )}

      {!loading && !error && (
        <>
          {/* Deliberately not "no draft on this case": two cases hold a draft
              that predates the version trigger and so have no version row for
              this tab to read. What is true either way is that no version
              records its sources. */}
          {!currentVersion && (
            <p className="stamp">
              No recorded draft version on this case. These are the entries the Brain is eligible to
              inject when one is generated.
            </p>
          )}

          {currentVersion && isFallback && (
            <p className="stamp">
              Draft v{currentVersion.version_no} did not record which entries it used, so these are
              the entries the Brain is eligible to inject, not a record of this draft. Nothing
              populates that record yet.
            </p>
          )}

          {currentVersion && !isFallback && (
            <p className="stamp">
              {recordedIds.length} entr{recordedIds.length === 1 ? "y" : "ies"} recorded as used by
              draft v{currentVersion.version_no}.
              {missingCount > 0 && !recordedLoading && !recordedError
                ? ` ${missingCount} of them ${
                    missingCount === 1 ? "is" : "are"
                  } no longer in the knowledge base.`
                : ""}
            </p>
          )}

          {recordedLoading && <p className="empty">Loading the recorded entries...</p>}
          {recordedError && (
            <p className="text-sm text-red-600 border border-red-200 bg-red-50 rounded px-3 py-2">
              {recordedError}
            </p>
          )}

          {stale.length > 0 && (
            <div className="callout">
              <span>
                {stale.length} entr{stale.length === 1 ? "y is" : "ies are"} past the review date.
                Confirm with the partner before quoting {stale.length === 1 ? "it" : "them"} to a
                client.
              </span>
            </div>
          )}

          {showing.length === 0 && !recordedLoading && (
            <p className="empty">
              {isFallback
                ? "No knowledge entries to show."
                : "None of the recorded entries are still in the knowledge base."}
            </p>
          )}

          {showing.length > 0 && (
            <div className="kb-list">
              {showing.map((r) => {
                const past = isPastReview(r, todayIso);
                return (
                  <div className="kb-row" key={r.id}>
                    <div className="kb-title">{r.title}</div>
                    <div className="kb-meta">
                      {r.category && <span className="kb-cat">{r.category}</span>}
                      {r.status !== "canonical" && (
                        <span className="badge-super">{r.status.toUpperCase()}</span>
                      )}
                      {r.review_by && (
                        <span className={past ? "due-over" : "stamp"}>
                          {past ? "review overdue " : "review by "}
                          {formatDate(r.review_by)}
                        </span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}
    </>
  );
}
