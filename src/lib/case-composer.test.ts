import { describe, expect, it } from "vitest";
import {
  draftToOffer,
  findCurrencyFigures,
  findGatedContent,
  findPricingExposure,
  isBeforeDeposit,
  reviewBody,
  visibleText,
} from "./case-composer";

describe("draftToOffer", () => {
  const v = (over: Partial<{ id: string; draft_text: string; sent_at: string | null }> = {}) => ({
    id: "v2",
    draft_text: "Dear Anna, your 2025 return is filed.",
    sent_at: null,
    ...over,
  });

  it("offers the draft and attributes it when the two agree", () => {
    const out = draftToOffer({ currentDraftText: v().draft_text, version: v() });
    expect(out).toEqual({ text: v().draft_text, versionIsCurrent: true, reason: "offer" });
  });

  it("offers a draft the version table never recorded, unattributed", () => {
    // The trigger swallows its own exceptions, so this case exists in the data.
    // Before the fix the editor came up empty and the draft could not be sent.
    const out = draftToOffer({ currentDraftText: "Hand-written by the Brain", version: null });
    expect(out.text).toBe("Hand-written by the Brain");
    expect(out.versionIsCurrent).toBe(false);
    expect(out.reason).toBe("offer");
  });

  it("offers the newer draft, not the recorded one, when they diverge", () => {
    // The regression that would have sent the stale text.
    const out = draftToOffer({
      currentDraftText: "v3 text",
      version: v({ draft_text: "v2 text" }),
    });
    expect(out.text).toBe("v3 text");
    expect(out.versionIsCurrent).toBe(false);
  });

  it("offers nothing when there is no draft anywhere", () => {
    expect(draftToOffer({}).reason).toBe("no-draft");
    expect(draftToOffer({ currentDraftText: "" }).reason).toBe("no-draft");
  });

  it("stops offering an approved draft, even when the version stamp failed", () => {
    // is_approved is written before the stamp, so it is the signal that
    // survives it. sent_at being null here is the whole point of the case.
    const out = draftToOffer({
      currentDraftText: v().draft_text,
      currentDraftApproved: true,
      version: v({ sent_at: null }),
    });
    expect(out.text).toBe("");
    expect(out.reason).toBe("already-approved");
  });

  it("stops offering an approved draft that has no version row at all", () => {
    const out = draftToOffer({
      currentDraftText: "Sent, never recorded",
      currentDraftApproved: true,
      version: null,
    });
    expect(out.reason).toBe("already-approved");
  });

  it("stops offering a version already stamped as sent", () => {
    const out = draftToOffer({
      currentDraftText: v().draft_text,
      version: v({ sent_at: "2026-08-30T10:00:00Z" }),
    });
    expect(out.reason).toBe("version-already-sent");
  });

  it("keeps offering a newer draft even when the version behind it was sent", () => {
    // A regeneration the trigger missed, on top of a version that did send.
    // The new text is unsent whatever the older row says.
    const out = draftToOffer({
      currentDraftText: "regenerated after the send",
      version: v({ draft_text: "the one that went", sent_at: "2026-08-30T10:00:00Z" }),
    });
    expect(out.text).toBe("regenerated after the send");
    expect(out.reason).toBe("offer");
  });

  it("stops offering within the session, before the reload lands", () => {
    expect(
      draftToOffer({ currentDraftText: v().draft_text, version: v(), sentVersionId: "v2" }).reason,
    ).toBe("sent-this-session");
    expect(
      draftToOffer({ currentDraftText: "ad hoc", version: null, sentDraftText: "ad hoc" }).reason,
    ).toBe("sent-this-session");
  });

  it("does not confuse one session send for another", () => {
    // A different version, and different unrecorded text, are both still on offer.
    expect(
      draftToOffer({ currentDraftText: v().draft_text, version: v(), sentVersionId: "v1" }).reason,
    ).toBe("offer");
    expect(
      draftToOffer({ currentDraftText: "draft B", version: null, sentDraftText: "draft A" }).reason,
    ).toBe("offer");
  });

  it("never attributes a send to a version whose text is not going out", () => {
    // The invariant that keeps the quality metric honest: every state that
    // offers text must either match the version or decline to attribute it.
    const states = [
      { currentDraftText: "x", version: v({ draft_text: "x" }) },
      { currentDraftText: "x", version: v({ draft_text: "y" }) },
      { currentDraftText: "x", version: null },
      { currentDraftText: "", version: v({ draft_text: "y" }) },
    ];
    for (const s of states) {
      const out = draftToOffer(s);
      if (out.versionIsCurrent) expect(out.text).toBe(s.version?.draft_text);
    }
  });
});

