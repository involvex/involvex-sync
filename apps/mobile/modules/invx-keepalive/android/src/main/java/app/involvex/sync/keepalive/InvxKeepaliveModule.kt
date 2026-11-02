package app.involvex.sync.keepalive

import android.content.Intent
import android.os.Build
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.Promise

class InvxKeepaliveModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("InvxKeepalive")

    AsyncFunction("start") { title: String, body: String, promise: Promise ->
      val context = appContext.reactContext
      if (context == null) {
        promise.reject("NO_CONTEXT", "React context missing", null)
        return@AsyncFunction
      }
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
    }

    AsyncFunction("stop") { promise: Promise ->
      val context = appContext.reactContext
      if (context == null) {
        promise.reject("NO_CONTEXT", "React context missing", null)
        return@AsyncFunction
      }
      context.stopService(Intent(context, InvxForegroundService::class.java))
      promise.resolve(null)
    }

    AsyncFunction("isRunning") { promise: Promise ->
      promise.resolve(InvxForegroundService.isRunning)
    }
  }
}
