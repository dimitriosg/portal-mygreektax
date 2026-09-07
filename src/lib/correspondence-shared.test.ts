import { describe, expect, it } from "vitest";
import {
  CLOSED_CORRESPONDENCE_STAGES,
  OPEN_CORRESPONDENCE_STAGES,
  PARTNER_STALE_WORKING_DAYS,
  compareRows,
  defaultDirFor,
  filterMessages,
  groupByStage,
  groupConsecutiveThreads,
  hasNoPartnerEmail,
  highlightRanges,
  isOpenStage,
  isPartnerStale,
  isPartnerUnanswered,
  rangeDays,
  sortByTsAsc,
  sortRows,
  workingDaysBetween,
  type CaseMessageRow,
  type CorrespondenceRow,
} from "./correspondence-shared";

// Fixtures are deliberately built from the live 07/09/2026 numbers in the spec,
// so a test failure points at a real case rather than at an invented one.

function row(over: Partial<CorrespondenceRow> = {}): CorrespondenceRow {
  return {
    client_id: "00000000-0000-0000-0000-000000000000",
    client_code: "CLT0001-GR",
    client_name: "Test Client",
    stage: "Active",
    client_in: 0,
    client_out: 0,
    client_last: null,
    partner_in: 0,
    partner_out: 0,
    partner_last: null,
    any_last: null,
    ...over,
  };
}

function msg(over: Partial<CaseMessageRow> = {}): CaseMessageRow {
  return {
    message_id: "m1",
    thread_id: "t1",
    party: "client",
    direction: "Inbound",
    ts: "2026-09-04T09:00:00Z",
    subject: "Subject",
    snippet: "Snippet body",
    from_addr: "someone@example.com",
    to_addr: "hello@mygreektax.eu",
    client_id: "00000000-0000-0000-0000-000000000000",
    client_code: "CLT0001-GR",
    client_name: "Test Client",
    stage: "Active",
    gmail_url: "https://mail.google.com/mail/u/0/#all/t1",
    ...over,
  };
}

// CLT0043 Patrik Andersson — the acceptance case. Largest in the book, partner
// in 0 / out 2, no written partner reply since 31/08.
const PATRIK = row({
  client_code: "CLT0043-SW",
  client_name: "Patrik Andersson",
  stage: "Active",
  client_in: 6,
  client_out: 6,
  client_last: "2026-09-02T10:00:00Z",
  partner_in: 0,
  partner_out: 2,
  partner_last: "2026-08-31T17:45:54Z",
  any_last: "2026-09-02T10:00:00Z",
});

// CLT0039 Ruthie Swartz — busiest client thread, no partner email at all.
const RUTHIE = row({
  client_code: "CLT0039-UK",
  client_name: "Ruthie Swartz",
  stage: "Active",
  client_in: 11,
  client_out: 9,
  client_last: "2026-09-07T08:00:00Z",
  partner_in: 0,
  partner_out: 0,
  partner_last: null,
  any_last: "2026-09-07T08:00:00Z",
});

// CLT0028 Alexandros Cocolis — a live two-way partner conversation.
const ALEXANDROS = row({
  client_code: "CLT0028-SW",
  client_name: "Alexandros Cocolis",
  stage: "Active",
  client_in: 4,
  client_out: 6,
  client_last: "2026-09-04T09:00:00Z",
  partner_in: 2,
  partner_out: 1,
  partner_last: "2026-09-04T09:40:00Z",
  any_last: "2026-09-04T09:40:00Z",
});