describe("isBeforeDeposit", () => {
  it("gates the stages before Active and clears the rest", () => {
    expect(isBeforeDeposit("Potential")).toBe(true);
    expect(isBeforeDeposit("Quoted")).toBe(true);
    expect(isBeforeDeposit("Active")).toBe(false);
    expect(isBeforeDeposit("Delivered")).toBe(false);
    expect(isBeforeDeposit("Complete")).toBe(false);
  });

  it("gates Parked and Lost, which are reachable from Quoted", () => {
    // These sort after Active in CLIENT_STAGES, which is a display order and
    // not a progression. Reading it as one switched the gate off for a lead
    // that was quoted, went quiet and was parked without ever paying.
    expect(isBeforeDeposit("Parked")).toBe(true);
    expect(isBeforeDeposit("Lost")).toBe(true);
  });

  it("lets a recorded deposit open the gate whatever the stage", () => {
    // A case that paid and was later parked is not before its deposit.
    expect(isBeforeDeposit("Parked", true)).toBe(false);
    expect(isBeforeDeposit("Quoted", true)).toBe(false);
  });

  it("does not gate on a missing or unknown stage", () => {
    // A case with no stage at all is not evidence of an unpaid deposit.
    // Blocking on absent data would stop ordinary work for no reason.
    expect(isBeforeDeposit(null)).toBe(false);
    expect(isBeforeDeposit(undefined)).toBe(false);
    expect(isBeforeDeposit("")).toBe(false);
    expect(isBeforeDeposit("Something else")).toBe(false);
  });
});

describe("findCurrencyFigures", () => {
  it("finds the shapes that appear in real drafts", () => {
    // Every one of these is taken from a real compliance_insights or draft.
    expect(findCurrencyFigures("Bundle price of 249 EUR was quoted")).toEqual(["249 EUR"]);
    expect(findCurrencyFigures("the 99 euro fee was quoted")).toEqual(["99 euro"]);
    expect(findCurrencyFigures("Quote is €249 all in")).toEqual(["€249"]);
    expect(findCurrencyFigures("249€ total")).toEqual(["249€"]);
    expect(findCurrencyFigures("Partial payment of 34.50 EUR received")).toEqual(["34.50 EUR"]);
    expect(findCurrencyFigures("150-250 EUR setup")).toEqual(["150-250 EUR"]);
  });

  it("finds the Greek form, which partner mail actually uses", () => {
    expect(findCurrencyFigures("Το κόστος είναι 120 ευρώ.")).toEqual(["120 ευρώ"]);
    expect(findCurrencyFigures("40 euros per filing")).toEqual(["40 euros"]);
  });

  it("finds the Greek form written without its accent, and in capitals", () => {
    // Greek capitals drop the accent by orthographic convention, so ΕΥΡΩ does
    // not case-fold onto ευρώ and was invisible to the rule.
    expect(findCurrencyFigures("Η αμοιβή είναι 60 ευρω ανά δήλωση.")).toEqual(["60 ευρω"]);
    expect(findCurrencyFigures("ΚΟΣΤΟΣ 250 ΕΥΡΩ")).toEqual(["250 ΕΥΡΩ"]);
  });

  it("finds a figure written with no space, which \\b could not", () => {
    // \b never falls between a digit and a letter, so every one of these
    // produced no match at all and no confirmation was ever asked for.
    expect(findCurrencyFigures("Ο πελάτης πλήρωσε 249EUR συνολικά.")).toEqual(["249EUR"]);
    expect(findCurrencyFigures("EUR249 total")).toEqual(["EUR249"]);
    expect(findCurrencyFigures("249,50EUR")).toEqual(["249,50EUR"]);
    expect(findCurrencyFigures("249eur")).toEqual(["249eur"]);
  });

  it("does not read a currency out of a longer word", () => {
    expect(findCurrencyFigures("Η οδηγία 2016 ευρωπαϊκή ισχύει")).toEqual([]);
    expect(findCurrencyFigures("Flight to EUROPE in 2026")).toEqual([]);
  });

  it("does not flag the numbers Greek tax work is full of", () => {
    // Form codes, years, articles and AFMs are not prices, and flagging them
    // would train the operator to click through the warning.
    expect(findCurrencyFigures("Submit the Δ210 and the E1 for 2025")).toEqual([]);
    expect(findCurrencyFigures("Article 5A applies from 2026")).toEqual([]);
    expect(findCurrencyFigures("AFM 164334680, passport AA1858675")).toEqual([]);
    expect(findCurrencyFigures("")).toEqual([]);
  });

  it("reports each distinct figure once", () => {
    expect(findCurrencyFigures("249 EUR now, 249 EUR later, then 99 euro")).toEqual([
      "249 EUR",
      "99 euro",
    ]);
  });
});

