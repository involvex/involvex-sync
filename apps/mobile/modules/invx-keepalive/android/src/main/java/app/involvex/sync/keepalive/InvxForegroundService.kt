package app.involvex.sync.keepalive

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat

/**
 * Persistent notification so Sync can finish clipboard / folder sync while
 * backgrounded.
 *
 * Declared as `foregroundServiceType="dataSync"`. On Android 15+ (API 35)
 * that type is capped at ~6 hours / 24h while the app is in the background;
 * the system then calls [onTimeout] and we must [stopSelf] within a few
 * seconds or the process is killed with
 * `ForegroundServiceDidNotStopInTimeException`.
 */
class InvxForegroundService : Service() {
  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    val title = intent?.getStringExtra(EXTRA_TITLE) ?: "involvex Sync"
    val body = intent?.getStringExtra(EXTRA_BODY) ?: "Connected"
    ensureChannel()
    val notification: Notification =
      NotificationCompat.Builder(this, CHANNEL_ID)
        .setContentTitle(title)
        .setContentText(body)
        .setSmallIcon(android.R.drawable.stat_sys_data_bluetooth)
        .setOngoing(true)
        .build()
    // Explicit type matches the manifest; required on API 29+ when the
    // service declares foregroundServiceType.
    ServiceCompat.startForeground(
      this,
      NOTIFICATION_ID,
      notification,
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
        ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC
      } else {
        0
      },
    )
    isRunning = true
    timedOut = false
    return START_STICKY
  }

  /**
   * Android 15+ dataSync / mediaProcessing time limit. Must stop promptly —
   * do not schedule work here.
   */
  override fun onTimeout(startId: Int, fgsType: Int) {
    Log.w(
      TAG,
      "dataSync foreground timeout (startId=$startId fgsType=$fgsType) — stopping",
    )
    timedOut = true
    InvxKeepaliveBridge.stopFolderTick()
    isRunning = false
    stopSelf(startId)
  }

  override fun onDestroy() {
    InvxKeepaliveBridge.setFolderWatch(false)
    isRunning = false
    super.onDestroy()
  }

  private fun ensureChannel() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    val manager = getSystemService(NotificationManager::class.java)
    val channel =
      NotificationChannel(
        CHANNEL_ID,
        "involvex Sync",
        NotificationManager.IMPORTANCE_LOW,
      )
    manager.createNotificationChannel(channel)
  }

  companion object {
    private const val TAG = "InvxForegroundService"
    const val CHANNEL_ID = "invx_sync_keepalive"
    const val NOTIFICATION_ID = 17391
    const val EXTRA_TITLE = "title"
    const val EXTRA_BODY = "body"

    @Volatile
    var isRunning: Boolean = false

    /** True after Android 15 dataSync [onTimeout] until the next successful start. */
    @Volatile
    var timedOut: Boolean = false
  }
}
