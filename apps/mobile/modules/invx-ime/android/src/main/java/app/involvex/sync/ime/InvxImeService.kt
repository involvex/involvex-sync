package app.involvex.sync.ime

import android.inputmethodservice.InputMethodService
import android.view.View
import android.view.inputmethod.EditorInfo
import android.widget.LinearLayout
import android.widget.TextView

/**
 * Soft keyboard that mainly receives remote keystrokes from the PC.
 * Shows a tiny status strip so the user knows Sync Keyboard is active.
 */
class InvxImeService : InputMethodService() {
  override fun onCreateInputView(): View {
    val pad = (12 * resources.displayMetrics.density).toInt()
    val layout = LinearLayout(this).apply {
      orientation = LinearLayout.VERTICAL
      setPadding(pad, pad, pad, pad)
      setBackgroundColor(0xFF0B1220.toInt())
    }
    val label = TextView(this).apply {
      text = "involvex Sync Keyboard — type from your PC"
      setTextColor(0xFFE8EEF8.toInt())
      textSize = 14f
    }
    layout.addView(label)
    return layout
  }

  override fun onStartInputView(info: EditorInfo?, restarting: Boolean) {
    super.onStartInputView(info, restarting)
    InvxImeBridge.inputConnection = currentInputConnection
    InvxImeBridge.setActive(true)
    InvxImeBridge.notifyClipboardImeActive(this, true)
  }

  override fun onFinishInputView(finishingInput: Boolean) {
    InvxImeBridge.setActive(false)
    InvxImeBridge.notifyClipboardImeActive(this, false)
    InvxImeBridge.inputConnection = null
    super.onFinishInputView(finishingInput)
  }

  override fun onStartInput(attribute: EditorInfo?, restarting: Boolean) {
    super.onStartInput(attribute, restarting)
    InvxImeBridge.inputConnection = currentInputConnection
  }

  override fun onFinishInput() {
    InvxImeBridge.inputConnection = null
    InvxImeBridge.setActive(false)
    InvxImeBridge.notifyClipboardImeActive(this, false)
    super.onFinishInput()
  }
}
