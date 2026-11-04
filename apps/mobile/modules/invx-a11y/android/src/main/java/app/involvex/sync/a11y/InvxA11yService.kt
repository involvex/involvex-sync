package app.involvex.sync.a11y

import android.accessibilityservice.AccessibilityService
import android.view.accessibility.AccessibilityEvent

class InvxA11yService : AccessibilityService() {
  override fun onServiceConnected() {
    super.onServiceConnected()
    InvxA11yBridge.attach(this)
  }

  override fun onAccessibilityEvent(event: AccessibilityEvent?) {
    // Injection is pull-based from the Expo bridge; no event processing.
  }

  override fun onInterrupt() {
    // Required abstract method.
  }

  override fun onDestroy() {
    InvxA11yBridge.detach(this)
    super.onDestroy()
  }
}