describe("findPricingExposure", () => {
  it("names terms that can only mean retail", () => {
    expect(findPricingExposure("our margin on this is fine").retailTerms).toContain("margin");
    expect(findPricingExposure("the markup covers it").retailTerms).toContain("markup");
    expect(findPricingExposure("retail price list").retailTerms).toContain("retail");
    expect(findPricingExposure("the client fee is separate").retailTerms).toContain("client fee");
    expect(findPricingExposure("we charge 249 for the bundle").retailTerms).toContain(
      "what we charge",
    );
    expect(findPricingExposure("our price for the bundle").retailTerms).toContain("our price");
  });

  it("lets us ask a partner about their own rate", () => {
    // R2 permits a figure the partner themselves proposed, and the second
    // person in partner-facing text addresses the partner.
    expect(
      findPricingExposure("You quoted 40 EUR for this last time, is that still right?").retailTerms,
    ).toEqual([]);
    expect(findPricingExposure("Do you charge per filing or per hour?").retailTerms).toEqual([]);
  });

  it("leaves ordinary partner prose alone", () => {
    const body = "Καλημέρα, στέλνω τα δικαιολογητικά για το Δ210 αύριο.";
    expect(findPricingExposure(body)).toEqual({ retailTerms: [], figures: [] });
  });
});

describe("findGatedContent", () => {
  it("returns nothing once the deposit has cleared", () => {
    expect(findGatedContent("Here is the checklist", "client", false)).toEqual([]);
    expect(findGatedContent("Σου στέλνω την ανάθεση", "partner", false)).toEqual([]);
  });

  it("withholds client checklists and methodology before the deposit", () => {
    expect(findGatedContent("Here is the checklist to start", "client", true)).toContain(
      "checklist",
    );
    expect(findGatedContent("Στείλε μου τα δικαιολογητικά", "client", true)).toContain(
      "δικαιολογητικά",
    );
    expect(findGatedContent("The methodology is as follows", "client", true)).toContain(
      "methodology",
    );
  });

  it("withholds a partner assignment before the deposit", () => {
    expect(findGatedContent("Σου στέλνω την ανάθεση", "partner", true)).toContain("ανάθεση");
    expect(findGatedContent("Please start on this today", "partner", true)).toContain(
      "instruction to start",
    );
  });

  it("is not defeated by a line break inside the phrase", () => {
    // visibleText keeps block structure as newlines, so a literal space in a
    // rule did not match a phrase the reader still sees as one sentence.
    const wrapped = visibleText("<p>Here are the required<br>documents for your filing.</p>");
    expect(findGatedContent(wrapped, "client", true)).toContain("required documents");
    expect(findGatedContent("Please\nstart on this", "partner", true)).toContain(
      "instruction to start",
    );
  });

  it("permits what the rule permits: questions and payment logistics", () => {
    const scope = "Could you confirm whether this needs a Δ210 at all?";
    expect(findGatedContent(scope, "partner", true)).toEqual([]);
    const payment = "The deposit link is below, let me know once it goes through.";
    expect(findGatedContent(payment, "client", true)).toEqual([]);
  });
});

