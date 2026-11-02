import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const dir = join(import.meta.dir, "../packages/protocol/src");

for (const file of readdirSync(dir)) {
  if (!/\.(ts|tsx)$/.test(file)) continue;
  const path = join(dir, file);
  const src = readFileSync(path, "utf8");
  const out = src.replace(/(from\s+["'])(\.[^"']+)\.js(["'])/g, "$1$2$3");
  if (out !== src) {
    writeFileSync(path, out);
    console.log("updated", path);
  }
}
