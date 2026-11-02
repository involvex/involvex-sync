package app.involvex.sync.ime

import android.content.Intent
import android.provider.Settings
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class InvxImeModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("InvxIme")
    Events("onImeActive")

    OnCreate {
      InvxImeBridge.onActiveChanged = { active ->
        sendEvent("onImeActive", mapOf("active" to active))
      }
    }

    OnDestroy {
      InvxImeBridge.onActiveChanged = null
    }

    AsyncFunction("isReceiveEnabled") {
      val context = appContext.reactContext ?: throw Exceptions.ReactContextLost()
      InvxImeBridge.isReceiveEnabled(context)
    }

    AsyncFunction("setReceiveEnabled") { enabled: Boolean ->
      val context = appContext.reactContext ?: throw Exceptions.ReactContextLost()
      InvxImeBridge.setReceiveEnabled(context, enabled)
      true
    }

    AsyncFunction("isImeActive") {
      InvxImeBridge.imeActive
    }

    AsyncFunction("commitText") { text: String ->
      InvxImeBridge.commitText(text)
    }

    AsyncFunction("sendKey") { key: String ->
      InvxImeBridge.sendKey(key)
    }

    AsyncFunction("openImeSettings") {
      val context = appContext.reactContext ?: throw Exceptions.ReactContextLost()
      val intent = Intent(Settings.ACTION_INPUT_METHOD_SETTINGS)
      intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      context.startActivity(intent)
      true
    }
  }
}
