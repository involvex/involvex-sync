package app.involvex.sync.keepalive

import android.content.Intent
import android.os.Build
import android.os.Handler
import android.os.Looper
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.Promise

class InvxKeepaliveModule : Module() {
  private val mainHandler = Handler(Looper.getMainLooper())

  override fun definition() = ModuleDefinition {
    Name("InvxKeepalive")
    Events("onFolderTick")

    OnCreate {
      InvxKeepaliveBridge.onFolderTick = {
        mainHandler.post {
          sendEvent("onFolderTick", emptyMap<String, Any>())
        }
      }
    }

    OnDestroy {
      InvxKeepaliveBridge.onFolderTick = null
      InvxKeepaliveBridge.setFolderWatch(false)
    }

    AsyncFunction("start") { title: String, body: String, promise: Promise ->
      val context = appContext.reactContext
      if (context == null) {
        promise.reject("NO_CONTEXT", "React context missing", null)
        return@AsyncFunction
      }
      try {
        val intent = Intent(context, InvxForegroundService::class.java).apply {
          putExtra(InvxForegroundService.EXTRA_TITLE, title)
          putExtra(InvxForegroundService.EXTRA_BODY, body)
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
          context.startForegroundService(intent)
        } else {
          context.startService(intent)
        }
        promise.resolve(null)
      } catch (e: Exception) {
        // Android 15+: dataSync quota exhausted until the user brings the app
        // to the foreground (resets the 6h window).
        promise.reject(
          "FGS_START_FAILED",
          e.message ?: "Could not start keepalive foreground service",
          e,
        )
      }
    }

    AsyncFunction("stop") { promise: Promise ->
      val context = appContext.reactContext
      if (context == null) {
        promise.reject("NO_CONTEXT", "React context missing", null)
        return@AsyncFunction
      }
      InvxKeepaliveBridge.setFolderWatch(false)
      context.stopService(Intent(context, InvxForegroundService::class.java))
      InvxForegroundService.isRunning = false
      InvxForegroundService.timedOut = false
      promise.resolve(null)
    }

    AsyncFunction("isRunning") { promise: Promise ->
      promise.resolve(InvxForegroundService.isRunning)
    }

    AsyncFunction("didTimeout") { promise: Promise ->
      promise.resolve(InvxForegroundService.timedOut)
    }

    AsyncFunction("setFolderWatch") { enabled: Boolean, promise: Promise ->
      InvxKeepaliveBridge.setFolderWatch(enabled)
      promise.resolve(null)
    }

    AsyncFunction("isFolderWatchEnabled") { promise: Promise ->
      promise.resolve(InvxKeepaliveBridge.folderWatchEnabled)
    }
  }
}
