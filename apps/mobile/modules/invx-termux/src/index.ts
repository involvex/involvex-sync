import { PermissionsAndroid, Platform } from "react-native";
import { requireNativeModule } from "expo";
import {
  TERMUX_API_PACKAGE,
  TERMUX_PACKAGE,
  TERMUX_RUN_COMMAND_ACTION,
  TERMUX_RUN_COMMAND_PERMISSION,
  TERMUX_RUN_COMMAND_SERVICE,
  TERMUX_SETUP_HINT,
  termuxRequestNeedsApi,
  type TermuxRequest,
  type TermuxRunCommandSpec,
  type TermuxRunResult,
} from "../../../src/termux";

type InvxTermuxNative = {
  startRunCommand(spec: {
    action: string;
    packageName: string;
    serviceClass: string;
    commandPath: string;
    args: string[];
    workdir: string | null;
    background: boolean;
    label: string | null;
    stdin: string | null;
    timeoutMs: number;
  }): Promise<TermuxRunResult | boolean>;
  isPackageInstalled(packageName: string): Promise<boolean>;
};

let native: InvxTermuxNative | null = null;

try {
  native = requireNativeModule<InvxTermuxNative>("InvxTermux");
} catch {
  native = null;
}

export { TERMUX_API_PACKAGE, TERMUX_PACKAGE, TERMUX_SETUP_HINT };
export type { TermuxRunResult };

function normalizeResult(raw: TermuxRunResult | boolean): TermuxRunResult {
  if (typeof raw === "boolean") {
    return {
      ok: raw,
      exitCode: raw ? 0 : 1,
      stdout: raw ? "started in Termux (legacy module, no result)" : "",
      stderr: raw ? "" : "Termux RUN_COMMAND denied or failed",
      errmsg: "",
    };
  }
  return {
    ok: Boolean(raw.ok),
    exitCode: Number(raw.exitCode ?? -1),
    stdout: String(raw.stdout ?? ""),
    stderr: String(raw.stderr ?? ""),
    errmsg: String(raw.errmsg ?? ""),
    termuxPackage:
      typeof raw.termuxPackage === "string" ? raw.termuxPackage : undefined,
    commandPath:
      typeof raw.commandPath === "string" ? raw.commandPath : undefined,
  };
}

export async function isTermuxInstalled(): Promise<boolean> {
  if (Platform.OS !== "android" || !native) return false;
  return native.isPackageInstalled(TERMUX_PACKAGE);
}

export async function isTermuxApiInstalled(): Promise<boolean> {
  if (Platform.OS !== "android" || !native) return false;
  return native.isPackageInstalled(TERMUX_API_PACKAGE);
}

export async function ensureTermuxRunCommandPermission(): Promise<boolean> {
  if (Platform.OS !== "android") return false;
  const granted = await PermissionsAndroid.check(
    TERMUX_RUN_COMMAND_PERMISSION as never,
  );
  if (granted) return true;
  const result = await PermissionsAndroid.request(
    TERMUX_RUN_COMMAND_PERMISSION as never,
    {
      title: "Termux command access",
      message:
        "involvex Sync needs permission to run allowlisted commands in Termux.",
      buttonPositive: "Allow",
      buttonNegative: "Deny",
    },
  );
  return result === PermissionsAndroid.RESULTS.GRANTED;
}

/**
 * Run an allowlisted Termux command. Pass `needsApi` (or a TermuxRequest)
 * when the command uses termux-toast / termux-open-url / clipboard-set so we
 * fail fast if Termux:API is missing instead of waiting for the timeout.
 */
export async function startTermuxRunCommand(
  spec: TermuxRunCommandSpec,
  opts?: { needsApi?: boolean; request?: TermuxRequest },
): Promise<TermuxRunResult> {
  if (!native) {
    throw new Error("InvxTermux native module unavailable — rebuild the app");
  }
  if (!(await isTermuxInstalled())) {
    throw new Error(
      `Termux not installed (${TERMUX_PACKAGE}). Install InVx Termux.`,
    );
  }
  const needsApi =
    opts?.needsApi === true ||
    (opts?.request != null && termuxRequestNeedsApi(opts.request)) ||
    spec.commandPath.includes("termux-clipboard-set") ||
    (spec.stdin?.includes("termux-open-url") ?? false);
  if (needsApi && !(await isTermuxApiInstalled())) {
    return {
      ok: false,
      exitCode: 1,
      stdout: "",
      stderr: `Termux:API not installed (${TERMUX_API_PACKAGE}). Install the API APK and pkg install termux-api.`,
      errmsg: `missing ${TERMUX_API_PACKAGE}`,
    };
  }
  const permitted = await ensureTermuxRunCommandPermission();
  if (!permitted) {
    return {
      ok: false,
      exitCode: 1,
      stdout: "",
      stderr: `Termux RUN_COMMAND permission denied. ${TERMUX_SETUP_HINT}`,
      errmsg: "permission denied",
    };
  }

  const raw = await native.startRunCommand({
    action: TERMUX_RUN_COMMAND_ACTION,
    packageName: TERMUX_PACKAGE,
    serviceClass: TERMUX_RUN_COMMAND_SERVICE,
    commandPath: spec.commandPath,
    args: spec.arguments ?? [],
    workdir: spec.workdir ?? null,
    background: spec.background ?? true,
    label: spec.label ?? null,
    stdin: spec.stdin ?? null,
    timeoutMs: spec.timeoutMs ?? 20_000,
  });
  return normalizeResult(raw);
}