describe("stage grouping", () => {
  it("treats exactly Active, Quoted and Potential as open", () => {
    expect([...OPEN_CORRESPONDENCE_STAGES]).toEqual(["Active", "Quoted", "Potential"]);
    expect(isOpenStage("Active")).toBe(true);
    expect(isOpenStage("Delivered")).toBe(false);
    expect(isOpenStage(null)).toBe(false);
  });

  it("orders open groups Active, Quoted, Potential and drops empty ones", () => {
    const rows = [
      row({ client_code: "A", stage: "Potential" }),
      row({ client_code: "B", stage: "Active" }),
    ];
    expect(groupByStage(rows, false).map((g) => g.stage)).toEqual(["Active", "Potential"]);
  });

  it("puts Delivered with the closed half, not the open one", () => {
    const rows = [row({ stage: "Delivered" })];
    expect(groupByStage(rows, false)).toEqual([]);
    expect(groupByStage(rows, true).map((g) => g.stage)).toEqual(["Delivered"]);
    expect([...CLOSED_CORRESPONDENCE_STAGES]).toContain("Delivered");
  });

  it("puts an unknown or null stage under Other in the closed half, exactly once", () => {
    const rows = [
      row({ client_code: "X", stage: "Marinated" }),
      row({ client_code: "Y", stage: null }),
    ];
    expect(groupByStage(rows, false)).toEqual([]);
    const closed = groupByStage(rows, true);
    expect(closed.map((g) => g.stage)).toEqual(["Other"]);
    expect(closed[0].rows).toHaveLength(2);
  });

  it("never shows a row in both halves and never loses one", () => {
    const rows = [
      row({ client_code: "a", stage: "Active" }),
      row({ client_code: "b", stage: "Quoted" }),
      row({ client_code: "c", stage: "Potential" }),
      row({ client_code: "d", stage: "Delivered" }),
      row({ client_code: "e", stage: "Parked" }),
      row({ client_code: "f", stage: "Complete" }),
      row({ client_code: "g", stage: "Lost" }),
      row({ client_code: "h", stage: "Nonsense" }),
    ];
    const open = groupByStage(rows, false).flatMap((g) => g.rows);
    const closed = groupByStage(rows, true).flatMap((g) => g.rows);
    expect(open).toHaveLength(3);
    expect(closed).toHaveLength(5);
    const seen = [...open, ...closed].map((r) => r.client_code).sort();
    expect(seen).toEqual(["a", "b", "c", "d", "e", "f", "g", "h"]);
  });
});

describe("partner signals", () => {
  it("flags Patrik as unanswered: written to twice, no reply", () => {
    expect(isPartnerUnanswered(PATRIK)).toBe(true);
  });

  it("does not flag a case with no partner email at all as unanswered", () => {
    expect(isPartnerUnanswered(RUTHIE)).toBe(false);
    expect(hasNoPartnerEmail(RUTHIE)).toBe(true);
  });

  it("does not flag a two-way partner conversation as unanswered", () => {
    expect(isPartnerUnanswered(ALEXANDROS)).toBe(false);
    expect(hasNoPartnerEmail(ALEXANDROS)).toBe(false);
  });

  it("treats null counts as zero rather than throwing", () => {
    const blank = row({ partner_in: null, partner_out: null });
    expect(isPartnerUnanswered(blank)).toBe(false);
    expect(hasNoPartnerEmail(blank)).toBe(true);
  });
});

describe("workingDaysBetween", () => {
  // 2026-09-07 is a Monday; 2026-08-31 is the Monday before it.
  it("counts weekdays only", () => {
    // Mon 31/08 17:45 -> Mon 07/09 09:48: Tue, Wed, Thu, Fri, Mon = 5.
    expect(workingDaysBetween("2026-08-31T17:45:54Z", new Date("2026-09-07T09:48:00Z"))).toBe(5);
  });

  it("skips the weekend", () => {
    // Fri 04/09 -> Mon 07/09 is one working day, not three.
    expect(workingDaysBetween("2026-09-04T09:00:00Z", new Date("2026-09-07T09:00:00Z"))).toBe(1);
  });

  it("is zero for the same day", () => {
    expect(workingDaysBetween("2026-09-07T01:00:00Z", new Date("2026-09-07T23:00:00Z"))).toBe(0);
  });

  it("returns 0 rather than a negative count for a future timestamp", () => {
    expect(workingDaysBetween("2026-09-20T00:00:00Z", new Date("2026-09-07T00:00:00Z"))).toBe(0);
  });

  it("returns 0 for null and for an unparseable date", () => {
    expect(workingDaysBetween(null, new Date("2026-09-07T00:00:00Z"))).toBe(0);
    expect(workingDaysBetween("not a date", new Date("2026-09-07T00:00:00Z"))).toBe(0);
  });
});

