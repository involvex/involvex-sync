import { describe, expect, test } from "bun:test";
import {
  decryptFrame,
  encryptFrame,
  generateDeviceKeys,
  remoteCommandBody,
  remoteCommandResultBody,
  serializeFrame,
  parseFrame,
} from "./index";

describe("remote_command", () => {
  test("roundtrip pwsh command + result", () => {
    const a = generateDeviceKeys();
    const b = generateDeviceKeys();
    const body = remoteCommandBody(
      a.deviceId,
      {
        requestId: "req1",
        shell: "pwsh",
        command: "Get-Date",
        timeoutMs: 10_000,
      },
      b.deviceId,
    );
    expect(body).not.toBeNull();
    const frame = encryptFrame(body!, a, {
      deviceId: b.deviceId,
      ed25519PublicKey: b.ed25519.publicKey,
      x25519PublicKey: b.x25519.publicKey,
    });
    const parsed = parseFrame(serializeFrame(frame));
    expect(parsed).not.toBeNull();
    const opened = decryptFrame(parsed!, b, {
      deviceId: a.deviceId,
      ed25519PublicKey: a.ed25519.publicKey,
      x25519PublicKey: a.x25519.publicKey,
    });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    expect(opened.body.payload.type).toBe("remote_command");

    const result = remoteCommandResultBody(
      b.deviceId,
      {
        requestId: "req1",
        ok: true,
        exitCode: 0,
        stdout: "ok",
        stderr: "",
      },
      a.deviceId,
    );
    expect(result?.payload.type).toBe("remote_command_result");
  });

  test("rejects empty command", () => {
    const body = remoteCommandBody("a", {
      requestId: "x",
      shell: "pwsh",
      command: "   ",
    });
    expect(body).toBeNull();
  });
});
