const { withAndroidManifest, AndroidConfig } = require("@expo/config-plugins");

function withInvxKeepalive(config) {
  return withAndroidManifest(config, (cfg) => {
    const manifest = cfg.modResults;
    let app;
    try {
      app = AndroidConfig.Manifest.getMainApplicationOrThrow(manifest);
    } catch {
      return cfg;
    }

    app.service = app.service || [];

    const name = "app.involvex.sync.keepalive.InvxForegroundService";
    const exists = app.service.some((s) => s.$?.["android:name"] === name);
    if (!exists) {
      app.service.push({
        $: {
          "android:name": name,
          "android:exported": "false",
          "android:foregroundServiceType": "dataSync",
        },
      });
    }

    return cfg;
  });
}

module.exports = withInvxKeepalive;
