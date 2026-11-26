import { describe, expect, test } from "bun:test";
import {
  collectWatchCandidates,
  type DirStat,
  type ListDirFn,
  type StatFn,
} from "./folderSyncHelpers";

type Node =
  | { kind: "file"; size: number; mtimeMs: number }
  | { kind: "dir"; children: Record<string, Node> };

function mockFs(root: Node & { kind: "dir" }): {
  listDir: ListDirFn;
  stat: StatFn;
} {
  const byUri = new Map<string, { name: string; node: Node }>();

  function index(uri: string, name: string, node: Node): void {
    byUri.set(uri, { name, node });
    if (node.kind === "dir") {
      for (const [childName, child] of Object.entries(node.children)) {
        index(`${uri}/${childName}`, childName, child);
      }
    }
  }
  index("content://root", "root", root);

  return {
    listDir(uri) {
      const hit = byUri.get(uri);
      if (!hit || hit.node.kind !== "dir") throw new Error("not a dir");
      return Promise.resolve(
        Object.keys(hit.node.children).map((n) => `${uri}/${n}`),
      );
    },
    stat(uri) {
      const hit = byUri.get(uri);
      if (!hit) return Promise.resolve(null);
      if (hit.node.kind === "dir") {
        return Promise.resolve({
          uri,
          name: hit.name,
          isDirectory: true,
          size: 0,
          mtimeMs: 0,
        } satisfies DirStat);
      }
      return Promise.resolve({
        uri,
        name: hit.name,
        isDirectory: false,
        size: hit.node.size,
        mtimeMs: hit.node.mtimeMs,
      });
    },
  };
}

describe("collectWatchCandidates", () => {
  test("lists root files and nested relativePath", async () => {
    const { listDir, stat } = mockFs({
      kind: "dir",
      children: {
        "root.pdf": { kind: "file", size: 10, mtimeMs: 1 },
        notes: {
          kind: "dir",
          children: {
            "2026": {
              kind: "dir",
              children: {
                "a.pdf": { kind: "file", size: 20, mtimeMs: 2 },
              },
            },
          },
        },
      },
    });

    const items = await collectWatchCandidates("content://root", listDir, stat);
    const byPath = Object.fromEntries(items.map((i) => [i.relativePath, i]));
    expect(byPath["root.pdf"]?.name).toBe("root.pdf");
    expect(byPath["notes/2026/a.pdf"]?.size).toBe(20);
    expect(items).toHaveLength(2);
  });

  test("skips ignored names and empty/oversized files", async () => {
    const { listDir, stat } = mockFs({
      kind: "dir",
      children: {
        ".hidden": { kind: "file", size: 5, mtimeMs: 1 },
        "skip.tmp": { kind: "file", size: 5, mtimeMs: 1 },
        empty: { kind: "file", size: 0, mtimeMs: 1 },
        "ok.txt": { kind: "file", size: 4, mtimeMs: 1 },
      },
    });
    const items = await collectWatchCandidates("content://root", listDir, stat);
    expect(items.map((i) => i.relativePath)).toEqual(["ok.txt"]);
  });

  test("respects depth cap and visited cycles", async () => {
    const { listDir, stat } = mockFs({
      kind: "dir",
      children: {
        a: {
          kind: "dir",
          children: {
            b: {
              kind: "dir",
              children: {
                c: {
                  kind: "dir",
                  children: {
                    "deep.txt": { kind: "file", size: 1, mtimeMs: 1 },
                  },
                },
                "mid.txt": { kind: "file", size: 1, mtimeMs: 2 },
              },
            },
          },
        },
      },
    });

    const baseList = listDir;
    const cyclicList: ListDirFn = async (uri) => {
      const kids = await baseList(uri);
      if (uri.endsWith("/a")) return [...kids, uri];
      return kids;
    };

    const items = await collectWatchCandidates(
      "content://root",
      cyclicList,
      stat,
      3,
    );
    expect(items.map((i) => i.relativePath).sort()).toEqual(["a/b/mid.txt"]);
  });

  test("same basename in two folders are distinct items", async () => {
    const { listDir, stat } = mockFs({
      kind: "dir",
      children: {
        a: {
          kind: "dir",
          children: { "x.pdf": { kind: "file", size: 1, mtimeMs: 1 } },
        },
        b: {
          kind: "dir",
          children: { "x.pdf": { kind: "file", size: 2, mtimeMs: 2 } },
        },
      },
    });
    const items = await collectWatchCandidates("content://root", listDir, stat);
    expect(items.map((i) => i.relativePath).sort()).toEqual([
      "a/x.pdf",
      "b/x.pdf",
    ]);
  });
});
