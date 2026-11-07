package app.involvex.sync.ime

import android.content.Context
import android.view.KeyEvent
import android.view.inputmethod.InputConnection

object InvxImeBridge {
  const val PREFS = "invx_ime"
  const val KEY_RECEIVE = "receive_enabled"

  @Volatile
  var inputConnection: InputConnection? = null

  @Volatile
  var imeActive: Boolean = false

  @Volatile
  var onActiveChanged: ((Boolean) -> Unit)? = null

  fun setReceiveEnabled(context: Context, enabled: Boolean) {
    context
      .getSharedPreferences(PREFS, Context.MODE_PRIVATE)
      .edit()
      .putBoolean(KEY_RECEIVE, enabled)
      .apply()
  }

  fun isReceiveEnabled(context: Context): Boolean {
    return context
      .getSharedPreferences(PREFS, Context.MODE_PRIVATE)
      .getBoolean(KEY_RECEIVE, false)
  }

  fun setActive(active: Boolean) {
    imeActive = active
    onActiveChanged?.invoke(active)
  }

  /** Soft-notify clipboard module when IME focus changes (same process). */
  fun notifyClipboardImeActive(context: Context, active: Boolean) {
    try {
      val clazz = Class.forName("app.involvex.sync.clipboard.InvxClipboardBridge")
      val instance = clazz.getField("INSTANCE").get(null)
      val method =
        clazz.getMethod(
          "setImeActive",
          Context::class.java,
          java.lang.Boolean.TYPE,
        )
      method.invoke(instance, context, active)
    } catch (_: Exception) {
      /* clipboard module optional at compile time */
    }
  }

  fun commitText(text: String): Boolean {
    val ic = inputConnection ?: return false
    ic.commitText(text, 1)
    return true
  }

  fun sendKey(key: String): Boolean {
    val ic = inputConnection ?: return false
    val code = when (key) {
      "enter" -> KeyEvent.KEYCODE_ENTER
      "backspace" -> KeyEvent.KEYCODE_DEL
      "tab" -> KeyEvent.KEYCODE_TAB
      "escape" -> KeyEvent.KEYCODE_ESCAPE
      "arrow_left" -> KeyEvent.KEYCODE_DPAD_LEFT
      "arrow_right" -> KeyEvent.KEYCODE_DPAD_RIGHT
      "arrow_up" -> KeyEvent.KEYCODE_DPAD_UP
      "arrow_down" -> KeyEvent.KEYCODE_DPAD_DOWN
      "delete" -> KeyEvent.KEYCODE_FORWARD_DEL
      else -> return false
    }
    ic.sendKeyEvent(KeyEvent(KeyEvent.ACTION_DOWN, code))
    ic.sendKeyEvent(KeyEvent(KeyEvent.ACTION_UP, code))
    return true
  }
}
