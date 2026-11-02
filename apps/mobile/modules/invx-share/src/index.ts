import { requireNativeModule } from "expo-modules-core";

type SharePayload = { text: string };

type Subscription = { remove: () => void };

type InvxShareNative = {
  getSharedText(): Promise<string | null>;
  clearSharedText(): Promise<void>;
  addListener(
    event: "onShareText",
    listener: (event: SharePayload) => void,
  ): Subscription;
};

let native: InvxShareNative | null = null;

try {
  native = requireNativeModule<InvxShareNative>("InvxShare");
} catch {
  native = null;
}

export async function getSharedText(): Promise<string | null> {
  if (!native) return null;
  return native.getSharedText();
}

export async function clearSharedText(): Promise<void> {
  if (!native) return;
  await native.clearSharedText();
}

export function addShareListener(listener: (text: string) => void): {
  remove: () => void;
} {
  if (!native?.addListener) {
    return { remove: () => undefined };
  }
  return native.addListener("onShareText", (event) => {
    listener(event.text);
  });
}
