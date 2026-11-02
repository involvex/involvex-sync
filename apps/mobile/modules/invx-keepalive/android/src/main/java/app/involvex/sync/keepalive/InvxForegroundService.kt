package app.involvex.sync.keepalive

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Intent
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat

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
    startForeground(NOTIFICATION_ID, notification)
    isRunning = true
    return START_STICKY
  }

  override fun onDestroy() {
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
    const val CHANNEL_ID = "invx_sync_keepalive"
    const val NOTIFICATION_ID = 17391
    const val EXTRA_TITLE = "title"
    const val EXTRA_BODY = "body"
    @Volatile
    var isRunning: Boolean = false
  }
}
