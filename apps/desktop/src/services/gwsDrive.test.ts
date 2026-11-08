import { describe, expect, test } from "bun:test";
import {
  DRIVE_PAGE_SIZE_DEFAULT,
  DRIVE_PAGE_SIZE_MAX,
  DriveQueryError,
  buildListParams,
  driveFileUrl,
  extractErrorHint,
  formatDriveSize,
  formatDriveTime,
  normalizeDriveFolderId,
  parseDriveList,
  type DriveListParams,
  type GwsCommandResult,
} from "./gwsDrive";

type ListParams = {
  pageSize: number;
  fields: string;
  orderBy: string;
  q: string;
  pageToken?: string;
};

function listParams(overrides: DriveListParams = {}): ListParams {
  return JSON.parse(buildListParams(overrides)) as ListParams;
}

function result(patch: Partial<GwsCommandResult>): GwsCommandResult {
  return {
    ok: false,
    exitCode: 1,
    stdout: "",
    stderr: "",
    ...patch,
  };
}

describe("buildListParams", () => {
  test("defaults to root scope, page size 50, newest first", () => {
    const params = listParams();
    expect(params.pageSize).toBe(DRIVE_PAGE_SIZE_DEFAULT);
    expect(params.q).toBe("'root' in parents and trashed = false");
    expect(params.orderBy).toBe("modifiedTime desc");
    expect(params.fields).toContain("nextPageToken");
    expect(params.pageToken).toBeUndefined();
  });

  test("scopes to a folder id", () => {
    const params = listParams({ folderId: " 1AbC_-xyz " });
    expect(params.q).toBe("'1AbC_-xyz' in parents and trashed = false");
  });

  test("rejects ids that would break the Drive q string", () => {
    for (const bad of ["a'b", "a b", "a/b", "a;drop", "a)b", "ü"]) {
      expect(() => buildListParams({ folderId: bad })).toThrow(DriveQueryError);
    }
  });

  test("clamps page size", () => {
    expect(listParams({ pageSize: 0 }).pageSize).toBe(1);
    expect(listParams({ pageSize: -5 }).pageSize).toBe(1);
    expect(listParams({ pageSize: 999999 }).pageSize).toBe(DRIVE_PAGE_SIZE_MAX);
    expect(listParams({ pageSize: 12.9 }).pageSize).toBe(12);
    expect(listParams({ pageSize: Number.NaN }).pageSize).toBe(
      DRIVE_PAGE_SIZE_DEFAULT,
    );
  });

  test("passes opaque page tokens through untouched", () => {
    const token = "~!!~AAf-jczdWt7H7g66vsINzvy-0UwgZ3X36ewasbpfRAC6Q4YdY7K=";
    expect(listParams({ pageToken: ` ${token} ` }).pageToken).toBe(token);
  });

  test("blank page token and orderBy fall back to defaults", () => {
    const params = listParams({ pageToken: "  ", orderBy: "  " });
    expect(params.pageToken).toBeUndefined();
    expect(params.orderBy).toBe("modifiedTime desc");
  });
});

describe("normalizeDriveFolderId", () => {
  test("passes bare ids through and trims", () => {
    expect(normalizeDriveFolderId(" 1AbC_-xyz ")).toBe("1AbC_-xyz");
  });

  test("extracts the id from a pasted folder url", () => {
    expect(
      normalizeDriveFolderId(
        "https://drive.google.com/drive/folders/1NqPEbBDjBryrtud1eQjGdds1TSqwVWVo?usp=sharing",
      ),
    ).toBe("1NqPEbBDjBryrtud1eQjGdds1TSqwVWVo");
    expect(
      normalizeDriveFolderId("https://drive.google.com/open?id=1AbC_-xyz"),
    ).toBe("1AbC_-xyz");
  });

  test("returns empty for blank or unusable input", () => {
    expect(normalizeDriveFolderId("")).toBe("");
    expect(normalizeDriveFolderId("   ")).toBe("");
    expect(normalizeDriveFolderId("not a folder id")).toBe("");
    expect(
      normalizeDriveFolderId("https://drive.google.com/drive/my-drive"),
    ).toBe("");
  });
});

