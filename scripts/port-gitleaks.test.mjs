import { describe, expect, it } from "vitest";
import { parseGitleaksToml, port, toJs } from "./port-gitleaks.mjs";

describe("toJs", () => {
  it("turns a leading flag switch into a modifier group over the whole pattern", () => {
    expect(toJs("(?i)abc")).toBe("(?i:abc)");
    expect(new RegExp(toJs("(?i)abc")).test("ABC")).toBe(true);
  });

  it("closes a mid-pattern flag switch where its group ends", () => {
    const js = toJs(String.raw`\b(LTAI(?i)[a-z0-9]{4})x`);
    expect(js).toBe(String.raw`\b(LTAI(?i:[a-z0-9]{4}))x`);
    const re = new RegExp(js);
    expect(re.test("LTAIabCDx")).toBe(true);
    expect(re.test("ltaiabcdx")).toBe(false);
    expect(re.test("LTAIabcdX")).toBe(false);
  });

  it("spells out POSIX classes, renames named groups and maps \\z", () => {
    expect(toJs(String.raw`pat[[:alnum:]]{2}\z`)).toBe(String.raw`pat[a-zA-Z0-9]{2}$`);
    expect(toJs("(?P<alg>x)")).toBe("(?<alg>x)");
  });

  it("escapes a ] that opens a character class", () => {
    const js = toJs(String.raw`[^:]+:\[[^]]+]`);
    expect(new RegExp(js).test("a:[b]")).toBe(true);
    expect(new RegExp(js).test("a:[]")).toBe(false);
  });

  it("leaves a flag switch inside a character class alone", () => {
    expect(toJs("[(?i)]")).toBe("[(?i)]");
  });
});

describe("port", () => {
  const toml = `
title = "t"
[allowlist]
paths = [
    '''x''',
]
stopwords = [
    "abcdefghijklmnopqrstuvwxyz",
]

[[rules]]
id = "demo-key"
description = "d"
regex = '''\\b(demo_[a-z]{4})\\b'''
entropy = 2
keywords = ["DEMO_"]

[[rules.allowlists]]
regexes = [
    '''.+EXAMPLE$''',
]

[[rules]]
id = "file-only"
description = "d"
path = '''\\.p12$'''

[[rules]]
id = "yaml-only"
description = "d"
regex = '''x'''
path = '''\\.ya?ml$'''
`;

  it("reads tables, literals, numbers and multi-line arrays", () => {
    const parsed = parseGitleaksToml(toml);
    expect(parsed.rules).toHaveLength(3);
    expect(parsed.rules[0]).toMatchObject({ id: "demo-key", entropy: 2, keywords: ["DEMO_"] });
    expect(parsed.rules[0].allowlists[0].regexes).toEqual([".+EXAMPLE$"]);
    expect(parsed.allowlist.stopwords).toEqual(["abcdefghijklmnopqrstuvwxyz"]);
  });

  it("keeps text rules, drops path rules, and lower-cases keywords", () => {
    const { rules, global, dropped } = port(toml);
    expect(rules).toEqual([
      { id: "demo-key", regex: String.raw`\b(demo_[a-z]{4})\b`, keywords: ["demo_"], entropy: 2, allowlists: [{ target: "secret", regexes: [".+EXAMPLE$"], stopwords: [] }] },
    ]);
    expect(global).toEqual({ target: "secret", regexes: [], stopwords: ["abcdefghijklmnopqrstuvwxyz"] });
    expect(dropped.map((d) => d.id)).toEqual(["file-only", "yaml-only"]);
  });
});
