package app.involvex.sync.a11y

import android.content.Intent
import android.provider.Settings
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class InvxA11yModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("InvxA11y")

    AsyncFunction("isReceiveEnabled") {
      val context = appContext.reactContext ?: throw Exceptions.ReactContextLost()
      InvxA11yBridge.isReceiveEnabled(context)
    }

    AsyncFunction("setReceiveEnabled") { enabled: Boolean ->
      val context = appContext.reactContext ?: throw Exceptions.ReactContextLost()
      InvxA11yBridge.setReceiveEnabled(context, enabled)
      true
    }

    AsyncFunction("isServiceGranted") {
      val context = appContext.reactContext ?: throw Exceptions.ReactContextLost()
      InvxA11yBridge.isServiceGranted(context)
    }

    AsyncFunction("isServiceConnected") {
      InvxA11yBridge.isServiceConnected()
    }

    AsyncFunction("injectText") { text: String ->
      InvxA11yBridge.injectText(text)
    }

    AsyncFunction("injectKey") { key: String ->
      InvxA11yBridge.injectKey(key)
    }

    AsyncFunction("openAccessibilitySettings") {
      val context = appContext.reactContext ?: throw Exceptions.ReactContextLost()
      val intent = Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS)
      intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      context.startActivity(intent)
      true
    }
  }
}
