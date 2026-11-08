import * as FileSystem from "expo-file-system/legacy";

export type DriveFileMeta = {
  id: string;
  name: string;
  mimeType?: string;
  modifiedTime?: string;
  size?: string;
};

async function driveFetch(
  accessToken: string,
  url: string,
  init?: RequestInit,
): Promise<Response> {
  const headers = new Headers(init?.headers);
  headers.set("Authorization", `Bearer ${accessToken}`);
  return fetch(url, { ...init, headers });
}

export async function listDriveFiles(
  accessToken: string,
  parentId?: string,
  pageSize = 20,
): Promise<DriveFileMeta[]> {
  const q = parentId?.trim()
    ? `'${parentId.trim()}' in parents and trashed = false`
    : `'root' in parents and trashed = false`;
  const params = new URLSearchParams({
    pageSize: String(pageSize),
    fields: "files(id,name,mimeType,modifiedTime,size)",
    q,
    orderBy: "modifiedTime desc",
  });
  const res = await driveFetch(
    accessToken,
    `https://www.googleapis.com/drive/v3/files?${params}`,
  );
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Drive list failed (${res.status}): ${text.slice(0, 200)}`);
  }
  const json = (await res.json()) as { files?: DriveFileMeta[] };
  return json.files ?? [];
}

/**
 * Resumable upload from a local file URI into Drive.
 */
export async function uploadLocalFile(
  accessToken: string,
  opts: {
    uri: string;
    name: string;
    mimeType?: string;
    parentId?: string;
  },
): Promise<DriveFileMeta> {
  const mimeType = opts.mimeType || "application/octet-stream";
  const metadata: Record<string, unknown> = { name: opts.name };
  const parent = opts.parentId?.trim();
  if (parent) metadata.parents = [parent];

  const start = await driveFetch(
    accessToken,
    "https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=UTF-8",
        "X-Upload-Content-Type": mimeType,
      },
      body: JSON.stringify(metadata),
    },
  );
  if (!start.ok) {
    const text = await start.text();
    throw new Error(
      `Drive upload init failed (${start.status}): ${text.slice(0, 200)}`,
    );
  }
  const sessionUrl = start.headers.get("Location");
  if (!sessionUrl) {
    throw new Error("Drive upload init missing Location header");
  }

  const uploaded = await FileSystem.uploadAsync(sessionUrl, opts.uri, {
    httpMethod: "PUT",
    uploadType: FileSystem.FileSystemUploadType.BINARY_CONTENT,
    headers: {
      "Content-Type": mimeType,
      Authorization: `Bearer ${accessToken}`,
    },
  });
  if (uploaded.status < 200 || uploaded.status >= 300) {
    throw new Error(
      `Drive upload failed (${uploaded.status}): ${uploaded.body?.slice(0, 200) ?? ""}`,
    );
  }
  try {
    return JSON.parse(uploaded.body) as DriveFileMeta;
  } catch {
    return { id: "", name: opts.name, mimeType };
  }
}

/**
 * Download a Drive file to a cache path (caller may move into SAF).
 */
export async function downloadDriveFile(
  accessToken: string,
  fileId: string,
  destUri: string,
): Promise<string> {
  const url = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media`;
  const result = await FileSystem.downloadAsync(url, destUri, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (result.status < 200 || result.status >= 300) {
    throw new Error(`Drive download failed (${result.status})`);
  }
  return result.uri;
}
