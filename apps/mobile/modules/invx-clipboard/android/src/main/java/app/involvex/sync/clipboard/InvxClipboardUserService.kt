package app.involvex.sync.clipboard

import android.content.ClipboardManager
import android.content.Context
import android.util.Log
import androidx.annotation.Keep

/**
 * Runs as shell UID when bound via Shizuku. Text-only MVP — images stay on
 * the foreground / IME clipboard path.
 */
class InvxClipboardUserService : IInvxClipboardUserService.Stub {
  private var appContext: Context? = null
  private var clipboardManager: ClipboardManager? = null

  /** Required for older Shizuku versions. */
  constructor() {
    Log.i(TAG, "constructor")
  }

  /**
   * Preferred on Shizuku API v13+. Context is from createPackageContextAsUser
   * and is enough for ClipboardManager.
   */
  @Keep
  constructor(context: Context) {
    Log.i(TAG, "constructor with Context")
    appContext = context
    clipboardManager =
      context.getSystemService(Context.CLIPBOARD_SERVICE) as? ClipboardManager
  }

  override fun destroy() {
    Log.i(TAG, "destroy")
    System.exit(0)
  }

  override fun getPrimaryText(): String? {
    return try {
      val ctx = appContext
      val cm = clipboardManager ?: return null
      val clip = cm.primaryClip ?: return null
      if (clip.itemCount <= 0) return null
      val text = clip.getItemAt(0)?.coerceToText(ctx)?.toString()?.trim()
      if (text.isNullOrEmpty()) null else text
    } catch (_: SecurityException) {
      null
    } catch (e: Exception) {
      Log.w(TAG, "getPrimaryText failed", e)
      null
    }
  }

  companion object {
    private const val TAG = "InvxClipUserService"
  }
}
