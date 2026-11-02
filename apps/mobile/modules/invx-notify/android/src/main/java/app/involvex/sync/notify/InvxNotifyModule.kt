package app.involvex.sync.notify

import android.content.ComponentName
import android.content.Intent
import android.os.Build
import android.provider.Settings
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class InvxNotifyModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("InvxNotify")
    Events("onNotification")

    OnCreate {
      InvxNotifyBridge.onNotification = { payload ->
        sendEvent("onNotification", payload)
      }
    }

    OnDestroy {
      InvxNotifyBridge.onNotification = null
    }

    AsyncFunction("isMirrorEnabled") {
      val context = appContext.reactContext ?: throw Exceptions.ReactContextLost()
      InvxNotifyBridge.isMirrorEnabled(context)
    }

    AsyncFunction("setMirrorEnabled") { enabled: Boolean ->
      val context = appContext.reactContext ?: throw Exceptions.ReactContextLost()
      InvxNotifyBridge.setMirrorEnabled(context, enabled)
      true
    }

    AsyncFunction("isListenerGranted") {
      val context = appContext.reactContext ?: throw Exceptions.ReactContextLost()
      val flat =
        Settings.Secure.getString(
          context.contentResolver,
          "enabled_notification_listeners",
        ) ?: return@AsyncFunction false
      val cn = ComponentName(context, InvxNotifyListenerService::class.java)
      flat.split(':').any { it.equals(cn.flattenToString(), ignoreCase = true) }
    }

    AsyncFunction("openListenerSettings") {
      val context = appContext.reactContext ?: throw Exceptions.ReactContextLost()
      val intent = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP_MR1) {
        Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS)
      } else {
        Intent("android.settings.ACTION_NOTIFICATION_LISTENER_SETTINGS")
      }
      intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      context.startActivity(intent)
      true
    }
  }
}
