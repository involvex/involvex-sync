package app.involvex.sync.share

import android.content.Intent
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.Promise

class InvxShareModule : Module() {
  private var pendingText: String? = null

  override fun definition() = ModuleDefinition {
    Name("InvxShare")

    Events("onShareText")

    OnCreate {
      val activity = appContext.currentActivity
      captureIntent(activity?.intent)
    }

    OnNewIntent { intent ->
      captureIntent(intent)
    }

    AsyncFunction("getSharedText") { promise: Promise ->
      promise.resolve(pendingText)
    }

    AsyncFunction("clearSharedText") { promise: Promise ->
      pendingText = null
      promise.resolve(null)
    }
  }

  private fun captureIntent(intent: Intent?) {
    if (intent == null) return
    if (intent.action != Intent.ACTION_SEND) return
    val type = intent.type ?: return
    if (!type.startsWith("text/")) return
    val text = intent.getStringExtra(Intent.EXTRA_TEXT) ?: return
    pendingText = text
    sendEvent("onShareText", mapOf("text" to text))
  }
}
