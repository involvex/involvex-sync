package app.involvex.sync.clipboard

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.net.Uri
import android.util.Base64
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.FileOutputStream

object InvxClipboardBridge {
  const val PREFS = "invx_clipboard"
  const val KEY_AUTO = "auto_enabled"
  const val KEY_IMAGES = "include_images"

  @Volatile
  var onText: ((String) -> Unit)? = null

  @Volatile
  var onImage: ((Map<String, Any?>) -> Unit)? = null

  @Volatile
  private var listening = false

  @Volatile
  private var appForeground = false

  @Volatile
  private var imeActive = false

  @Volatile
  private var includeImages = true

  @Volatile
  private var lastFingerprint: String? = null

  private var listener: ClipboardManager.OnPrimaryClipChangedListener? = null

  fun setAutoEnabled(context: Context, enabled: Boolean) {
    context
      .getSharedPreferences(PREFS, Context.MODE_PRIVATE)
      .edit()
      .putBoolean(KEY_AUTO, enabled)
      .apply()
    if (enabled) {
      ensureListener(context)
    } else {
      stopListener(context)
    }
  }

  fun isAutoEnabled(context: Context): Boolean {
    return context
      .getSharedPreferences(PREFS, Context.MODE_PRIVATE)
      .getBoolean(KEY_AUTO, false)
  }

  fun setIncludeImages(context: Context, enabled: Boolean) {
    includeImages = enabled
    context
      .getSharedPreferences(PREFS, Context.MODE_PRIVATE)
      .edit()
      .putBoolean(KEY_IMAGES, enabled)
      .apply()
  }

  fun isIncludeImages(context: Context): Boolean {
    return context
      .getSharedPreferences(PREFS, Context.MODE_PRIVATE)
      .getBoolean(KEY_IMAGES, true)
  }

  fun setAppForeground(context: Context, foreground: Boolean) {
    appForeground = foreground
    if (foreground && isAutoEnabled(context)) {
      ensureListener(context)
      // Seed fingerprint so enabling/resuming doesn't rebroadcast.
      fingerprintClip(context)?.let { lastFingerprint = it }
    }
  }

  fun setImeActive(context: Context, active: Boolean) {
    imeActive = active
    if (active && isAutoEnabled(context)) {
      ensureListener(context)
      fingerprintClip(context)?.let { lastFingerprint = it }
    }
  }

  fun canReadClipboard(): Boolean = appForeground || imeActive

  private fun ensureListener(context: Context) {
    includeImages = isIncludeImages(context)
    if (listening) return
    val cm = context.getSystemService(Context.CLIPBOARD_SERVICE) as? ClipboardManager
      ?: return
    val l = ClipboardManager.OnPrimaryClipChangedListener {
      if (!isAutoEnabled(context) || !canReadClipboard()) return@OnPrimaryClipChangedListener
      emitClip(context)
    }
    listener = l
    cm.addPrimaryClipChangedListener(l)
    listening = true
    fingerprintClip(context)?.let { lastFingerprint = it }
  }

  private fun stopListener(context: Context) {
    val cm = context.getSystemService(Context.CLIPBOARD_SERVICE) as? ClipboardManager
    val l = listener
    if (cm != null && l != null) {
      cm.removePrimaryClipChangedListener(l)
    }
    listener = null
    listening = false
    lastFingerprint = null
  }

  private fun fingerprintClip(context: Context): String? {
    if (!canReadClipboard()) return null
    val cm = context.getSystemService(Context.CLIPBOARD_SERVICE) as? ClipboardManager
      ?: return null
    val clip = try {
      cm.primaryClip
    } catch (_: SecurityException) {
      null
    } ?: return null
    if (clip.itemCount <= 0) return null
    val item = clip.getItemAt(0) ?: return null
    val text = item.coerceToText(context)?.toString()
    if (!text.isNullOrEmpty()) return "t:${text.hashCode()}"
    val uri = item.uri
    if (uri != null) return "u:$uri"
    return null
  }

