import { describe, expect, it } from "vitest";
import { clean, describeAll, describeFinding, scan, SecretFoundError, shannon } from "../src/index.ts";

/** Deterministic key-like text. Test secrets are built at run time so no real-looking key sits in the repo. */
function chars(n: number, alphabet = "aB3kQ9zX7mW2pL5vR8tY4nC6"): string {
  let out = "";
  for (let i = 0; i < n; i++) out += alphabet[(i * 7 + 3) % alphabet.length];
  return out;
}

// Secrets only: a number that fails its check may still be cut as a phone number, which the contact tests cover.
const labels = (text: string) => scan(text).filter((f) => f.kind === "secret").map((f) => f.label);
const kinds = (text: string) => scan(text).map((f) => f.kind);

describe("provider keys (ported gitleaks rules)", () => {
  it("finds a GitHub token", () => {
    expect(labels(`my token: ${"ghp_" + chars(36)} ok`)).toEqual(["GitHub token"]);
  });

  it("finds an Anthropic key", () => {
    expect(labels(`key ${"sk-ant-api03-" + chars(93, "abcXYZ0123456789_-") + "AA"} here`)).toEqual(["Anthropic key"]);
  });

  it("finds an AWS access key but not the documented example", () => {
    expect(labels(`id ${"AKIA" + chars(16, "QWERTYUPLKJHGFDSZ234567")}`)).toEqual(["AWS key"]);
    expect(labels("id AKIAIOSFODNN7EXAMPLE")).toEqual([]);
  });

  it("finds a private key block, even cut short", () => {
    const head = ["-----BEGIN", "RSA", "PRIVATE", "KEY-----"].join(" ");
    expect(labels(`${head}\n${chars(80)}\n`)).toEqual(["private key"]);
  });
});

describe("unknown keys (generic rule, entropy ≥ 3.5)", () => {
  it("finds an assigned random value next to a key word", () => {
    expect(labels(`api_key = "${chars(20)}"`)).toEqual(["API key or token"]);
  });

  it("finds the prose form", () => {
    expect(labels(`My api token is ${chars(20)} by the way.`)).toEqual(["API key or token"]);
  });

  it("ignores low-entropy and digit-free values", () => {
    expect(labels('api_key = "aaaaaaaaaaaaaaaa"')).toEqual([]);
    expect(labels("my token is supercalifragilistic")).toEqual([]);
    expect(labels("I wrote about the token economy in 2024.")).toEqual([]);
  });

  it("measures entropy in bits per character", () => {
    expect(shannon("aaaa")).toBe(0);
    expect(shannon("abcd")).toBe(2);
  });
});

describe("passwords", () => {
  it.each([
    "my password is hunter2",
    "Password: Tr0ub4dor&3",
    'my password is "fluffy"',
    "the PIN is 4821",
    "wifi passphrase: correctHorse",
  ])("finds %s", (text) => {
    expect(labels(text)).toEqual(["password"]);
  });

  it.each(["my password is weak.", "the PIN is required", "I reset my password is what I did", "password managers are great"])(
    "lets %s through",
    (text) => {
      expect(labels(text)).toEqual([]);
    },
  );
});

describe("ID and account numbers", () => {
  it("finds a card number that passes Luhn, not one that doesn't", () => {
    expect(labels("card 4111 1111 1111 1111 exp")).toEqual(["card number"]);
    expect(labels("card 4111 1111 1111 1112 exp")).toEqual([]);
  });

  it("doesn't read an ISBN as a card", () => {
    expect(labels("ISBN 978-0-13-468599-1")).toEqual([]);
  });

  it("finds an IBAN with a valid check", () => {
    expect(labels("pay GB82 WEST 1234 5698 7654 32 please")).toEqual(["bank account (IBAN)"]);
    expect(labels("pay GB83 WEST 1234 5698 7654 32 please")).toEqual([]);
  });

  it("finds a Chinese resident ID with a valid check digit and date", () => {
    expect(labels("ID 11010519491231002X")).toEqual(["Chinese resident ID"]);
    expect(labels("ID 110105194912310021")).toEqual([]);
    expect(labels("ID 11010519491331002X")).toEqual([]);
  });

  it("finds a US SSN but not reserved ranges", () => {
    expect(labels("SSN 123-45-6789")).toEqual(["US Social Security number"]);
    expect(labels("SSN 000-45-6789, 666-45-6789, 912-45-6789, 123-00-6789")).toEqual([]);
  });
});

