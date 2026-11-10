import { describe, expect, test } from "bun:test";
import {
  guessSelfId,
  normalizePairId,
  resolveDeviceId,
  sanitizeId,
} from "./index";

const room = (...ids: string[]) =>
  new Map<string, WebSocket>(ids.map((id) => [id, {} as WebSocket]));

describe("sanitizeId", () => {
  test("accepts plain device ids", () => {
    expect(sanitizeId("abc123")).toBe("abc123");
    expect(sanitizeId("  abc123  ")).toBe("abc123");
  });

  test("rejects colons so a socket cannot claim the other pair half", () => {
    expect(sanitizeId("a:b")).toBe("");
    expect(sanitizeId("")).toBe("");
    expect(sanitizeId("   ")).toBe("");
    expect(sanitizeId("x".repeat(201))).toBe("");
  });
});

describe("normalizePairId", () => {
  test("a:b and b:a map to the same room", () => {
    expect(normalizePairId("a:b")).toBe("a:b");
    expect(normalizePairId("b:a")).toBe("a:b");
  });

  test("passes single ids and malformed values through", () => {
    expect(normalizePairId("solo")).toBe("solo");
    expect(normalizePairId("a:b:c")).toBe("a:b:c");
  });
});

describe("resolveDeviceId", () => {
  test("accepts self when it is one of the two pair halves", () => {
    expect(resolveDeviceId("a:b", "b", room())).toBe("b");
    expect(resolveDeviceId("a:b", "a", room("a"))).toBe("a");
    expect(resolveDeviceId("b:a", "a", room())).toBe("a");
  });

  test("rejects a self outside the pair so a third session cannot join", () => {
    // The whole point of the check: `c` must never become a room member.
    expect(resolveDeviceId("a:b", "c", room())).toBe("a");
    expect(resolveDeviceId("a:b", "c", room("a"))).toBe("b");
    expect(resolveDeviceId("a:b", "c", room("a", "b"))).toBe("a");
  });

  test("falls back to the guess when self is missing or unusable", () => {
    expect(resolveDeviceId("a:b", null, room())).toBe("a");
    expect(resolveDeviceId("a:b", "a:b", room())).toBe("a"); // colon → rejected
    expect(resolveDeviceId("a:b", "", room())).toBe("a");
  });

  test("single-id rooms require an exact self match", () => {
    expect(resolveDeviceId("solo", "solo", room())).toBe("solo");
    expect(resolveDeviceId("solo", "other", room())).toBe("solo");
    expect(resolveDeviceId("solo", null, room())).toBe("solo");
  });
});

describe("guessSelfId (legacy fallback)", () => {
  test("first connector takes the free half", () => {
    expect(guessSelfId("a:b", room())).toBe("a");
    expect(guessSelfId("a:b", room("a"))).toBe("b");
  });

  test("reconnect while the peer is absent takes the wrong slot", () => {
    // This is exactly the mislabel the `self=` parameter fixes: A reconnects
    // while B is not in the room, so A is registered as B.
    expect(guessSelfId("a:b", room("a"))).toBe("b");
  });

  test("when both halves are present the first wins", () => {
    expect(guessSelfId("a:b", room("a", "b"))).toBe("a");
  });

  test("single-id pairs are returned unchanged", () => {
    expect(guessSelfId("solo", room())).toBe("solo");
    expect(guessSelfId("", room())).toBe("");
  });
});