describe("visibleText", () => {
  it("does not let inline formatting split a word", () => {
    // Bolding half a word would otherwise read as "check list" to the rules
    // while the email still renders "checklist", walking a gated term through.
    expect(visibleText("<p>Here is the check<strong>list</strong> to start</p>")).toBe(
      "Here is the checklist to start",
    );
    expect(findGatedContent(visibleText("<p>the check<b>list</b></p>"), "client", true)).toContain(
      "checklist",
    );
  });

  it("keeps separate blocks apart", () => {
    expect(visibleText("<p>one</p><p>two</p>")).toBe("one\ntwo");
    expect(visibleText("a<br>b")).toBe("a\nb");
  });

  it("decodes entities so the rules see the rendered words", () => {
    expect(visibleText("<p>fees &amp; costs</p>")).toBe("fees & costs");
  });
});

describe("reviewBody", () => {
  const clean = "Thank you for chasing. We are waiting on AADE and will write as soon as it moves.";

  it("passes clean client mail with nothing to answer for", () => {
    expect(reviewBody(clean, "client", false)).toEqual({ blocking: [], confirmations: [] });
  });

  it("never applies the pricing firewall to client mail", () => {
    // The client is entitled to their own price. R2 governs partner-facing text.
    const verdict = reviewBody("Your bundle is 249 EUR, deposit 124.50 EUR.", "client", false);
    expect(verdict.blocking).toEqual([]);
    expect(verdict.confirmations).toEqual([]);
  });

  it("blocks a retail term in partner mail", () => {
    const verdict = reviewBody("Our margin here is comfortable.", "partner", false);
    expect(verdict.blocking).toHaveLength(1);
    expect(verdict.blocking[0]).toContain("R2");
    expect(verdict.blocking[0]).toContain("margin");
  });

  it("asks for confirmation on every figure in partner mail without blocking", () => {
    const verdict = reviewBody("Το κόστος είναι 120 EUR για το Δ210.", "partner", false);
    expect(verdict.blocking).toEqual([]);
    expect(verdict.confirmations).toHaveLength(1);
    expect(verdict.confirmations[0]).toContain("120 EUR");
    expect(verdict.confirmations[0]).toContain("wholesale");
  });

  it("asks about a client figure before the deposit, without blocking it", () => {
    // R7 withholds "locked figures beyond the quote itself", but the quote and
    // payment logistics are exactly what a Quoted case may state, so this is a
    // question rather than a refusal.
    const verdict = reviewBody("The deposit is 124.50 EUR, link below.", "client", true);
    expect(verdict.blocking).toEqual([]);
    expect(verdict.confirmations).toHaveLength(1);
    expect(verdict.confirmations[0]).toContain("124.50 EUR");
    expect(verdict.confirmations[0]).toContain("R7");
  });

  it("says nothing about a client figure once the deposit has cleared", () => {
    expect(reviewBody("Your balance is 124.50 EUR.", "client", false)).toEqual({
      blocking: [],
      confirmations: [],
    });
  });

  it("blocks gated language in both targets before the deposit", () => {
    const toClient = reviewBody("Here is the checklist.", "client", true);
    expect(toClient.blocking.some((b) => b.startsWith("R7"))).toBe(true);

    const toPartner = reviewBody("Σου στέλνω την ανάθεση.", "partner", true);
    expect(toPartner.blocking.some((b) => b.startsWith("R7"))).toBe(true);
  });

  it("must read partner mail as written, not through the HTML stripper", () => {
    // Partner mail is plain text and is escaped on delivery, so a "<" is a
    // less-than sign the partner will see. Reading it through visibleText
    // deletes everything up to the next ">" and hides the figure from R2
    // while it still goes out. Both callers pass the raw text for this target.
    const raw = "Η αμοιβή σου είναι κάτω από <50 EUR. Στείλε το στο <a@b.gr> όταν τελειώσεις.";
    expect(reviewBody(raw, "partner", false).confirmations).toHaveLength(1);
    expect(reviewBody(visibleText(raw), "partner", false).confirmations).toEqual([]);
  });

  it("reports both rules at once when both are broken", () => {
    const verdict = reviewBody("Our margin covers it, σου στέλνω την ανάθεση.", "partner", true);
    expect(verdict.blocking.filter((b) => b.startsWith("R2"))).toHaveLength(1);
    expect(verdict.blocking.filter((b) => b.startsWith("R7"))).toHaveLength(1);
  });
});
