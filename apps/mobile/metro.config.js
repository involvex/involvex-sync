const { getDefaultConfig } = require("expo/metro-config");
const { resolve: metroResolve } = require("metro-resolver");
const path = require("node:path");
const fs = require("node:fs");

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, "../..");

const config = getDefaultConfig(projectRoot);

config.watchFolders = [workspaceRoot];
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, "node_modules"),
  path.resolve(workspaceRoot, "node_modules"),
];
config.resolver.disableHierarchicalLookup = true;
config.resolver.extraNodeModules = {
  "@involvex/protocol": path.resolve(workspaceRoot, "packages/protocol"),
};

/**
 * Map TypeScript ESM "./foo.js" imports to "./foo.ts" when the .js file
 * is missing (Metro does not do this itself).
 */
const cryptoShim = path.resolve(projectRoot, "src/cryptoShim.js");

config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (
    moduleName === "@noble/hashes/crypto.js" ||
    moduleName === "@noble/hashes/crypto"
  ) {
    return { type: "sourceFile", filePath: cryptoShim };
  }

  if (
    (moduleName.startsWith("./") || moduleName.startsWith("../")) &&
    moduleName.endsWith(".js")
  ) {
    const origin = path.dirname(context.originModulePath);
    const absJs = path.resolve(origin, moduleName);
    if (!fs.existsSync(absJs)) {
      for (const ext of [".ts", ".tsx"]) {
        const candidate = absJs.replace(/\.js$/, ext);
        if (fs.existsSync(candidate)) {
          return {
            type: "sourceFile",
            filePath: candidate,
          };
        }
      }
    }
  }

  return metroResolve(context, moduleName, platform);
};

module.exports = config;
