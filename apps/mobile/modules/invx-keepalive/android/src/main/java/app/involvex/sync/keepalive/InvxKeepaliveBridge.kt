package app.involvex.sync.keepalive

import android.os.Handler
import android.os.Looper

/**
 * Bridge between the foreground keepalive service and the Expo module.
 * JS enables folder-watch ticks; a main-thread Handler posts onFolderTick every 2s
 * while the process is kept alive by the dataSync foreground service.
 */
object InvxKeepaliveBridge {
  const val FOLDER_TICK_MS = 2000L

  @Volatile
  var folderWatchEnabled: Boolean = false
    private set

  @Volatile
  var onFolderTick: (() -> Unit)? = null

  private val handler = Handler(Looper.getMainLooper())
  private var folderTickRunnable: Runnable? = null

  fun setFolderWatch(enabled: Boolean) {
    folderWatchEnabled = enabled
    if (enabled) {
      startFolderTick()
    } else {
      stopFolderTick()
    }
  }

  fun stopFolderTick() {
    folderTickRunnable?.let { handler.removeCallbacks(it) }
    folderTickRunnable = null
  }

  private fun startFolderTick() {
    if (folderTickRunnable != null) return
    val runnable =
      object : Runnable {
        override fun run() {
          if (!folderWatchEnabled) {
            stopFolderTick()
            return
          }
          onFolderTick?.invoke()
          handler.postDelayed(this, FOLDER_TICK_MS)
        }
      }
    folderTickRunnable = runnable
    handler.post(runnable)
  }
}
