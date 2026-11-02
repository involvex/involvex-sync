package app.involvex.sync.notify

import android.content.Context

/**
 * Shared prefs + callback bridge between NotificationListenerService and the Expo module.
 */
object InvxNotifyBridge {
  const val PREFS = "invx_notify"
  const val KEY_MIRROR = "mirror_enabled"
  const val OWN_PACKAGE = "app.involvex.sync"

  @Volatile
  var onNotification: ((Map<String, Any?>) -> Unit)? = null

  fun isMirrorEnabled(context: Context): Boolean {
    return context
      .getSharedPreferences(PREFS, Context.MODE_PRIVATE)
      .getBoolean(KEY_MIRROR, false)
  }

  fun setMirrorEnabled(context: Context, enabled: Boolean) {
    context
      .getSharedPreferences(PREFS, Context.MODE_PRIVATE)
      .edit()
      .putBoolean(KEY_MIRROR, enabled)
      .apply()
  }
}
