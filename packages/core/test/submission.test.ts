import { describe, expect, it } from "vitest";
import { formatSubmissionIssues, parseSubmissionInput } from "../src/index.js";

describe("parseSubmissionInput", () => {
  it("accepts a minimal submission and applies defaults", () => {
    const input = parseSubmissionInput({ spec: "submission/v0", summary: "did the thing" });
    expect(input.changes).toEqual([]);
    expect(input.openQuestions).toEqual([]);
    expect(input.sessionId).toBeUndefined();
  });

  it("accepts the full payload", () => {
    const input = parseSubmissionInput({
      spec: "submission/v0",
      summary: "did the thing",
      changes: ["touched total.mjs", "added tests"],
      openQuestions: ["which registry?"],
      authorName: "bob",
      sessionId: "abc123",
    });
    expect(input.changes).toHaveLength(2);
    expect(input.authorName).toBe("bob");
  });

  it("rejects wrong spec, empty summary, and oversized lists", () => {
    expect(() => parseSubmissionInput({ spec: "submission/v9", summary: "x" })).toThrow();
    expect(() => parseSubmissionInput({ spec: "submission/v0", summary: "" })).toThrow();
    expect(() =>
      parseSubmissionInput({
        spec: "submission/v0",
        summary: "x",
        changes: Array.from({ length: 51 }, (_, index) => `change ${index}`),
      }),
    ).toThrow();
    expect(() =>
      parseSubmissionInput({
        spec: "submission/v0",
        summary: "x",
        openQuestions: Array.from({ length: 21 }, (_, index) => `question ${index}`),
      }),
    ).toThrow();
  });

  it("formats issues readably", () => {
    try {
      parseSubmissionInput({ spec: "submission/v0", summary: "" });
      throw new Error("should have thrown");
    } catch (error) {
      expect(formatSubmissionIssues(error)).toMatch(/summary/);
    }
  });
});
