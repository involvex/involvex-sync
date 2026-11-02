const { withAndroidManifest, AndroidConfig } = require("@expo/config-plugins");

/**
 * Registers NotificationListenerService for optional notification mirroring.
 */
function withInvxNotify(config) {
  return withAndroidManifest(config, (cfg) => {
    const manifest = cfg.modResults;
    let app;
    try {
      app = AndroidConfig.Manifest.getMainApplicationOrThrow(manifest);
    } catch {
      return cfg;
    }

    app.service = app.service || [];
    const name = "app.involvex.sync.notify.InvxNotifyListenerService";
    const exists = app.service.some((s) => s.$?.["android:name"] === name);
    if (!exists) {
      app.service.push({
        $: {
          "android:name": name,
          "android:exported": "true",
          "android:permission":
            "android.permission.BIND_NOTIFICATION_LISTENER_SERVICE",
          "android:label": "involvex Sync notifications",
        },
        "intent-filter": [
          {
            action: [
              {
                $: {
                  "android:name":
                    "android.service.notification.NotificationListenerService",
                },
              },
            ],
          },
        ],
      });
    }

    return cfg;
  });
}

module.exports = withInvxNotify;