  private fun emitClip(context: Context) {
    val fp = fingerprintClip(context) ?: return
    if (fp == lastFingerprint) return
    lastFingerprint = fp

    val cm = context.getSystemService(Context.CLIPBOARD_SERVICE) as? ClipboardManager
      ?: return
    val clip = try {
      cm.primaryClip
    } catch (_: SecurityException) {
      null
    } ?: return
    if (clip.itemCount <= 0) return
    val item = clip.getItemAt(0) ?: return

    val text = item.coerceToText(context)?.toString()?.trim().orEmpty()
    if (text.isNotEmpty() && !looksLikeOnlyUriLabel(text, item.uri)) {
      onText?.invoke(text)
      return
    }

    if (!includeImages) return
    val uri = item.uri
    if (uri != null) {
      readUriAsImage(context, uri)?.let {
        onImage?.invoke(it)
        return
      }
    }
    // Some OEMs put a bitmap description without a readable URI.
  }

  private fun looksLikeOnlyUriLabel(text: String, uri: Uri?): Boolean {
    if (uri == null) return false
    return text == uri.toString() || text.startsWith("content://")
  }

  private fun readUriAsImage(context: Context, uri: Uri): Map<String, Any?>? {
    return try {
      context.contentResolver.openInputStream(uri)?.use { input ->
        val bytes = input.readBytes()
        if (bytes.isEmpty() || bytes.size > 2 * 1024 * 1024) return null
        val mime = context.contentResolver.getType(uri) ?: "image/png"
        mapOf(
          "mimeType" to mime,
          "dataBase64" to Base64.encodeToString(bytes, Base64.NO_WRAP),
          "size" to bytes.size,
          "name" to "clipboard-${System.currentTimeMillis()}.png",
        )
      }
    } catch (_: Exception) {
      null
    }
  }

  fun setClipboardImage(context: Context, dataBase64: String, mimeType: String): Boolean {
    return try {
      val bytes = Base64.decode(dataBase64, Base64.DEFAULT)
      val bmp = BitmapFactory.decodeByteArray(bytes, 0, bytes.size) ?: return false
      val cache = File(context.cacheDir, "invx-clipboard")
      if (!cache.exists()) cache.mkdirs()
      val outFile = File(cache, "clip-${System.currentTimeMillis()}.png")
      FileOutputStream(outFile).use { fos ->
        bmp.compress(Bitmap.CompressFormat.PNG, 92, fos)
      }
      val cm = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
      val uri = Uri.fromFile(outFile)
      // Prefer content URI via FileProvider when available; file:// still works for own process paste.
      val clip = ClipData.newUri(context.contentResolver, "image", uri)
      // primaryClip is a val getter on modern SDKs — always use setPrimaryClip (API 11+).
      cm.setPrimaryClip(clip)
      lastFingerprint = "u:$uri"
      true
    } catch (_: Exception) {
      false
    }
  }

  fun compressJpegBase64(dataBase64: String, maxBytes: Int): Map<String, Any?>? {
    return try {
      val bytes = Base64.decode(dataBase64, Base64.DEFAULT)
      val bmp = BitmapFactory.decodeByteArray(bytes, 0, bytes.size) ?: return null
      var quality = 85
      var w = bmp.width
      var h = bmp.height
      var out: ByteArray
      while (true) {
        val scaled =
          if (w != bmp.width || h != bmp.height) {
            Bitmap.createScaledBitmap(bmp, w, h, true)
          } else {
            bmp
          }
        val baos = ByteArrayOutputStream()
        scaled.compress(Bitmap.CompressFormat.JPEG, quality, baos)
        out = baos.toByteArray()
        if (scaled !== bmp) scaled.recycle()
        if (out.size <= maxBytes || (quality <= 40 && w < 400)) break
        if (quality > 40) {
          quality -= 15
        } else {
          w = (w * 0.7).toInt().coerceAtLeast(200)
          h = (h * 0.7).toInt().coerceAtLeast(200)
          quality = 75
        }
      }
      if (out.size > maxBytes) return null
      mapOf(
        "mimeType" to "image/jpeg",
        "dataBase64" to Base64.encodeToString(out, Base64.NO_WRAP),
        "size" to out.size,
        "name" to "clipboard-${System.currentTimeMillis()}.jpg",
      )
    } catch (_: Exception) {
      null
    }
  }
}
