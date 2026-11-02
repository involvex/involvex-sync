import { describe, expect, test } from "bun:test";
import { LoopGuard } from "./loop";

describe("LoopGuard", () => {
  test("skips outbound after remote apply", () => {
    const guard = new LoopGuard({ windowMs: 5_000 });
    const now = 1_000_000;
    guard.remember("copied text", "phone", now);
    expect(guard.shouldSkipOutbound("copied text", "desktop", now + 100)).toBe(
      true,
    );
    expect(guard.shouldSkipOutbound("other text", "desktop", now + 100)).toBe(
      false,
    );
  });

  test("expires after window", () => {
    const guard = new LoopGuard({ windowMs: 1_000 });
    const now = 1_000_000;
    guard.remember("copied text", "phone", now);
    expect(
      guard.shouldSkipOutbound("copied text", "desktop", now + 2_000),
    ).toBe(false);
  });
});