describe("isPartnerStale", () => {
  const monday = new Date("2026-09-07T09:48:00Z");

  it("does not flag Patrik at exactly five working days — the threshold is strictly greater", () => {
    expect(workingDaysBetween(PATRIK.partner_last, monday)).toBe(PARTNER_STALE_WORKING_DAYS);
    expect(isPartnerStale(PATRIK, monday)).toBe(false);
  });

  it("flags Patrik one day later, at six working days", () => {
    expect(isPartnerStale(PATRIK, new Date("2026-09-08T09:48:00Z"))).toBe(true);
  });

  it("does not flag a case whose partner wrote on Friday", () => {
    expect(isPartnerStale(ALEXANDROS, monday)).toBe(false);
  });

  it("does not flag a case with no partner email at all", () => {
    expect(isPartnerStale(RUTHIE, monday)).toBe(false);
  });

  it("only applies to Active cases", () => {
    const quoted = row({ ...PATRIK, stage: "Quoted" });
    expect(isPartnerStale(quoted, new Date("2026-10-01T00:00:00Z"))).toBe(false);
    const active = row({ ...PATRIK, stage: "Active" });
    expect(isPartnerStale(active, new Date("2026-10-01T00:00:00Z"))).toBe(true);
  });
});

describe("sorting", () => {
  const rows = [PATRIK, RUTHIE, ALEXANDROS];

  it("defaults counts and dates to descending, text to ascending", () => {
    expect(defaultDirFor("any_last")).toBe("desc");
    expect(defaultDirFor("partner_in")).toBe("desc");
    expect(defaultDirFor("case")).toBe("asc");
    expect(defaultDirFor("client")).toBe("asc");
    expect(defaultDirFor("stage")).toBe("asc");
  });

  it("sorts by any_last descending — the page default", () => {
    expect(sortRows(rows, "any_last", "desc").map((r) => r.client_code)).toEqual([
      "CLT0039-UK",
      "CLT0028-SW",
      "CLT0043-SW",
    ]);
  });

  it("sorts nulls last in both directions", () => {
    const withNull = [RUTHIE, PATRIK]; // Ruthie has partner_last null
    expect(sortRows(withNull, "partner_last", "desc").map((r) => r.client_code)).toEqual([
      "CLT0043-SW",
      "CLT0039-UK",
    ]);
    expect(sortRows(withNull, "partner_last", "asc").map((r) => r.client_code)).toEqual([
      "CLT0043-SW",
      "CLT0039-UK",
    ]);
  });

  it("sorts case codes numerically so CLT0009 precedes CLT0010", () => {
    const a = row({ client_code: "CLT0010-GR" });
    const b = row({ client_code: "CLT0009-GR" });
    expect(sortRows([a, b], "case", "asc").map((r) => r.client_code)).toEqual([
      "CLT0009-GR",
      "CLT0010-GR",
    ]);
  });

  it("treats a null count as 0 rather than sorting it last", () => {
    const nullish = row({ client_code: "N", client_in: null });
    const one = row({ client_code: "O", client_in: 1 });
    expect(compareRows(nullish, one, "client_in", "desc")).toBeGreaterThan(0);
  });

  it("does not mutate the input array", () => {
    const input = [PATRIK, RUTHIE];
    const before = input.map((r) => r.client_code);
    sortRows(input, "any_last", "asc");
    expect(input.map((r) => r.client_code)).toEqual(before);
  });
});

