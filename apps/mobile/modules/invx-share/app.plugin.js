const { withAndroidManifest, AndroidConfig } = require("@expo/config-plugins");

/**
 * Add ACTION_SEND on the launcher activity when it already exists.
 * Prefer app.json android.intentFilters for the same purpose during prebuild;
 * this plugin is a safety net for subsequent config syncs.
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
        (c) =>
          c.$?.["android:name"] === "android.intent.category.LAUNCHER",
      );
      if (hasMain && hasLauncher) return activity;
    }
  }
  return null;
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
      // Base template not ready yet — app.json intentFilters still apply.
      return cfg;
    }

    activity["intent-filter"] = activity["intent-filter"] || [];

    const already = activity["intent-filter"].some((filter) => {
      const actions = filter.action || [];
      return actions.some(
        (a) => a.$?.["android:name"] === "android.intent.action.SEND",
      );
    });

    if (!already) {
      activity["intent-filter"].push({
        action: [{ $: { "android:name": "android.intent.action.SEND" } }],
        category: [
          { $: { "android:name": "android.intent.category.DEFAULT" } },
        ],
        data: [{ $: { "android:mimeType": "text/plain" } }],
      });
    }

    return cfg;
  });
}

module.exports = withInvxShare;
