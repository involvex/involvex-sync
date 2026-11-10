import { describe, expect, test } from "bun:test";
import {
  describeAdbError,
  describeResolution,
  deviceLabel,
  isUsableForCapture,
  parseAdbDevices,
  resolveSerial,
  type AdbDevice,
} from "./adbDevices";

const RAW = `List of devices attached
adb-HULFY5WW8H5H5DOF-ibBWk9._adb-tls-connect._tcp	device product:mithorium model:Pixel_7 device:pixel transport_id:3
* daemon not running; starting now at tcp:5037
* daemon started successfully
`;

const RAW_MIXED = `List of devices attached
1KEHQ9RK9G	device usb:2-3 product:mithorium model:Pixel_7 device:pixel transport_id:1
192.168.1.51:5555	offline transport_id:2
emulator-5554	device product:sdk_google_phone_x86 model:sdk_google_phone_x86 device:emu64x transport_id:4
adb-1a2b3c4d-_adb-tls-connect._tcp	unauthorized transport_id:5
ABCD00001234	no permissions (user in plugdev group; see [USB troubleshooting])
`;

function serial(raw: string): string {
  const found = parseAdbDevices(raw).find((d) => d.serial === "1KEHQ9RK9G");
  return found?.state ?? "";
}

describe("parseAdbDevices", () => {
  test("parses an mDNS/TLS device and ignores daemon noise", () => {
    const devices = parseAdbDevices(RAW);
    expect(devices).toHaveLength(1);
    const d = devices[0];
    expect(d.serial).toBe("adb-HULFY5WW8H5H5DOF-ibBWk9._adb-tls-connect._tcp");
    expect(d.state).toBe("device");
    expect(d.transportKind).toBe("tls");
    expect(d.model).toBe("Pixel_7");
    expect(d.device).toBe("pixel");
    expect(d.transportId).toBe("3");
  });

  test("classifies transports from serial shape and props", () => {
    const bySerial = new Map(
      parseAdbDevices(RAW_MIXED).map((d) => [d.serial, d]),
    );
    expect(bySerial.get("1KEHQ9RK9G")?.transportKind).toBe("usb");
    expect(bySerial.get("1KEHQ9RK9G")?.usb).toBe("2-3");
    expect(bySerial.get("192.168.1.51:5555")?.transportKind).toBe("tcp");
    expect(bySerial.get("emulator-5554")?.transportKind).toBe("emulator");
    expect(
      bySerial.get("adb-1a2b3c4d-_adb-tls-connect._tcp")?.transportKind,
    ).toBe("tls");
  });

  test("keeps multi-word states intact", () => {
    expect(serial(RAW_MIXED)).toBe("device");
    const devices = parseAdbDevices(RAW_MIXED);
    expect(devices.find((d) => d.serial === "192.168.1.51:5555")?.state).toBe(
      "offline",
    );
    expect(
      devices.find((d) => d.serial === "adb-1a2b3c4d-_adb-tls-connect._tcp")
        ?.state,
    ).toBe("unauthorized");
    expect(devices.find((d) => d.serial === "ABCD00001234")?.state).toBe(
      "no permissions (user in plugdev group; see [USB troubleshooting])",
    );
  });

  test("returns nothing for empty or header-only output", () => {
    expect(parseAdbDevices("")).toEqual([]);
    expect(parseAdbDevices("List of devices attached\n")).toEqual([]);
  });
});

describe("isUsableForCapture", () => {
  test("only fully-booted devices pass", () => {
    const usable = parseAdbDevices(RAW_MIXED).filter(isUsableForCapture);
    expect(usable.map((d) => d.serial)).toEqual([
      "1KEHQ9RK9G",
      "emulator-5554",
    ]);
  });
});

describe("deviceLabel", () => {
  test("shows model and transport, state only when unusable", () => {
    const devices = parseAdbDevices(RAW_MIXED);
    expect(deviceLabel(devices[0])).toBe("Pixel_7 · USB");
    expect(deviceLabel(devices[1])).toBe("192.168.1.51:5555 · Wi-Fi · offline");
  });
});

