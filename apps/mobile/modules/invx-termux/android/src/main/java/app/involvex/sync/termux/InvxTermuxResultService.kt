package app.involvex.sync.termux

import android.app.Service
import android.content.Intent
import android.os.IBinder

/**
 * Started by Termux via PendingIntent when a RUN_COMMAND finishes.
 * Same pattern as InVx termux-terminal-widget PluginResultsService.
 */
class InvxTermuxResultService : Service() {
  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(
    intent: Intent?,
    flags: Int,
    startId: Int,
  ): Int {
    if (intent != null) {
      val requestId = intent.getStringExtra(EXTRA_REQUEST_ID)
      if (!requestId.isNullOrBlank()) {
        InvxTermuxBridge.complete(requestId, InvxTermuxResultReceiver.parseResult(intent))
      }
    }
    stopSelf(startId)
    return START_NOT_STICKY
  }

  companion object {
    const val EXTRA_REQUEST_ID = "invx_termux_request_id"
  }
}
