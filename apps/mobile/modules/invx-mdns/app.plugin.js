const { withAndroidManifest, AndroidConfig } = require("@expo/config-plugins");

/**
 * Ensure multicast permission for NSD browse of _invxconnect._tcp.
 */
function withInvxMdns(config) {
  config = AndroidConfig.Permissions.withPermissions(config, [
    "android.permission.CHANGE_WIFI_MULTICAST_STATE",
    "android.permission.ACCESS_NETWORK_STATE",
    "android.permission.INTERNET",
  ]);
  return withAndroidManifest(config, (cfg) => cfg);
}

module.exports = withInvxMdns;