describe("resolveSerial", () => {
  const usable: AdbDevice = {
    serial: "S1",
    state: "device",
    transportKind: "usb",
  };
  const extra: AdbDevice = {
    serial: "S2",
    state: "device",
    transportKind: "tcp",
  };
  const offline: AdbDevice = {
    serial: "S3",
    state: "offline",
    transportKind: "usb",
  };

  test("prefers the saved serial even with several devices", () => {
    const res = resolveSerial([usable, extra], { preferred: "S2" });
    expect(res).toEqual({ serial: "S2", reason: "ok", staleSetting: false });
  });

  test("falls back to ANDROID_SERIAL when the saved serial is gone", () => {
    const res = resolveSerial([usable, extra], {
      preferred: "stale-mdns-serial",
      envSerial: "S2",
    });
    expect(res.serial).toBe("S2");
    expect(res.reason).toBe("ok");
    expect(res.staleSetting).toBe(true);
  });

  test("ignores an unusable saved serial without flagging staleness twice", () => {
    const res = resolveSerial([offline, usable], {
      preferred: "S3",
      envSerial: "S1",
    });
    // S3 exists but is offline → falls through; staleSetting reports it.
    expect(res.serial).toBe("S1");
    expect(res.staleSetting).toBe(true);
  });

  test("auto-picks the single usable device", () => {
    const res = resolveSerial([usable, offline]);
    expect(res).toEqual({
      serial: "S1",
      reason: "ok",
      staleSetting: false,
    });
  });

  test("reports ambiguity with several usable devices and no hint", () => {
    expect(resolveSerial([usable, extra])).toEqual({
      serial: null,
      reason: "ambiguous",
      staleSetting: false,
    });
  });

  test("reports no device, offline and unauthorized", () => {
    expect(resolveSerial([])).toEqual({
      serial: null,
      reason: "no-device",
      staleSetting: false,
    });
    expect(resolveSerial([offline]).reason).toBe("offline");
    expect(
      resolveSerial([{ ...usable, state: "unauthorized", serial: "S9" }])
        .reason,
    ).toBe("unauthorized");
    expect(
      resolveSerial([{ ...usable, state: "no permissions", serial: "S8" }])
        .reason,
    ).toBe("unauthorized");
  });
});

describe("describeResolution", () => {
  test("returns a message for every failure reason", () => {
    expect(
      describeResolution({
        serial: null,
        reason: "no-device",
        staleSetting: false,
      }),
    ).toContain("No adb device");
    expect(
      describeResolution({
        serial: null,
        reason: "ambiguous",
        staleSetting: false,
      }),
    ).toContain("Multiple devices");
    expect(
      describeResolution({ serial: "S1", reason: "ok", staleSetting: false }),
    ).toBe("");
  });
});

describe("describeAdbError", () => {
  test("maps adb spawn failure to a PATH hint", () => {
    expect(describeAdbError("adb spawn: program not found")).toContain(
      "adb not found on PATH",
    );
  });

  test("maps the common failures to actionable text", () => {
    expect(describeAdbError("adb screencap timeout (20s)")).toContain(
      "timed out",
    );
    expect(describeAdbError("adb: more than one device/emulator")).toContain(
      "Multiple adb devices",
    );
    expect(describeAdbError("error: no devices/emulators found")).toContain(
      "No adb device found",
    );
    expect(describeAdbError("adb: device unauthorized")).toContain(
      "unauthorized",
    );
    expect(describeAdbError("error: device offline")).toContain("offline");
    expect(describeAdbError("adb screencap: not a PNG (0 bytes) ")).toContain(
      "no image",
    );
  });

  test("strips the adb prefix and keeps the rest", () => {
    expect(describeAdbError("adb shell: closed")).toContain("replug");
    expect(describeAdbError("adb exec-out: broken pipe")).toBe("broken pipe");
  });

  test("survives empty and non-string errors", () => {
    expect(describeAdbError("")).toBe("adb failed");
    expect(describeAdbError(undefined)).toBe("adb failed");
    expect(describeAdbError(new Error("adb: device offline"))).toContain(
      "offline",
    );
  });
});
