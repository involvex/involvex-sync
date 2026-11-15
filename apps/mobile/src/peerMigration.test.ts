/// <reference types="bun" />
import { describe, expect, test } from "bun:test";
import { foldLegacyPeer } from "./peerMigration";

function peer(id: string, name = id) {
  return {
    deviceId: id,
    name,
    deviceType: "windows",
    ed25519PublicKey: `ed-${id}`,
    x25519PublicKey: `x-${id}`,
  };
}

describe("foldLegacyPeer", () => {
  test("folds the legacy singleton into an empty peers list", () => {
    const result = foldLegacyPeer([], peer("legacy-pc", "Desk"));
    expect(result.migrated).toBe(true);
    expect(result.peers).toEqual([peer("legacy-pc", "Desk")]);
  });

  test("does not duplicate a peer already present in the list", () => {
    const result = foldLegacyPeer(
      [peer("same", "Desk")],
      peer("same", "Desk old"),
    );
    expect(result.migrated).toBe(false);
    expect(result.peers).toEqual([peer("same", "Desk")]);
  });

  test("appends a distinct legacy peer alongside existing ones", () => {
    const result = foldLegacyPeer([peer("a", "Phone")], peer("b", "Laptop"));
    expect(result.migrated).toBe(true);
    expect(result.peers.map((p) => p.deviceId)).toEqual(["a", "b"]);
  });

  test("ignores null, undefined and missing deviceId", () => {
    expect(foldLegacyPeer([peer("a")], null).migrated).toBe(false);
    expect(foldLegacyPeer([peer("a")], undefined).migrated).toBe(false);
    expect(
      foldLegacyPeer([peer("a")], {
        deviceId: "",
        name: "x",
        deviceType: "windows",
        ed25519PublicKey: "e",
        x25519PublicKey: "x",
      }).migrated,
    ).toBe(false);
  });
});
