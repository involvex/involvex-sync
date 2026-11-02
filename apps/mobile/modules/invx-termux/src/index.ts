import { PermissionsAndroid, Platform } from "react-native";
import { requireNativeModule } from "expo-modules-core";
import {
  TERMUX_PACKAGE,
  TERMUX_RUN_COMMAND_ACTION,
  TERMUX_RUN_COMMAND_PERMISSION,
  TERMUX_RUN_COMMAND_SERVICE,
  type TermuxRunCommandSpec,
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
  }): Promise<boolean>;
};

let native: InvxTermuxNative | null = null;

try {
  native = requireNativeModule<InvxTermuxNative>("InvxTermux");
} catch {
  native = null;
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

export async function startTermuxRunCommand(
  spec: TermuxRunCommandSpec,
): Promise<boolean> {
  if (!native) {
    throw new Error("InvxTermux native module unavailable — rebuild the app");
  }
  const ok = await ensureTermuxRunCommandPermission();
  if (!ok) return false;

  return native.startRunCommand({
    action: TERMUX_RUN_COMMAND_ACTION,
    packageName: TERMUX_PACKAGE,
    serviceClass: TERMUX_RUN_COMMAND_SERVICE,
    commandPath: spec.commandPath,
    args: spec.arguments ?? [],
    workdir: spec.workdir ?? null,
    background: spec.background ?? true,
    label: spec.label ?? null,
  });
}
