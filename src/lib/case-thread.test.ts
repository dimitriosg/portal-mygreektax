import { describe, expect, it } from "vitest";
import {
  athensDayKey,
  athensDayLabel,
  athensFullStamp,
  athensStamp,
  isPartnerEvent,
  splitQuoted,
} from "./case-thread";

describe("splitQuoted", () => {
  it("returns the whole body when nothing is quoted", () => {
    const body = "Hello,\n\nJust checking in.\n\nKind regards,\nAlex";
    expect(splitQuoted(body)).toEqual({ visible: body, quoted: null, quotedLineCount: 0 });
  });

  it("folds a Gmail reply chain from the attribution line", () => {
    const body = [
      "Thanks, that answers it.",
      "",
      "Kind regards,",
      "Alex",
      "",
      "On Mon, Aug 24, 2026 at 8:00 AM Alex C <alex@example.com> wrote:",
      "",
      "> Hi Dimitris,",
      ">",
      "> Important correction before you submit anything.",
    ].join("\r\n");

    const split = splitQuoted(body);
    expect(split.visible).toBe("Thanks, that answers it.\n\nKind regards,\nAlex");
    expect(split.quoted).toContain("On Mon, Aug 24, 2026 at 8:00 AM");
    expect(split.quoted).toContain("> Important correction");
    expect(split.quotedLineCount).toBe(5);
  });

  it("folds a wrapped Gmail attribution whose 'wrote:' lands on the next line", () => {
    const body = [
      "Noted, thank you.",
      "",
      "On Mon, 24 Aug 2026, 07:46 Hello @ MyGreekTax, <hello@mygreektax.eu>",
      "> wrote:",
      ">",
      ">> Hello Alex,",
    ].join("\r\n");

    const split = splitQuoted(body);
    expect(split.visible).toBe("Noted, thank you.");
    expect(split.quotedLineCount).toBe(4);
    expect(split.quoted?.startsWith("On Mon, 24 Aug 2026")).toBe(true);
  });

  it("folds a Greek Gmail attribution", () => {
    const body = [
      "Ελήφθη, θα το δω αύριο.",
      "",
      "Στις Δευ 24 Αυγ 2026 στις 9:00 ο χρήστης Δημήτρης <hello@mygreektax.eu> έγραψε:",
      "",
      "> Καλημέρα Χρυσόστομε,",
    ].join("\n");

    const split = splitQuoted(body);
    expect(split.visible).toBe("Ελήφθη, θα το δω αύριο.");
    expect(split.quotedLineCount).toBe(3);
  });

  it("does not treat prose starting with 'On' as an attribution", () => {
    const body = "On the municipality question, I still need an answer.\nThanks.";
    expect(splitQuoted(body).quoted).toBeNull();
  });

  it("folds from the first '>' line when there is no attribution", () => {
    const body = "See below.\n\n> quoted line one\n> quoted line two";
    const split = splitQuoted(body);
    expect(split.visible).toBe("See below.");
    expect(split.quotedLineCount).toBe(2);
  });

  it("folds Outlook-style dividers", () => {
    const original = "Fine by me.\n\n-----Original Message-----\nFrom: someone";
    expect(splitQuoted(original).quotedLineCount).toBe(2);

    const underscores = "Fine by me.\n\n________________\nFrom: someone";
    expect(splitQuoted(underscores).quotedLineCount).toBe(2);
  });

  it("handles a body that is quoted text from the first line", () => {
    const body = "> only quoted\n> nothing else";
    const split = splitQuoted(body);
    expect(split.visible).toBe("");
    expect(split.quotedLineCount).toBe(2);
  });
});

describe("athens time formatting", () => {
  it("renders summer timestamps at UTC+3", () => {
    const iso = "2026-06-12T06:14:00Z";
    expect(athensDayKey(iso)).toBe("2026-06-12");
    expect(athensStamp(iso)).toBe("12/06 09:14");
    expect(athensDayLabel(iso)).toBe("Friday 12 June 2026");
    expect(athensFullStamp(iso)).toBe("12/06/2026 09:14 Athens");
  });

  it("rolls a late UTC evening into the next Athens day in winter (UTC+2)", () => {
    const iso = "2026-01-10T22:30:00Z";
    expect(athensDayKey(iso)).toBe("2026-01-11");
    expect(athensStamp(iso)).toBe("11/01 00:30");
  });

  it("returns empty strings for null or invalid input", () => {
    expect(athensDayKey(null)).toBe("");
    expect(athensStamp("not a date")).toBe("");
    expect(athensDayLabel(null)).toBe("");
  });
});

describe("isPartnerEvent", () => {
  it("classifies by actor and by event type", () => {
    expect(isPartnerEvent({ actor: "partner", event_type: "customer_email_received" })).toBe(true);
    expect(isPartnerEvent({ actor: "dimitris", event_type: "partner_email_sent" })).toBe(true);
    expect(isPartnerEvent({ actor: "partner", event_type: "partner_email_received" })).toBe(true);
    expect(isPartnerEvent({ actor: "dimitris", event_type: "customer_email_sent" })).toBe(false);
    expect(isPartnerEvent({ actor: "customer", event_type: "customer_email_received" })).toBe(
      false,
    );
  });
});
