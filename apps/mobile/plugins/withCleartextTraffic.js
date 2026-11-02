const { withAndroidManifest } = require("@expo/config-plugins");

/**
 * Allow cleartext ws:// to LAN peers (pairing + sync).
 */
function withCleartextTraffic(config) {
  return withAndroidManifest(config, (cfg) => {
    const app = cfg.modResults.manifest.application?.[0];
    if (!app?.$) return cfg;
    app.$["android:usesCleartextTraffic"] = "true";
    return cfg;
  });
}

module.exports = withCleartextTraffic;
