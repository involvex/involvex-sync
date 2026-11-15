import { describe, expect, test } from "bun:test";
import {
  assertSafeScrcpyArg,
  assertSafeSerial,
  buildEsrcpyGuiArgs,
  buildEsrcpyMirrorArgs,
  buildScrcpyArgs,
  describeMirrorError,
  parseScrcpyExtraArgs,
} from "./scrcpy";

describe("assertSafeSerial", () => {
  test("accepts usb, tcp, emulator, mDNS shapes", () => {
    expect(assertSafeSerial("R58M123")).toBe("R58M123");
    expect(assertSafeSerial("192.168.1.10:5555")).toBe("192.168.1.10:5555");
    expect(assertSafeSerial("emulator-5554")).toBe("emulator-5554");
    expect(assertSafeSerial("adb-XXXX._adb-tls-connect._tcp")).toBe(
      "adb-XXXX._adb-tls-connect._tcp",
    );
  });

  test("rejects empty and metacharacters", () => {
    expect(() => assertSafeSerial("")).toThrow();
    expect(() => assertSafeSerial("a;b")).toThrow();
    expect(() => assertSafeSerial("device id")).toThrow();
  });
});

describe("parseScrcpyExtraArgs / buildScrcpyArgs", () => {
  test("splits flags and builds -s argv", () => {
    expect(parseScrcpyExtraArgs("--max-size=1024 --no-audio")).toEqual([
      "--max-size=1024",
      "--no-audio",
    ]);
    expect(
      buildScrcpyArgs({
        serial: "emulator-5554",
        extraArgs: parseScrcpyExtraArgs("--max-size=1024"),
      }),
    ).toEqual(["-s", "emulator-5554", "--max-size=1024"]);
  });

  test("supports quoted tokens", () => {
    expect(parseScrcpyExtraArgs('"--window-title=My Phone"')).toEqual([
      "--window-title=My Phone",
    ]);
  });

  test("rejects unsafe args", () => {
    expect(() => assertSafeScrcpyArg("foo;bar")).toThrow();
    expect(() => parseScrcpyExtraArgs("--foo;rm")).toThrow();
  });

  test("escrcpy mirror / gui argv", () => {
    expect(
      buildEsrcpyMirrorArgs({ serial: "R58", extraArgs: ["--no-audio"] }),
    ).toEqual(["mirror", "R58", "--no-audio"]);
    expect(buildEsrcpyGuiArgs("R58")).toEqual(["--device-id=R58"]);
  });
});

describe("describeMirrorError", () => {
  test("maps common failures", () => {
    expect(describeMirrorError("scrcpy already running — stop it first")).toBe(
      "Mirror already running — stop it first",
    );
    expect(describeMirrorError("unsafe serial rejected")).toBe(
      "Invalid device serial",
    );
  });
});
