import { describe, expect, it } from "vitest";
import {
  findCurrencyFigures,
  findGatedContent,
  findPricingExposure,
  isBeforeDeposit,
  reviewBody,
  visibleText,
} from "./case-composer";

describe("isBeforeDeposit", () => {
  it("gates the stages before Active and clears the rest", () => {
    expect(isBeforeDeposit("Potential")).toBe(true);
    expect(isBeforeDeposit("Quoted")).toBe(true);
    expect(isBeforeDeposit("Active")).toBe(false);
    expect(isBeforeDeposit("Delivered")).toBe(false);
    expect(isBeforeDeposit("Complete")).toBe(false);
  });

  it("does not gate on a missing or unknown stage", () => {
    // An unknown stage sorts past every known one, and a case with no stage at
    // all is not evidence of an unpaid deposit. Blocking on absent data would
    // stop ordinary work for no reason.
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

  it("reports both rules at once when both are broken", () => {
    const verdict = reviewBody("Our margin covers it, σου στέλνω την ανάθεση.", "partner", true);
    expect(verdict.blocking.filter((b) => b.startsWith("R2"))).toHaveLength(1);
    expect(verdict.blocking.filter((b) => b.startsWith("R7"))).toHaveLength(1);
  });
});
