package app.involvex.sync.notify

import android.app.Notification
import android.service.notification.NotificationListenerService
import android.service.notification.StatusBarNotification

class InvxNotifyListenerService : NotificationListenerService() {
  private val recentKeys = LinkedHashMap<String, Long>()

  override fun onNotificationPosted(sbn: StatusBarNotification?) {
    if (sbn == null) return
    if (!InvxNotifyBridge.isMirrorEnabled(applicationContext)) return
    if (sbn.packageName == InvxNotifyBridge.OWN_PACKAGE) return
    if (sbn.isOngoing) return

    val extras = sbn.notification.extras ?: return
    val title =
      extras.getCharSequence(Notification.EXTRA_TITLE)?.toString()?.trim().orEmpty()
    val text =
      extras.getCharSequence(Notification.EXTRA_TEXT)?.toString()?.trim().orEmpty()
    val big =
      extras.getCharSequence(Notification.EXTRA_BIG_TEXT)?.toString()?.trim().orEmpty()
    val body = when {
      big.isNotEmpty() -> big
      text.isNotEmpty() -> text
      else -> ""
    }
    if (title.isEmpty() && body.isEmpty()) return

    val key = "${sbn.packageName}:${sbn.id}:$title:$body"
    val now = System.currentTimeMillis()
    synchronized(recentKeys) {
      if (recentKeys.containsKey(key) && now - (recentKeys[key] ?: 0) < 2_000) {
        return
      }
      recentKeys[key] = now
      while (recentKeys.size > 64) {
        val first = recentKeys.keys.firstOrNull() ?: break
        recentKeys.remove(first)
      }
    }

    InvxNotifyBridge.onNotification?.invoke(
      mapOf(
        "title" to title.ifEmpty { sbn.packageName },
        "body" to body,
        "packageName" to sbn.packageName,
        "when" to (sbn.notification.`when`.takeIf { it > 0 } ?: now),
      ),
    )
  }
}