describe("filterMessages", () => {
  const now = new Date("2026-09-07T12:00:00Z");
  const messages = [
    msg({ message_id: "old", ts: "2026-07-02T10:00:00Z", subject: "July note" }),
    msg({ message_id: "mid", ts: "2026-08-20T10:00:00Z", subject: "August note" }),
    msg({
      message_id: "new",
      ts: "2026-09-05T10:00:00Z",
      subject: "September note",
      direction: "Outbound",
    }),
  ];

  it("passes everything through with the default filters", () => {
    const out = filterMessages(messages, { direction: "all", range: "all", query: "" }, now);
    expect(out).toHaveLength(3);
  });

  it("filters by direction", () => {
    const out = filterMessages(messages, { direction: "outbound", range: "all", query: "" }, now);
    expect(out.map((m) => m.message_id)).toEqual(["new"]);
  });

  it("filters by the 7 and 30 day ranges", () => {
    expect(rangeDays("7")).toBe(7);
    expect(rangeDays("30")).toBe(30);
    expect(rangeDays("all")).toBeNull();
    expect(
      filterMessages(messages, { direction: "all", range: "7", query: "" }, now).map(
        (m) => m.message_id,
      ),
    ).toEqual(["new"]);
    expect(
      filterMessages(messages, { direction: "all", range: "30", query: "" }, now).map(
        (m) => m.message_id,
      ),
    ).toEqual(["mid", "new"]);
  });

  it("searches subject and snippet, case-insensitively", () => {
    const withSnippet = [
      msg({ message_id: "s", subject: "Nothing", snippet: "the AFM you asked for" }),
    ];
    expect(
      filterMessages(withSnippet, { direction: "all", range: "all", query: "afm" }, now),
    ).toHaveLength(1);
    expect(
      filterMessages(withSnippet, { direction: "all", range: "all", query: "ΑΦΜ" }, now),
    ).toHaveLength(0);
  });

  it("ignores surrounding whitespace in the search term", () => {
    expect(
      filterMessages(messages, { direction: "all", range: "all", query: "  july  " }, now),
    ).toHaveLength(1);
  });

  it("keeps a message with no timestamp rather than hiding it", () => {
    const undated = [msg({ message_id: "u", ts: null })];
    expect(filterMessages(undated, { direction: "all", range: "7", query: "" }, now)).toHaveLength(
      1,
    );
  });

  it("combines all three filters", () => {
    const out = filterMessages(
      messages,
      { direction: "outbound", range: "30", query: "september" },
      now,
    );
    expect(out.map((m) => m.message_id)).toEqual(["new"]);
  });
});

describe("sortByTsAsc", () => {
  it("orders oldest first with undated last", () => {
    const out = sortByTsAsc([
      msg({ message_id: "b", ts: "2026-09-05T10:00:00Z" }),
      msg({ message_id: "z", ts: null }),
      msg({ message_id: "a", ts: "2026-09-01T10:00:00Z" }),
    ]);
    expect(out.map((m) => m.message_id)).toEqual(["a", "b", "z"]);
  });
});

describe("groupConsecutiveThreads", () => {
  it("groups a run of one thread into a single block", () => {
    const blocks = groupConsecutiveThreads([
      msg({ message_id: "1", thread_id: "t1", subject: "Re: CLT0052" }),
      msg({ message_id: "2", thread_id: "t1" }),
    ]);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].subject).toBe("Re: CLT0052");
    expect(blocks[0].messages).toHaveLength(2);
  });

  it("does not merge two runs of the same thread separated by another", () => {
    const blocks = groupConsecutiveThreads([
      msg({ message_id: "1", thread_id: "t1" }),
      msg({ message_id: "2", thread_id: "t2" }),
      msg({ message_id: "3", thread_id: "t1" }),
    ]);
    expect(blocks.map((b) => b.threadId)).toEqual(["t1", "t2", "t1"]);
  });

  it("never merges messages whose thread_id is null", () => {
    const blocks = groupConsecutiveThreads([
      msg({ message_id: "1", thread_id: null }),
      msg({ message_id: "2", thread_id: null }),
    ]);
    expect(blocks).toHaveLength(2);
  });
});

describe("highlightRanges", () => {
  it("finds every occurrence, case-insensitively", () => {
    expect(highlightRanges("AFM and afm", "afm")).toEqual([
      [0, 3],
      [8, 11],
    ]);
  });

  it("returns nothing for an empty or whitespace term", () => {
    expect(highlightRanges("anything", "")).toEqual([]);
    expect(highlightRanges("anything", "   ")).toEqual([]);
  });

  it("does not loop forever on a repeated term", () => {
    expect(highlightRanges("aaaa", "aa")).toEqual([
      [0, 2],
      [2, 4],
    ]);
  });
});
