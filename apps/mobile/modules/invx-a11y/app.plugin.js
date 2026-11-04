const { withAndroidManifest, AndroidConfig } = require("@expo/config-plugins");

/**
 * Registers AccessibilityService for optional PC→phone text injection
 * when Sync Keyboard IME is not selected.
 */
function withInvxA11y(config) {
  return withAndroidManifest(config, (cfg) => {
    const manifest = cfg.modResults;
    let app;
    try {
      app = AndroidConfig.Manifest.getMainApplicationOrThrow(manifest);
    } catch {
      return cfg;
    }

    app.service = app.service || [];
    const name = "app.involvex.sync.a11y.InvxA11yService";
    const exists = app.service.some((s) => s.$?.["android:name"] === name);
    if (!exists) {
      app.service.push({
        $: {
          "android:name": name,
          "android:exported": "true",
          "android:label": "involvex Sync input",
          "android:permission": "android.permission.BIND_ACCESSIBILITY_SERVICE",
        },
        "intent-filter": [
          {
            action: [
              {
                $: {
                  "android:name":
                    "android.accessibilityservice.AccessibilityService",
                },
              },
            ],
          },
        ],
        "meta-data": [
          {
            $: {
              "android:name": "android.accessibilityservice",
              "android:resource": "@xml/invx_a11y_service",
            },
          },
        ],
      });
    }

    return cfg;
  });
}

module.exports = withInvxA11y;
