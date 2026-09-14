import { describe, expect, it } from "vitest";
import { redactSensitiveText } from "../plugin-sdk/security-runtime.js";
import { replaceRedactPattern, visitRedactMatches } from "./redact-pattern-runtime.js";
import { redactInputTextWithSourcePolicy, redactText } from "./redact.js";

describe("nested redaction calls", () => {
  it.each([false, true])(
    "keeps nested matcher input and pattern order (fullContext=%s)",
    (fullContext) => {
      const inputs: string[] = [];
      const nested: string[] = [];
      const matcher = {
        source: "bracketed fixture values",
        *exec(input: string) {
          inputs.push(input);
          for (const match of input.matchAll(/\[(outer-[a-z]+)\]/g)) {
            nested.push(redactSensitiveText("inside private", { patterns: [/private/g] }));
            yield { match: match[0], groups: [match[1] ?? ""], input, offset: match.index };
          }
        },
      };

      const input = "prefix [outer-one] [outer-two] suffix";
      const patterns = [/prefix/g, matcher, /suffix/g];
      expect(
        fullContext
          ? redactText(input, patterns, { fullContext })
          : redactSensitiveText(input, { patterns }),
      ).toBe("*** [***] [***] ***");
      expect(inputs).toEqual(["*** [outer-one] [outer-two] suffix"]);
      expect(nested).toEqual(["inside ***", "inside ***"]);
    },
  );

  it("keeps each source assignment policy active after it performs nested redaction", () => {
    const input = "API_TOKEN=computeFirst()\nAPI_TOKEN=computeSecond()";
    const assignments: string[] = [];

    expect(
      redactInputTextWithSourcePolicy(input, undefined, (text, offset) => {
        expect(redactSensitiveText("inside private", { patterns: [/private/g] })).toBe(
          "inside ***",
        );
        assignments.push(text.slice(offset).split("\n")[0] ?? "");
        return true;
      }),
    ).toBe(input);
    expect(assignments).toEqual(expect.arrayContaining(["computeFirst()", "computeSecond()"]));
  });
});

describe("synchronous redaction match visitors", () => {
  it.each(["", "g", "y"])("preserves capture offsets and caller state with flags %s", (flags) => {
    const pattern = new RegExp("(a)|(b)", flags);
    pattern.lastIndex = 7;
    const matches: { match: string; groups: string[]; input: string; offset: number }[] = [];

    visitRedactMatches("ab", pattern, (match) => matches.push(match));

    expect(matches).toEqual([
      { match: "a", groups: ["a", ""], input: "ab", offset: 0 },
      { match: "b", groups: ["", "b"], input: "ab", offset: 1 },
    ]);
    expect(pattern.lastIndex).toBe(7);
  });

  it.each([
    { flags: "g", offsets: [0, 1, 2] },
    { flags: "gu", offsets: [0, 2] },
    { flags: "gv", offsets: [0, 2] },
  ])("advances empty matches according to $flags", ({ flags, offsets }) => {
    const matches: number[] = [];
    visitRedactMatches("😀x", new RegExp("(?=.)", flags), (match) => matches.push(match.offset));
    expect(matches).toEqual(offsets);
  });

  it("restores a shared expression before nested visits and after a throwing visitor", () => {
    const pattern = /a/g;
    pattern.lastIndex = 9;
    const matches: number[] = [];
    const nested: number[] = [];
    visitRedactMatches("aa", pattern, (match) => {
      expect(pattern.lastIndex).toBe(9);
      matches.push(match.offset);
      visitRedactMatches("a", pattern, (inner) => nested.push(inner.offset));
    });
    expect(matches).toEqual([0, 1]);
    expect(nested).toEqual([0, 0]);
    expect(() =>
      visitRedactMatches("a", pattern, () => {
        pattern.lastIndex = 13;
        throw new Error("visitor stopped");
      }),
    ).toThrow("visitor stopped");
    expect(pattern.lastIndex).toBe(13);
  });

  it("closes a programmatic matcher when replacement throws", () => {
    let closed = false;
    const pattern = {
      source: "fixture matcher",
      *exec(input: string) {
        try {
          yield { match: input, groups: [], input, offset: 0 };
        } finally {
          closed = true;
        }
      },
    };
    expect(() =>
      replaceRedactPattern("fixture", pattern, () => {
        throw new Error("replacement stopped");
      }),
    ).toThrow("replacement stopped");
    expect(closed).toBe(true);
  });
});