describe("parseDriveList", () => {
  test("parses files, string sizes and nextPageToken", () => {
    const parsed = parseDriveList(
      JSON.stringify({
        files: [
          {
            id: "abc",
            name: "report.pdf",
            mimeType: "application/pdf",
            size: "20480",
            modifiedTime: "2026-11-08T11:18:48.913Z",
            parents: ["root"],
          },
        ],
        nextPageToken: "next-1",
      }),
    );
    expect(parsed).not.toBeNull();
    expect(parsed?.files).toHaveLength(1);
    expect(parsed?.files[0]).toEqual({
      id: "abc",
      name: "report.pdf",
      mimeType: "application/pdf",
      size: 20480,
      modifiedTime: "2026-11-08T11:18:48.913Z",
      parents: ["root"],
    });
    expect(parsed?.nextPageToken).toBe("next-1");
  });

  test("keeps Google-native files without a size", () => {
    const parsed = parseDriveList(
      JSON.stringify({
        files: [
          {
            id: "doc1",
            name: "Notes",
            mimeType: "application/vnd.google-apps.document",
          },
        ],
      }),
    );
    expect(parsed?.files[0].size).toBeUndefined();
    expect(parsed?.nextPageToken).toBeUndefined();
  });

  test("drops entries without an id and tolerates junk fields", () => {
    const parsed = parseDriveList(
      JSON.stringify({
        files: [
          { name: "no id" },
          null,
          { id: "ok", name: 42, size: "not-a-number", parents: [1, 2] },
        ],
      }),
    );
    expect(parsed?.files).toHaveLength(1);
    expect(parsed?.files[0]).toEqual({
      id: "ok",
      name: "ok",
      mimeType: "application/octet-stream",
    });
  });

  test("rejects non-JSON and shapes without a files array", () => {
    expect(parseDriveList("Using keyring backend: keyring")).toBeNull();
    expect(parseDriveList("{}")).toBeNull();
    expect(parseDriveList("[]")).toBeNull();
    expect(parseDriveList("null")).toBeNull();
  });
});

describe("driveFileUrl", () => {
  test("builds a Drive web url", () => {
    expect(driveFileUrl("1XbKwCw5sPcJlzkYV3ldcEJJqmVZuWXn3")).toBe(
      "https://drive.google.com/open?id=1XbKwCw5sPcJlzkYV3ldcEJJqmVZuWXn3",
    );
  });

  test("rejects ids with url or query syntax", () => {
    for (const bad of ["", "a b", "a@b", "a'b", "a&b", "a/b"]) {
      expect(driveFileUrl(bad)).toBeUndefined();
    }
  });
});

describe("extractErrorHint", () => {
  test("ignores the keyring banner on stderr", () => {
    const hint = extractErrorHint(
      result({
        stderr:
          "Using keyring backend: keyring\nError: insufficient authentication scopes",
      }),
    );
    expect(hint).toBe("Error: insufficient authentication scopes");
  });

  test("prefers the JSON error message from stdout", () => {
    const hint = extractErrorHint(
      result({
        stdout: JSON.stringify({ error: { message: "invalid_grant" } }),
        stderr: "Using keyring backend: keyring",
      }),
    );
    expect(hint).toBe("invalid_grant");
  });

  test("falls back to exit code when there is nothing else", () => {
    expect(
      extractErrorHint(result({ exitCode: 2, stderr: "", stdout: "" })),
    ).toBe("auth error (exit 2)");
    expect(
      extractErrorHint(result({ exitCode: 7, stderr: "", stdout: "" })),
    ).toBe("gws failed (exit 7)");
  });
});

describe("formatters", () => {
  test("formatDriveSize", () => {
    expect(formatDriveSize(undefined)).toBe("—");
    expect(formatDriveSize(0)).toBe("0 B");
    expect(formatDriveSize(1023)).toBe("1023 B");
    expect(formatDriveSize(2048)).toBe("2.0 KiB");
    expect(formatDriveSize(20 * 1024 * 1024)).toBe("20 MiB");
    expect(formatDriveSize(4985798764)).toBe("4.6 GiB");
  });

  test("formatDriveTime", () => {
    expect(formatDriveTime(undefined)).toBe("—");
    expect(formatDriveTime("not a date")).toBe("—");
    expect(formatDriveTime("2026-11-08T11:18:48.913Z")).not.toBe("—");
  });
});
