import { describe, expect, it } from "vitest";
import {
  describeContext,
  hasComparison,
  htmlToPlainText,
  knowledgeIdsFromContext,
  looksLikeHtml,
  sendState,
  type DraftVersionRow,
} from "./case-draft-versions";

const base: DraftVersionRow = {
  id: "v",
  version_no: 1,
  draft_text: "Hello Marta,\n\nThe M1 is with our accountant.",
  compliance_insights: null,
  context_used: {},
  model: null,
  generated_at: "2026-08-29T17:04:00Z",
  sent_at: null,
  sent_text: null,
  sent_mode: null,
};

describe("sendState", () => {
  it("reports a version that never went out", () => {
    expect(sendState(base)).toBe("not_sent");
  });

  it("trusts sent_mode over any text comparison", () => {
    // The desk HTML-ises and signs the draft before sending, so sent_text
    // differs from draft_text even on an untouched send. sent_mode is the only
    // reliable signal, and "as_is" must survive that difference.
    const asIs = {
      ...base,
      sent_at: "2026-08-29T17:15:00Z",
      sent_mode: "as_is",
      sent_text: "<p>Hello Marta,</p><p>The M1 is with our accountant.</p><p>MyGreekTax Team</p>",
    };
    expect(sendState(asIs)).toBe("sent_as_is");

    const edited = {
      ...base,
      sent_at: "2026-08-29T17:15:00Z",
      sent_mode: "edited",
      sent_text: "x",
    };
    expect(sendState(edited)).toBe("sent_edited");
  });

  it("falls back to a text comparison only when sent_mode is missing", () => {
    const legacySame = {
      ...base,
      sent_at: "2026-07-02T09:15:00Z",
      sent_mode: null,
      sent_text: base.draft_text,
    };
    expect(sendState(legacySame)).toBe("sent_as_is");

    const legacyDiff = {
      ...base,
      sent_at: "2026-07-02T09:15:00Z",
      sent_mode: null,
      sent_text: "Something else entirely.",
    };
    expect(sendState(legacyDiff)).toBe("sent_edited");
  });

  it("treats a send with no recorded text as as-is rather than guessing", () => {
    const noText = { ...base, sent_at: "2026-07-02T09:15:00Z", sent_mode: null, sent_text: null };
    expect(sendState(noText)).toBe("sent_as_is");
  });
});

describe("hasComparison", () => {
  it("is true only when both texts exist and differ", () => {
    expect(hasComparison({ draft_text: "a", sent_text: "b" })).toBe(true);
    expect(hasComparison({ draft_text: "a", sent_text: "a" })).toBe(false);
    expect(hasComparison({ draft_text: "a", sent_text: null })).toBe(false);
  });
});

describe("htmlToPlainText", () => {
  it("renders a stored send as the client read it", () => {
    // Shape taken from the one real sent row: TipTap paragraphs, a <br>, then
    // the stitched signature with inline styles and a link.
    const sent =
      "<p>Thank you for your message. We are reviewing the details.</p><br>" +
      "<p>Με εκτίμηση,<br><strong>MyGreekTax Team</strong><br></p>" +
      '<p><span style="color: rgb(107, 114, 128);">Greek tax &amp; admin, in English</span><br>' +
      '<a target="_blank" href="https://mygreektax.eu">mygreektax.eu</a></p>';

    const text = htmlToPlainText(sent);
    expect(text).toContain("Thank you for your message.");
    expect(text).toContain("Με εκτίμηση,");
    expect(text).toContain("MyGreekTax Team");
    expect(text).toContain("Greek tax & admin, in English");
    expect(text).not.toContain("<");
    expect(text).not.toContain("&amp;");
    expect(text).not.toMatch(/\n{3,}/);
  });

  it("leaves plain text alone", () => {
    expect(htmlToPlainText("Hello Marta,\n\nThe M1 is filed.")).toBe(
      "Hello Marta,\n\nThe M1 is filed.",
    );
  });

  it("decodes the entities the desk emits", () => {
    expect(htmlToPlainText("<p>a &lt; b &amp; c &gt; d &quot;e&quot; &#39;f&#39;&nbsp;g</p>")).toBe(
      "a < b & c > d \"e\" 'f' g",
    );
  });
});

describe("looksLikeHtml", () => {
  it("tells a stored send from a plain draft", () => {
    expect(looksLikeHtml("<p>Hello</p>")).toBe(true);
    expect(looksLikeHtml("Hello Marta,\n\nThe M1 is filed.")).toBe(false);
    // A draft may legitimately mention a comparison without being markup.
    expect(looksLikeHtml("The fee is < 100 euro and > 50 euro.")).toBe(false);
  });
});

describe("describeContext", () => {
  it("returns an empty string for the empty object every row carries today", () => {
    expect(describeContext({})).toBe("");
    expect(describeContext(null)).toBe("");
  });

  it("describes the counts the Brain would supply", () => {
    expect(describeContext({ client_messages: 6, partner_messages: 2, notes: 1 })).toBe(
      "6 client messages, 2 partner messages, 1 note",
    );
    expect(describeContext({ notes: 2, knowledge_entries: 4 })).toBe(
      "2 notes, 4 knowledge entries",
    );
    expect(describeContext({ knowledge_entries: 1 })).toBe("1 knowledge entry");
  });

  it("falls back to a combined message count when the split is absent", () => {
    expect(describeContext({ messages: 6 })).toBe("6 messages");
    // The split wins when both are present.
    expect(describeContext({ messages: 9, client_messages: 6 })).toBe("6 client messages");
  });

  it("ignores non-numeric values", () => {
    expect(describeContext({ notes: "two", client_messages: null })).toBe("");
  });
});

describe("knowledgeIdsFromContext", () => {
  it("returns nothing for the empty object every row carries today", () => {
    expect(knowledgeIdsFromContext({})).toEqual([]);
    expect(knowledgeIdsFromContext(null)).toEqual([]);
  });

  it("reads a plain array of ids", () => {
    expect(knowledgeIdsFromContext({ knowledge_ids: ["a", "b"] })).toEqual(["a", "b"]);
    expect(knowledgeIdsFromContext({ knowledge: ["a"] })).toEqual(["a"]);
  });

  it("reads an array of objects carrying an id", () => {
    expect(
      knowledgeIdsFromContext({ knowledge_entries: [{ id: "a", title: "AFM" }, { id: "b" }] }),
    ).toEqual(["a", "b"]);
  });

  it("ignores a count where a list was expected", () => {
    // context_used.knowledge_entries doubles as a count in describeContext.
    expect(knowledgeIdsFromContext({ knowledge_entries: 4 })).toEqual([]);
  });

  it("skips entries that carry no usable id", () => {
    expect(knowledgeIdsFromContext({ knowledge_ids: ["a", 7, null, { title: "no id" }] })).toEqual([
      "a",
    ]);
  });
});
