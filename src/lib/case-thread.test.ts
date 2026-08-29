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

  it("folds Outlook-style dividers even though their tail carries no '>' prefixes", () => {
    const original = "Fine by me.\n\n-----Original Message-----\nFrom: someone\nHello there";
    expect(splitQuoted(original).quotedLineCount).toBe(3);

    const underscores = "Fine by me.\n\n________________\nFrom: someone";
    expect(splitQuoted(underscores).quotedLineCount).toBe(2);
  });

  // A body that is quoted from its first line has no new text of its own. It
  // folds like any other quote and the card reports that there is nothing new,
  // rather than rendering the whole chain or a blank card.
  it("folds a body that is quoted from the first line, leaving no visible text", () => {
    const body = "> only quoted\n> nothing else";
    expect(splitQuoted(body)).toEqual({ visible: "", quoted: body, quotedLineCount: 2 });
  });

  it("folds a forward that starts at the divider", () => {
    const body =
      "---------- Forwarded message ---------\nFrom: AADE\n\nYour appointment is booked.";
    expect(splitQuoted(body)).toEqual({ visible: "", quoted: body, quotedLineCount: 4 });
  });

  it("folds a Yahoo reply that opens straight at the attribution line", () => {
    const body = [
      "Στις Τρίτη 28 Ιουλίου 2026 στις 11:19:31 π.μ. EEST, ο/η Chrisostomos Ftaklakis <chris_fta@yahoo.gr> έγραψε:  ",
      " ",
      "  Παλιό κείμενο.",
    ].join("\n");

    const split = splitQuoted(body);
    expect(split.visible).toBe("");
    expect(split.quotedLineCount).toBe(3);
  });

  it("does not fold an inline reply whose answers sit between '>' lines", () => {
    const body = [
      "Hi Dimitris,",
      "",
      "> Do you have an AFM?",
      "Yes, since 2019.",
      "> Any rental income?",
      "No, none at all.",
      "> Can you access TAXISnet?",
      "Not yet, I never set it up.",
    ].join("\n");
    expect(splitQuoted(body)).toEqual({ visible: body, quoted: null, quotedLineCount: 0 });
  });

  // Yahoo (the partner's webmail) indents its attribution line, pads it with
  // trailing spaces, writes "στις" twice, and then quotes the old message
  // flush left with no "> " prefix anywhere. Structure preserved from real
  // partner mail; addresses are the business counterparties, contents redacted.
  const YAHOO_ATTRIBUTION =
    "    Στις Πέμπτη 23 Ιουλίου 2026 στις 09:45:18 π.μ. EEST, ο/η Hello @ MyGreekTax <hello@mygreektax.eu> έγραψε:  ";

  it("folds a Yahoo attribution whose quoted body carries no '>' prefixes", () => {
    const body = [
      "Καλημέρα ,",
      "Ας το διορθώσουμε βάσει των σουηδικών εγγράφων.",
      "",
      YAHOO_ATTRIBUTION,
      " ",
      " Καλημέρα, Χρυσόστομε. ",
      "Δύο ερωτήσεις πριν φτιάξουμε το Δ210.",
      "",
      "Ευχαριστώ.",
    ].join("\n");

    const split = splitQuoted(body);
    expect(split.visible).toBe("Καλημέρα ,\nΑς το διορθώσουμε βάσει των σουηδικών εγγράφων.");
    expect(split.quoted?.startsWith(YAHOO_ATTRIBUTION)).toBe(true);
    expect(split.quoted).toContain("Δύο ερωτήσεις πριν φτιάξουμε το Δ210.");
    expect(split.quotedLineCount).toBe(6);
  });

  it("folds a nested Yahoo chain from the first attribution line", () => {
    const body = [
      "Το ανέβασα στο TAXISnet.",
      "",
      "    Στις Τρίτη 28 Ιουλίου 2026 στις 11:19:31 π.μ. EEST, ο/η Chrisostomos Ftaklakis <chris_fta@yahoo.gr> έγραψε:  ",
      " ",
      "  Υ.Δ ΕΞΟΥΣΙΟΔΟΤΗΣΗΣ ΜΕ ΓΝΗΣΙΟ ΥΠΟΓΡΑΦΗΣ ",
      "    Στις Τρίτη 28 Ιουλίου 2026 στις 10:44:37 π.μ. EEST, ο/η Hello @ MyGreekTax <hello@mygreektax.eu> έγραψε:  ",
      " ",
      " Παρακάτω τα στοιχεία για το Δ210:",
    ].join("\n");

    const split = splitQuoted(body);
    expect(split.visible).toBe("Το ανέβασα στο TAXISnet.");
    expect(split.quoted).toContain("11:19:31");
    // The second, deeper attribution stays inside the folded tail.
    expect(split.quoted).toContain("10:44:37");
    expect(split.quotedLineCount).toBe(6);
  });

  it("tolerates a non-breaking space indent on the attribution line", () => {
    const body = [
      "Έγινε.",
      "",
      "\u00a0Στις Πέμπτη 23 Ιουλίου 2026 στις 09:45:18 π.μ. EEST, ο/η Hello @ MyGreekTax <hello@mygreektax.eu> έγραψε:\u00a0",
      "Παλιό κείμενο.",
    ].join("\n");

    const split = splitQuoted(body);
    expect(split.visible).toBe("Έγινε.");
    expect(split.quotedLineCount).toBe(2);
  });

  it("does not fold prose where an 'On' line happens to precede a line ending 'wrote:'", () => {
    const body = [
      "Quick update.",
      "",
      "On Monday I will send the documents.",
      "Here is what the notary wrote:",
      "1) The deed needs an apostille.",
      "2) The translation must be certified.",
    ].join("\n");
    expect(splitQuoted(body)).toEqual({ visible: body, quoted: null, quotedLineCount: 0 });
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
