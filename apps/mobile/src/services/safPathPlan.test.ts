import { describe, expect, test } from "bun:test";
import { planSafSave, sanitizeSafName } from "./safPathPlan";

describe("sanitizeSafName", () => {
  test("keeps simple names", () => {
    expect(sanitizeSafName("a.pdf")).toBe("a.pdf");
    expect(sanitizeSafName("notes_2026")).toBe("notes_2026");
  });

  test("replaces unsafe characters", () => {
    expect(sanitizeSafName("a/b:c*.pdf")).toBe("a_b_c_.pdf");
  });

  test("empty becomes file.bin", () => {
    expect(sanitizeSafName("")).toBe("file.bin");
    expect(sanitizeSafName("...")).toBe("file.bin");
  });
});

describe("planSafSave", () => {
  test("splits dirs and basename", () => {
    expect(planSafSave("notes/2026/a.pdf", "x.bin")).toEqual({
      dirs: ["notes", "2026"],
      fileName: "a.pdf",
    });
  });

  test("invalid path falls back to root basename", () => {
    expect(planSafSave("../evil.pdf", "safe.pdf")).toEqual({
      dirs: [],
      fileName: "safe.pdf",
    });
    expect(planSafSave(undefined, "root.txt")).toEqual({
      dirs: [],
      fileName: "root.txt",
    });
  });

  test("depth cap falls back", () => {
    expect(planSafSave("a/b/c/d/e/f/g/h/i.pdf", "fallback.pdf")).toEqual({
      dirs: [],
      fileName: "fallback.pdf",
    });
  });
});
