import { describe, expect, test } from "bun:test";
import { looksLikeUrl, parseAllowedUrl } from "./url";

describe("parseAllowedUrl", () => {
  test("accepts https", () => {
    expect(parseAllowedUrl("https://github.com/involvex")).toBe(
      "https://github.com/involvex",
    );
  });

  test("accepts http", () => {
    expect(parseAllowedUrl("http://example.com/path?q=1")).toBe(
      "http://example.com/path?q=1",
    );
  });

  test("extracts url from surrounding text", () => {
    expect(parseAllowedUrl("check this https://kde.org/connect please")).toBe(
      "https://kde.org/connect",
    );
  });

  test("rejects javascript", () => {
    expect(parseAllowedUrl("javascript:alert(1)")).toBeNull();
  });

  test("rejects file scheme", () => {
    expect(parseAllowedUrl("file:///etc/passwd")).toBeNull();
  });

  test("rejects intent scheme", () => {
    expect(
      parseAllowedUrl("intent://scan/#Intent;scheme=zxing;end"),
    ).toBeNull();
  });

  test("rejects credentials in url", () => {
    expect(parseAllowedUrl("https://user:pass@evil.com")).toBeNull();
  });

  test("looksLikeUrl mirrors parse", () => {
    expect(looksLikeUrl("https://a.com")).toBe(true);
    expect(looksLikeUrl("not a url")).toBe(false);
  });
});
