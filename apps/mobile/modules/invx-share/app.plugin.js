const { withAndroidManifest, AndroidConfig } = require("@expo/config-plugins");

/**
 * Add ACTION_SEND / SEND_MULTIPLE on the launcher activity for text + files.
 */
function findLauncherActivity(app) {
  const activities = app.activity || [];
  for (const activity of activities) {
    const filters = activity["intent-filter"] || [];
    for (const filter of filters) {
      const actions = filter.action || [];
      const categories = filter.category || [];
      const hasMain = actions.some(
        (a) => a.$?.["android:name"] === "android.intent.action.MAIN",
      );
      const hasLauncher = categories.some(
        (c) => c.$?.["android:name"] === "android.intent.category.LAUNCHER",
      );
      if (hasMain && hasLauncher) return activity;
    }
  }
  return null;
}

function hasAction(filter, name) {
  return (filter.action || []).some((a) => a.$?.["android:name"] === name);
}

function withInvxShare(config) {
  return withAndroidManifest(config, (cfg) => {
    const manifest = cfg.modResults;
    let app;
    try {
      app = AndroidConfig.Manifest.getMainApplicationOrThrow(manifest);
    } catch {
      return cfg;
    }

    const activity =
      findLauncherActivity(app) ||
      (typeof AndroidConfig.Manifest.getMainActivity === "function"
        ? AndroidConfig.Manifest.getMainActivity(app)
        : null);

    if (!activity) {
      return cfg;
    }

    activity["intent-filter"] = activity["intent-filter"] || [];

    const mimeTypes = [
      "text/*",
      "image/*",
      "application/pdf",
      "application/*",
      "*/*",
    ];

    const alreadySend = activity["intent-filter"].some((filter) =>
      hasAction(filter, "android.intent.action.SEND"),
    );
    if (!alreadySend) {
      activity["intent-filter"].push({
        action: [{ $: { "android:name": "android.intent.action.SEND" } }],
        category: [
          { $: { "android:name": "android.intent.category.DEFAULT" } },
        ],
        data: mimeTypes.map((m) => ({ $: { "android:mimeType": m } })),
      });
    }

    const alreadyMulti = activity["intent-filter"].some((filter) =>
      hasAction(filter, "android.intent.action.SEND_MULTIPLE"),
    );
    if (!alreadyMulti) {
      activity["intent-filter"].push({
        action: [
          { $: { "android:name": "android.intent.action.SEND_MULTIPLE" } },
        ],
        category: [
          { $: { "android:name": "android.intent.category.DEFAULT" } },
        ],
        data: mimeTypes.map((m) => ({ $: { "android:mimeType": m } })),
      });
    }

    return cfg;
  });
}

module.exports = withInvxShare;
