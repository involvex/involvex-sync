const { getDefaultConfig } = require("expo/metro-config");
const path = require("node:path");
const fs = require("node:fs");

const projectRoot = __dirname;

/** @type {import('expo/metro-config').MetroConfig} */
const config = getDefaultConfig(projectRoot);

/**
 * Keep only project-specific resolvers. Expo SDK 52+ configures monorepo
 * watchFolders / nodeModulesPaths / disableHierarchicalLookup automatically —
 * overriding them trips expo-doctor and can break resolution.
 *
 * Map TypeScript ESM "./foo.js" imports to "./foo.ts" when the .js file is
 * missing (Metro does not do this itself), and shim @noble/hashes crypto.
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

  return context.resolveRequest(context, moduleName, platform);
};

module.exports = config;
