const { withAndroidManifest, AndroidConfig } = require("@expo/config-plugins");

const TERMUX_PACKAGE = "com.involvex.termux_app";
const RUN_COMMAND_PERMISSION = `${TERMUX_PACKAGE}.permission.RUN_COMMAND`;

/**
 * Declares uses-permission + package visibility so involvex Sync can call
 * Termux RunCommandService (protectionLevel=dangerous).
 */
function withInvxTermux(config) {
  config = AndroidConfig.Permissions.withPermissions(config, [
    RUN_COMMAND_PERMISSION,
  ]);

  return withAndroidManifest(config, (cfg) => {
    const manifest = cfg.modResults;
    if (!manifest.manifest) return cfg;

    // Android 11+ package visibility
    const queries = manifest.manifest.queries ?? [];
    const hasPackage = queries.some((q) =>
      (q.package || []).some((p) => p.$?.["android:name"] === TERMUX_PACKAGE),
    );
    if (!hasPackage) {
      queries.push({
        package: [{ $: { "android:name": TERMUX_PACKAGE } }],
      });
      manifest.manifest.queries = queries;
    }

    return cfg;
  });
}

module.exports = withInvxTermux;
