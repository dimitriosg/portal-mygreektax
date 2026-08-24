import { describe, expect, it } from "vitest";

import { buildPaymentNote, paymentNoteLabel, PAYMENT_NOTE_MAX_LENGTH } from "./payments-shared";

// Every case here is a regression that was found and fixed in review, not a
// hypothetical. The comment on each row is why it exists.

describe("paymentNoteLabel", () => {
  const cases: Array<{
    why: string;
    deposit: number | null;
    amount: number;
    quote: number | null;
    expected: string;
  }> = [
    { why: "base case", deposit: 0, amount: 150, quote: 300, expected: "upfront payment" },
    { why: "base case", deposit: 0, amount: 300, quote: 300, expected: "full payment" },
    { why: "base case", deposit: 0, amount: 100, quote: 300, expected: "deposit" },
    {
      why: "the collision the five labels fixed: against the quote alone this reads 'upfront payment' too",
      deposit: 150,
      amount: 150,
      quote: 300,
      expected: "balance payment",
    },
    {
      why: "partial against outstanding",
      deposit: 150,
      amount: 75,
      quote: 300,
      expected: "part payment",
    },
    {
      why: "CLT0048's real shape",
      deposit: 99,
      amount: 99,
      quote: 198,
      expected: "balance payment",
    },
    {
      why: "a null deposit is 'no money yet', not 'some paid'",
      deposit: null,
      amount: 150,
      quote: 300,
      expected: "upfront payment",
    },
    {
      why: "99.598% — whole-percent rounding would call this a full payment leaving €1 outstanding",
      deposit: 0,
      amount: 248,
      quote: 249,
      expected: "deposit",
    },
    {
      why: "50.005% — exact cent arithmetic would wrongly demote this to a deposit",
      deposit: 0,
      amount: 50,
      quote: 99.99,
      expected: "upfront payment",
    },
    {
      why: "outstanding is zero",
      deposit: 300,
      amount: 50,
      quote: 300,
      expected: "deposit",
    },
  ];

  for (const { why, deposit, amount, quote, expected } of cases) {
    it(`${amount} of ${quote} with ${deposit} paid -> ${expected} (${why})`, () => {
      expect(paymentNoteLabel(amount, quote, deposit)).toBe(expected);
    });
  }

  it("falls back to deposit when the quote is missing or non-positive", () => {
    expect(paymentNoteLabel(150, null, 0)).toBe("deposit");
    expect(paymentNoteLabel(150, 0, 0)).toBe("deposit");
  });

  it("falls back to deposit when the amount is missing or non-positive", () => {
    expect(paymentNoteLabel(0, 300, 0)).toBe("deposit");
    expect(paymentNoteLabel(Number.NaN, 300, 0)).toBe("deposit");
  });

  it("keeps the tolerance window on the outstanding path too", () => {
    // 199.90 of 200 outstanding is 99.95%, inside the window; 199.00 is 99.5%,
    // outside it. The window behaves the same either side of the deposit.
    expect(paymentNoteLabel(199.9, 300, 100)).toBe("balance payment");
    expect(paymentNoteLabel(199, 300, 100)).toBe("part payment");
  });
});

describe("buildPaymentNote", () => {
  const CASE_CODE = "MGT-CS001-CLT0028";
  const LONG_NAME = "Konstantinos Alexandros Papadopoulos-Anagnostopoulos Junior";

  it("builds the documented format", () => {
    expect(
      buildPaymentNote({
        caseCode: CASE_CODE,
        fullName: "Dimitrios Galanopoulos",
        amount: 150,
        quoteAmount: 300,
        depositSoFar: 0,
      }),
    ).toBe("MGT-CS001-CLT0028 (Dimitrios Galanopoulos), upfront payment");
  });

  it("never exceeds the cap, and always starts with the case code when there is one", () => {
    const inputs = [
      { caseCode: CASE_CODE, fullName: "Dimitrios Galanopoulos", amount: 150, quoteAmount: 300 },
      { caseCode: CASE_CODE, fullName: LONG_NAME, amount: 150, quoteAmount: 300 },
      { caseCode: CASE_CODE, fullName: "X".repeat(300), amount: 300, quoteAmount: 300 },
      { caseCode: CASE_CODE, fullName: null, amount: 100, quoteAmount: 300 },
      { caseCode: CASE_CODE, fullName: "Bo", amount: 150, quoteAmount: 300 },
    ];
    for (const input of inputs) {
      for (const depositSoFar of [null, 0, 150]) {
        const note = buildPaymentNote({ ...input, depositSoFar });
        expect(note.length).toBeLessThanOrEqual(PAYMENT_NOTE_MAX_LENGTH);
        expect(note.startsWith(CASE_CODE)).toBe(true);
      }
    }
  });

  it("respects the cap on the no-case-code path", () => {
    // This path used to return early, skipping the fitting logic entirely, and
    // emitted 76 characters.
    const note = buildPaymentNote({
      caseCode: null,
      fullName: LONG_NAME,
      amount: 100,
      quoteAmount: 200,
      depositSoFar: 0,
    });
    expect(note.length).toBeLessThanOrEqual(PAYMENT_NOTE_MAX_LENGTH);
    expect(note.endsWith(", upfront payment")).toBe(true);
  });

  it("produces no empty parentheses when the client has no name", () => {
    const note = buildPaymentNote({
      caseCode: CASE_CODE,
      fullName: null,
      amount: 150,
      quoteAmount: 300,
      depositSoFar: null,
    });
    expect(note).toBe("MGT-CS001-CLT0028, upfront payment");
    expect(note).not.toContain("(");
  });

  it("truncates the name without an ellipsis and keeps the label intact", () => {
    const note = buildPaymentNote({
      caseCode: "MGT-CS001-CLT0050",
      fullName: "Maria-Elena Konstantinopoulou",
      amount: 100,
      quoteAmount: 200,
      depositSoFar: 0,
    });
    expect(note).toBe("MGT-CS001-CLT0050 (Maria-Elena Konstantinopoul), upfront payment");
    expect(note.length).toBe(PAYMENT_NOTE_MAX_LENGTH);
    expect(note).not.toContain("…");
    expect(note).not.toContain("...");
  });

  it("keeps a genuinely short name when there is room for it", () => {
    // The minimum applies to the room available, not to the name's own length.
    expect(
      buildPaymentNote({
        caseCode: CASE_CODE,
        fullName: "Bo",
        amount: 150,
        quoteAmount: 300,
        depositSoFar: 0,
      }),
    ).toBe("MGT-CS001-CLT0028 (Bo), upfront payment");
  });

  it("labels the deposit and the balance on one case differently", () => {
    // The whole point: two Revolut transactions on the same case must not carry
    // identical strings.
    const shared = { caseCode: CASE_CODE, fullName: "Dimitrios Galanopoulos", quoteAmount: 300 };
    const deposit = buildPaymentNote({ ...shared, amount: 150, depositSoFar: 0 });
    const balance = buildPaymentNote({ ...shared, amount: 150, depositSoFar: 150 });
    expect(deposit).not.toBe(balance);
    expect(deposit).toContain("upfront payment");
    expect(balance).toContain("balance payment");
  });
});
