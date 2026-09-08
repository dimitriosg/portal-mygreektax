import { describe, expect, it } from "vitest";
import { CREDENTIAL_MARKER, containsCredential, redactCredentials } from "./redact-credentials";

// The shapes below are the ones that actually occurred in brain_events between
// 22/07/2026 and 07/09/2026, reduced to their structure with invented values.
// No real credential appears in this file.

describe("redactCredentials", () => {
  describe("masks the shapes that were really stored", () => {
    it("the client handover, as sent", () => {
      const input = "My myAADE (Taxisnet) credentials are:\nLogin: 123456789\nPassword: Abc123xyz9";
      const out = redactCredentials(input);
      expect(out).not.toContain("123456789");
      expect(out).not.toContain("Abc123xyz9");
      expect(out).toBe(
        `My myAADE (Taxisnet) credentials are:\nLogin: ${CREDENTIAL_MARKER}\nPassword: ${CREDENTIAL_MARKER}`,
      );
    });

    it("the same handover quoted back in a reply, quote markers intact", () => {
      const input = "> > Login: 123456789\n> > Password: Abc123xyz9\n> >\n> > Thanks";
      const out = redactCredentials(input);
      expect(out).toBe(
        `> > Login: ${CREDENTIAL_MARKER}\n> > Password: ${CREDENTIAL_MARKER}\n> >\n> > Thanks`,
      );
    });

    it("a space before the colon, which appeared 40 times", () => {
      expect(redactCredentials("Username : cayetana9")).toBe(`Username : ${CREDENTIAL_MARKER}`);
      expect(redactCredentials("Password : s3cret")).toBe(`Password : ${CREDENTIAL_MARKER}`);
    });

    it("credentials we sent outbound ourselves", () => {
      const out = redactCredentials("Your access is live. Username: alex.k Password: Tmp8891x");
      expect(out).not.toContain("alex.k");
      expect(out).not.toContain("Tmp8891x");
    });

    it("an equals separator, including inside a URL query string", () => {
      expect(redactCredentials("?username=someone@example.com&x=1")).toBe(
        `?username=${CREDENTIAL_MARKER}`,
      );
      expect(redactCredentials("password=hunter2")).toBe(`password=${CREDENTIAL_MARKER}`);
    });

    it("passcode and pin", () => {
      expect(redactCredentials("Passcode: 481922")).toBe(`Passcode: ${CREDENTIAL_MARKER}`);
      expect(redactCredentials("PIN: 4821")).toBe(`PIN: ${CREDENTIAL_MARKER}`);
    });

    it("Greek credential labels, including inflected endings", () => {
      expect(redactCredentials("Κωδικός: 8h3ka9")).toBe(`Κωδικός: ${CREDENTIAL_MARKER}`);
      expect(redactCredentials("Κωδικός πρόσβασης: abc123")).toBe(
        `Κωδικός πρόσβασης: ${CREDENTIAL_MARKER}`,
      );
      expect(redactCredentials("Συνθηματικό: mypass1")).toBe(`Συνθηματικό: ${CREDENTIAL_MARKER}`);
      expect(redactCredentials("Κλειδάριθμος: 998877")).toBe(`Κλειδάριθμος: ${CREDENTIAL_MARKER}`);
      expect(redactCredentials("Όνομα χρήστη: cayetana")).toBe(
        `Όνομα χρήστη: ${CREDENTIAL_MARKER}`,
      );
    });
  });

  describe("leaves alone what is not a credential", () => {
    it("a job code, which the case page needs", () => {
      const input = "Σου αναθέτω την υπόθεση. Κωδικός εργασίας: 0043";
      expect(redactCredentials(input)).toBe(input);
    });

    it("talking about credentials without giving one", () => {
      for (const input of [
        "TAXISnet credentials (username, password), and your consent to work with those",
        "I'm not sure how to complete the required step on TAXISnet.",
        "ΕΧΩ ΚΩΔΙΚΟΥΣ ΘΑ ΤΟΥ ΚΑΝΩ ΕΓΓΡΑΦΗ ΣΤΟΝ e-EFKA",
        "Ο πελάτης μπαίνει κανονικά με τους κωδικούς του",
        "We noticed a new login from a device you don't usually use",
        "AFM, AMKA, Taxisnet and the tax residency side",
      ]) {
        expect(redactCredentials(input)).toBe(input);
      }
    });

    it("a label inside a longer word", () => {
      for (const input of ["compass: north", "enduser: someone", "spin: fast"]) {
        expect(redactCredentials(input)).toBe(input);
      }
    });

    it("an AFM given as an identifier rather than as a login", () => {
      const input = "AFM: 202568353\n\nAMKA: 16019603741";
      expect(redactCredentials(input)).toBe(input);
    });
  });

  describe("safety properties", () => {
    it("is a fixpoint: masking twice equals masking once", () => {
      const input = "Login: 123456789\nPassword: Abc123xyz9\n> Username : other1";
      const once = redactCredentials(input);
      expect(redactCredentials(once)).toBe(once);
    });

    it("masks a value on the next line when that line is not quoted", () => {
      // The structured case note shape: label as a heading, value beneath.
      const input = "TAXISnet PASSWORD:\nAbc123xyz9\n\nKLEIDARITHMOS:\n17280-591-358";
      const out = redactCredentials(input);
      expect(out).not.toContain("Abc123xyz9");
      expect(out).not.toContain("17280-591-358");
      expect(out).toBe(
        `TAXISnet PASSWORD:\n${CREDENTIAL_MARKER}\n\nKLEIDARITHMOS:\n${CREDENTIAL_MARKER}`,
      );
    });

    it("masks a value on a quoted next line, keeping the quote markers", () => {
      expect(redactCredentials("> Password:\n> the-secret")).toBe(
        `> Password:\n> ${CREDENTIAL_MARKER}`,
      );
      expect(redactCredentials("> > Password:\n> > the-secret")).toBe(
        `> > Password:\n> > ${CREDENTIAL_MARKER}`,
      );
    });

    it("takes a quoted multi-word value whole", () => {
      // \S+ alone stops at the first space, leaving "horse battery staple"
      // readable after the mask.
      const out = redactCredentials('Password: "correct horse battery staple"');
      expect(out).toBe(`Password: ${CREDENTIAL_MARKER}`);
      expect(out).not.toContain("horse");
      expect(redactCredentials("Password: 'two words'")).toBe(`Password: ${CREDENTIAL_MARKER}`);
    });

    it("never masks a quote marker as if it were the value", () => {
      // The marker run is optional, so the engine can backtrack to zero markers
      // and take ">" as the value unless (?!>) forbids it.
      expect(redactCredentials("Password:\n>")).toBe("Password:\n>");
      const once = redactCredentials("> Password:\n> the-secret");
      expect(redactCredentials(once)).toBe(once);
      expect(redactCredentials(once)).not.toContain(`${CREDENTIAL_MARKER} ${CREDENTIAL_MARKER}`);
    });

    it("does not swallow the next paragraph after a blank line", () => {
      const input = "Password:\n\nDear Alex, thanks for that.";
      expect(redactCredentials(input)).toBe(input);
    });

    it("leaves an AFM heading alone even in the next-line shape", () => {
      const input = "AFM:\n147350878";
      expect(redactCredentials(input)).toBe(input);
    });

    it("handles null, undefined and empty input", () => {
      expect(redactCredentials(null)).toBeNull();
      expect(redactCredentials(undefined)).toBeNull();
      expect(redactCredentials("")).toBe("");
    });

    it("leaves text with no credential byte-for-byte unchanged", () => {
      const input = "Hello Dimitri,\n\nHere are the documents you asked for.\n\nBest,\nAlex";
      expect(redactCredentials(input)).toBe(input);
    });
  });

  describe("containsCredential", () => {
    it("reports unmasked values and ignores masked ones", () => {
      expect(containsCredential("Password: Abc123xyz9")).toBe(true);
      expect(containsCredential(`Password: ${CREDENTIAL_MARKER}`)).toBe(false);
      expect(containsCredential("Κωδικός εργασίας: 0043")).toBe(false);
      expect(containsCredential(null)).toBe(false);
    });

    it("is not stateful across calls", () => {
      // A /g regex reused with .test() alternates true/false on identical input.
      const input = "Password: Abc123xyz9";
      expect(containsCredential(input)).toBe(true);
      expect(containsCredential(input)).toBe(true);
      expect(containsCredential(input)).toBe(true);
    });
  });
});
