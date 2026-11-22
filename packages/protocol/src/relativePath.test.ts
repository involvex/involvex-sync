import { describe, expect, test } from "bun:test";
import {
  flattenRelativePath,
  normalizeRelativePath,
  parseRelativePathSegments,
  relativePathBasename,
  relativePathDirSegments,
} from "./relativePath";

describe("relativePath", () => {
  test("accepts nested paths", () => {
    expect(parseRelativePathSegments("notes/2026/a.pdf")).toEqual([
      "notes",
      "2026",
      "a.pdf",
    ]);
    expect(normalizeRelativePath("notes\\2026\\a.pdf")).toBe(
      "notes/2026/a.pdf",
    );
    expect(relativePathBasename("notes/2026/a.pdf")).toBe("a.pdf");
    expect(relativePathDirSegments("notes/2026/a.pdf")).toEqual([
      "notes",
      "2026",
    ]);
    expect(flattenRelativePath("notes/2026/a.pdf")).toBe("notes__2026__a.pdf");
  });

  test("root file is a single segment", () => {
    expect(normalizeRelativePath("a.pdf")).toBe("a.pdf");
    expect(relativePathDirSegments("a.pdf")).toEqual([]);
  });

  test("rejects traversal and absolute paths", () => {
    expect(normalizeRelativePath("../a.pdf")).toBeUndefined();
    expect(normalizeRelativePath("/a.pdf")).toBeUndefined();
    expect(normalizeRelativePath("C:/a.pdf")).toBeUndefined();
    expect(normalizeRelativePath("notes/../a.pdf")).toBeUndefined();
    expect(normalizeRelativePath("notes//a.pdf")).toBe("notes/a.pdf");
  });

  test("rejects over-deep paths", () => {
    expect(normalizeRelativePath("a/b/c/d/e/f/g/h/i.pdf")).toBeUndefined();
    expect(normalizeRelativePath("a/b/c/d/e/f/g/h.pdf")).toBe(
      "a/b/c/d/e/f/g/h.pdf",
    );
  });

  test("missing or empty yields undefined", () => {
    expect(normalizeRelativePath(undefined)).toBeUndefined();
    expect(normalizeRelativePath("")).toBeUndefined();
    expect(normalizeRelativePath("   ")).toBeUndefined();
  });
});
