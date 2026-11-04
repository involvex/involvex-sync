package app.involvex.sync.a11y

import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.AccessibilityServiceInfo
import android.content.Context
import android.os.Bundle
import android.provider.Settings
import android.view.accessibility.AccessibilityManager
import android.view.accessibility.AccessibilityNodeInfo
import java.lang.ref.WeakReference

object InvxA11yBridge {
  const val PREFS = "invx_a11y"
  const val KEY_RECEIVE = "receive_enabled"

  @Volatile
  private var serviceRef: WeakReference<InvxA11yService>? = null

  fun attach(service: InvxA11yService) {
    serviceRef = WeakReference(service)
  }

  fun detach(service: InvxA11yService) {
    if (serviceRef?.get() === service) {
      serviceRef = null
    }
  }

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

  fun isServiceGranted(context: Context): Boolean {
    val expected = "${context.packageName}/${InvxA11yService::class.java.canonicalName}"
    val enabled = Settings.Secure.getString(
      context.contentResolver,
      Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES,
    ) ?: return false
    if (enabled.split(':').any { it.equals(expected, ignoreCase = true) }) {
      return true
    }
    // Fallback: AccessibilityManager enabled list
    val am =
      context.getSystemService(Context.ACCESSIBILITY_SERVICE) as? AccessibilityManager
        ?: return false
    val list =
      am.getEnabledAccessibilityServiceList(AccessibilityServiceInfo.FEEDBACK_ALL_MASK)
        ?: return false
    return list.any { info ->
      val si = info.resolveInfo?.serviceInfo ?: return@any false
      si.packageName == context.packageName &&
        si.name == InvxA11yService::class.java.name
    }
  }

  fun isServiceConnected(): Boolean = serviceRef?.get() != null

  fun injectText(text: String): Boolean {
    if (text.isEmpty()) return false
    val service = serviceRef?.get() ?: return false
    val node = focusedEditable(service) ?: return false
    val current = node.text?.toString() ?: ""
    val args = Bundle()
    args.putCharSequence(
      AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE,
      current + text,
    )
    val ok = node.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, args)
    node.recycle()
    return ok
  }

  fun injectKey(key: String): Boolean {
    val service = serviceRef?.get() ?: return false
    when (key) {
      "backspace", "delete" -> {
        val node = focusedEditable(service) ?: return false
        val current = node.text?.toString() ?: ""
        if (current.isEmpty()) {
          node.recycle()
          return true
        }
        val next =
          if (key == "delete") {
            // Forward delete: drop first char when caret unknown — best-effort trim end.
            if (current.length <= 1) "" else current.dropLast(1)
          } else {
            current.dropLast(1)
          }
        val args = Bundle()
        args.putCharSequence(
          AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE,
          next,
        )
        val ok = node.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, args)
        node.recycle()
        return ok
      }
      "enter" -> {
        val node = focusedEditable(service) ?: return false
        val current = node.text?.toString() ?: ""
        val args = Bundle()
        args.putCharSequence(
          AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE,
          current + "\n",
        )
        val ok = node.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, args)
        node.recycle()
        return ok
      }
      "tab" -> return injectText("\t")
      "escape" ->
        return service.performGlobalAction(AccessibilityService.GLOBAL_ACTION_BACK)
      "arrow_left", "arrow_right", "arrow_up", "arrow_down" ->
        // No reliable caret move via a11y without selection APIs; no-op success.
        return true
      else -> return false
    }
  }

  private fun focusedEditable(service: InvxA11yService): AccessibilityNodeInfo? {
    val root = service.rootInActiveWindow ?: return null
    val focused = root.findFocus(AccessibilityNodeInfo.FOCUS_INPUT)
    if (focused != null && focused.isEditable) {
      root.recycle()
      return focused
    }
    focused?.recycle()
    val fallback = findEditable(root)
    root.recycle()
    return fallback
  }

  private fun findEditable(node: AccessibilityNodeInfo): AccessibilityNodeInfo? {
    if (node.isEditable && node.isFocused) {
      return AccessibilityNodeInfo.obtain(node)
    }
    for (i in 0 until node.childCount) {
      val child = node.getChild(i) ?: continue
      val found = findEditable(child)
      child.recycle()
      if (found != null) return found
    }
    return null
  }
}