describe("contacts", () => {
  it("finds email, phone and street address as contacts", () => {
    expect(kinds("mail me@example.com or call +1 412 555 0100, 5000 Forbes Avenue")).toEqual(["contact", "contact", "contact"]);
  });

  it("prefers the secret when a contact pattern overlaps it", () => {
    expect(scan("SSN 123-45-6789").map((f) => f.kind)).toEqual(["secret"]);
  });

  it("leaves year ranges alone", () => {
    expect(scan("at CMU 2019-2023")).toEqual([]);
  });
});

describe("describeFinding", () => {
  it("gives the line, column and four words each side, with none of the secret", () => {
    const secret = "ghp_" + chars(36);
    const text = `first line\none two three four five my token is ${secret} and then six seven eight nine`;
    const [f] = scan(text);
    const d = describeFinding(text, f!);
    expect(d).toEqual({ label: "GitHub token", kind: "secret", line: 2, column: 37, context: "five my token is ••• and then six seven" });
    expect(JSON.stringify(d)).not.toContain(secret.slice(4, 10));
  });
});

describe("describeAll", () => {
  it("masks every finding in every context, so a contact never shows the secret beside it", () => {
    const secret = "ghp_" + chars(36);
    const text = `my token is ${secret}, mail lin@example.edu now`;
    const d = describeAll(text, scan(text));
    expect(d.map((x) => x.context)).toEqual(["my token is •••, mail ••• now", "token is •••, mail ••• now"]);
  });
});

describe("clean", () => {
  const secret = "ghp_" + chars(36);

  it("refuses typed text with a secret, listing what it found", () => {
    expect(() => clean(`token ${secret}`, "refuse")).toThrow(SecretFoundError);
    try {
      clean(`token ${secret}`, "refuse");
    } catch (e) {
      const err = e as SecretFoundError;
      expect(err.findings.map((f) => f.label)).toEqual(["GitHub token"]);
      expect(err.message).toContain("GitHub token");
      expect(err.message).toContain("never needs");
      expect(err.message).not.toContain(secret.slice(4));
    }
  });

  it("cuts secrets from a source it can't refuse, and counts them", () => {
    const r = clean(`token ${secret} and me@example.com`, "cut");
    expect(r.text).toBe("token [removed] and [removed]");
    expect(r.cut).toEqual({ secrets: [{ label: "GitHub token", count: 1 }], contacts: 1 });
  });

  it("always cuts contacts, even when refusing secrets", () => {
    expect(clean("write to me@example.com", "refuse")).toEqual({ text: "write to [removed]", cut: { secrets: [], contacts: 1 } });
  });

  it("removes emails, phone numbers and street addresses, and keeps years and counts", () => {
    const r = clean("Mail me at lin.q@example.edu or call +1 (412) 555-0199.\nI live at 5000 Forbes Avenue, Pittsburgh.\nI started in 2019 and wrote 3 papers.", "refuse");
    expect(r.text).toBe("Mail me at [removed] or call [removed].\nI live at [removed], Pittsburgh.\nI started in 2019 and wrote 3 papers.");
    expect(r.cut.contacts).toBe(3);
  });

  it("finds nothing left in text it already cut", () => {
    const once = clean(`password: Hunter2! token ${secret} pin "4821" me@example.com`, "cut").text;
    expect(scan(once)).toEqual([]);
  });

  it("returns clean text unchanged", () => {
    expect(clean("I study at CMU.", "refuse")).toEqual({ text: "I study at CMU.", cut: { secrets: [], contacts: 0 } });
  });
});

describe("contact patterns don't eat dates and ids", () => {
  const contactsIn = (text: string) => scan(text).filter((f) => f.kind === "contact").map((f) => text.slice(f.start, f.end));

  it.each(["on 2026-10-22", "arXiv 2511.02599", "model claude-haiku-4-5-20251001", "pkg qrcode-terminal@0.12.0", "from 2019 to 2023"])(
    "leaves %s alone",
    (text) => {
      expect(contactsIn(text)).toEqual([]);
    },
  );

  it.each([
    ["call (412) 555-0100 today", "(412) 555-0100"],
    ["call 412-555-0100 today", "412-555-0100"],
    ["call +44 20 7946 0958 today", "+44 20 7946 0958"],
    ["call 13812345678 today", "13812345678"],
  ])("finds the phone number in %s", (text, phone) => {
    expect(contactsIn(text)).toEqual([phone]);
  });
});
