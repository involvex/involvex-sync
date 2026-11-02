import { requireNativeModule } from "expo-modules-core";

type SharePayload = { text: string };
type ShareFilesPayload = {
  files: Array<{ uri: string; name: string; mimeType: string }>;
};

type Subscription = { remove: () => void };

type SharedFileBytes = {
  name: string;
  mimeType: string;
  size: number;
  dataBase64: string;
};

type InvxShareNative = {
  getSharedText(): Promise<string | null>;
  clearSharedText(): Promise<void>;
  getSharedFiles(): Promise<
    Array<{ uri: string; name: string; mimeType: string }>
  >;
  clearSharedFiles(): Promise<void>;
  readSharedFileBase64(uri: string, maxBytes: number): Promise<SharedFileBytes>;
  addListener(
    event: "onShareText",
    listener: (event: SharePayload) => void,
  ): Subscription;
  addListener(
    event: "onShareFiles",
    listener: (event: ShareFilesPayload) => void,
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

export async function getSharedFiles(): Promise<
  Array<{ uri: string; name: string; mimeType: string }>
> {
  if (!native) return [];
  return native.getSharedFiles();
}

export async function clearSharedFiles(): Promise<void> {
  if (!native) return;
  await native.clearSharedFiles();
}

export async function readSharedFileBase64(
  uri: string,
  maxBytes: number,
): Promise<SharedFileBytes> {
  if (!native) throw new Error("InvxShare unavailable");
  return native.readSharedFileBase64(uri, maxBytes);
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

export function addShareFilesListener(
  listener: (
    files: Array<{ uri: string; name: string; mimeType: string }>,
  ) => void,
): { remove: () => void } {
  if (!native?.addListener) {
    return { remove: () => undefined };
  }
  return native.addListener("onShareFiles", (event) => {
    listener(event.files);
  });
}
