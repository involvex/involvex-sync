const { withAndroidManifest, AndroidConfig } = require("@expo/config-plugins");

function withInvxIme(config) {
  return withAndroidManifest(config, (cfg) => {
    const manifest = cfg.modResults;
    let app;
    try {
      app = AndroidConfig.Manifest.getMainApplicationOrThrow(manifest);
    } catch {
      return cfg;
    }

    app.service = app.service || [];
    const name = "app.involvex.sync.ime.InvxImeService";
    const exists = app.service.some((s) => s.$?.["android:name"] === name);
    if (!exists) {
      app.service.push({
        $: {
          "android:name": name,
          "android:exported": "true",
          "android:label": "involvex Sync Keyboard",
          "android:permission": "android.permission.BIND_INPUT_METHOD",
        },
        "intent-filter": [
          {
            action: [
              {
                $: {
                  "android:name": "android.view.InputMethod",
                },
              },
            ],
          },
        ],
        "meta-data": [
          {
            $: {
              "android:name": "android.view.im",
              "android:resource": "@xml/invx_ime_method",
            },
          },
        ],
      });
    }

    return cfg;
  });
}

module.exports = withInvxIme;
