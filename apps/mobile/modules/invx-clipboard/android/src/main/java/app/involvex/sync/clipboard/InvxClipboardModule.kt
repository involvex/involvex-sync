package app.involvex.sync.clipboard

import android.app.Activity
import android.app.Application
import android.os.Bundle
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class InvxClipboardModule : Module() {
  private var lifecycleCallbacks: Application.ActivityLifecycleCallbacks? = null
  private var startedCount = 0

  override fun definition() = ModuleDefinition {
    Name("InvxClipboard")
    Events("onClipboardText", "onClipboardImage")

    OnCreate {
      val context = appContext.reactContext ?: return@OnCreate
      InvxClipboardBridge.onText = { text ->
        sendEvent("onClipboardText", mapOf("text" to text))
      }
      InvxClipboardBridge.onImage = { payload ->
        sendEvent("onClipboardImage", payload)
      }
      InvxClipboardBridge.setIncludeImages(
        context,
        InvxClipboardBridge.isIncludeImages(context),
      )

      val app = context.applicationContext as? Application ?: return@OnCreate
      val callbacks =
        object : Application.ActivityLifecycleCallbacks {
          override fun onActivityStarted(activity: Activity) {
            startedCount += 1
            if (startedCount == 1) {
              InvxClipboardBridge.setAppForeground(context, true)
            }
          }

          override fun onActivityStopped(activity: Activity) {
            startedCount = (startedCount - 1).coerceAtLeast(0)
            if (startedCount == 0) {
              InvxClipboardBridge.setAppForeground(context, false)
            }
          }

          override fun onActivityCreated(a: Activity, b: Bundle?) {}
          override fun onActivityResumed(a: Activity) {}
          override fun onActivityPaused(a: Activity) {}
          override fun onActivitySaveInstanceState(a: Activity, b: Bundle) {}
          override fun onActivityDestroyed(a: Activity) {}
        }
      lifecycleCallbacks = callbacks
      app.registerActivityLifecycleCallbacks(callbacks)
    }

    OnDestroy {
      InvxClipboardBridge.onText = null
      InvxClipboardBridge.onImage = null
      val context = appContext.reactContext
      val app = context?.applicationContext as? Application
      lifecycleCallbacks?.let { app?.unregisterActivityLifecycleCallbacks(it) }
      lifecycleCallbacks = null
    }

    AsyncFunction("isAutoEnabled") {
      val context = appContext.reactContext ?: throw Exceptions.ReactContextLost()
      InvxClipboardBridge.isAutoEnabled(context)
    }

    AsyncFunction("setAutoEnabled") { enabled: Boolean ->
      val context = appContext.reactContext ?: throw Exceptions.ReactContextLost()
      InvxClipboardBridge.setAutoEnabled(context, enabled)
      true
    }

    AsyncFunction("isIncludeImages") {
      val context = appContext.reactContext ?: throw Exceptions.ReactContextLost()
      InvxClipboardBridge.isIncludeImages(context)
    }

    AsyncFunction("setIncludeImages") { enabled: Boolean ->
      val context = appContext.reactContext ?: throw Exceptions.ReactContextLost()
      InvxClipboardBridge.setIncludeImages(context, enabled)
      true
    }

    AsyncFunction("setImeActive") { active: Boolean ->
      val context = appContext.reactContext ?: throw Exceptions.ReactContextLost()
      InvxClipboardBridge.setImeActive(context, active)
      true
    }

    AsyncFunction("setClipboardImage") { dataBase64: String, mimeType: String ->
      val context = appContext.reactContext ?: throw Exceptions.ReactContextLost()
      InvxClipboardBridge.setClipboardImage(context, dataBase64, mimeType)
    }

    AsyncFunction("compressImage") { dataBase64: String, maxBytes: Int ->
      InvxClipboardBridge.compressJpegBase64(dataBase64, maxBytes)
    }
  }
}
