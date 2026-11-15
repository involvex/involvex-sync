package app.involvex.sync.clipboard

import android.content.ClipData
import android.content.ClipboardManager
import android.content.ComponentName
import android.content.Context
import android.content.ServiceConnection
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.net.Uri
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.RemoteException
import android.util.Base64
import android.util.Log
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.FileOutputStream
import rikka.shizuku.Shizuku

object InvxClipboardBridge {
  const val PREFS = "invx_clipboard"
  const val KEY_AUTO = "auto_enabled"
  const val KEY_IMAGES = "include_images"
  const val KEY_SHIZUKU = "shizuku_enabled"

  private const val TAG = "InvxClipboardBridge"
  private const val REQUEST_CODE_SHIZUKU = 7913
  private const val SHIZUKU_POLL_MS = 1200L

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

  // --- Shizuku background path ---

  @Volatile
  private var appContext: Context? = null

  @Volatile
  private var shizukuWanted = false

  @Volatile
  private var shizukuListening = false

  @Volatile
  private var shizukuBound = false

  @Volatile
  private var shizukuNeedReboot = false

  @Volatile
  private var shizukuListenersReady = false

  @Volatile
  private var shizukuService: IInvxClipboardUserService? = null

  private var userServiceArgs: Shizuku.UserServiceArgs? = null

  private val shizukuHandler = Handler(Looper.getMainLooper())

  private var shizukuPollRunnable: Runnable? = null

  private val shizukuPermissionListener =
    Shizuku.OnRequestPermissionResultListener { requestCode, grantResult ->
      if (requestCode != REQUEST_CODE_SHIZUKU) return@OnRequestPermissionResultListener
      val ctx = appContext ?: return@OnRequestPermissionResultListener
      if (grantResult == PackageManager.PERMISSION_GRANTED) {
        shizukuNeedReboot = false
        if (shizukuWanted) bindShizuku(ctx)
      } else {
        Log.i(TAG, "Shizuku permission denied")
      }
    }

  private val shizukuServiceConnection =
    object : ServiceConnection {
      override fun onServiceConnected(name: ComponentName?, binder: IBinder?) {
        if (binder != null && binder.pingBinder()) {
          shizukuService = IInvxClipboardUserService.Stub.asInterface(binder)
          shizukuListening = true
          shizukuBound = true
          shizukuNeedReboot = false
          startShizukuPoll()
          Log.i(TAG, "Shizuku UserService connected")
        } else {
          Log.w(TAG, "Shizuku UserService dead binder on connect")
          shizukuService = null
          shizukuListening = false
          shizukuBound = false
          shizukuNeedReboot = true
        }
      }

      override fun onServiceDisconnected(name: ComponentName?) {
        Log.i(TAG, "Shizuku UserService disconnected")
        stopShizukuPoll()
        shizukuService = null
        shizukuListening = false
        shizukuBound = false
      }
    }

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

  fun setShizukuEnabled(context: Context, enabled: Boolean) {
    appContext = context.applicationContext
    context
      .getSharedPreferences(PREFS, Context.MODE_PRIVATE)
      .edit()
      .putBoolean(KEY_SHIZUKU, enabled)
      .apply()
    shizukuWanted = enabled
    if (enabled) {
      ensureShizukuListeners()
      tryEnableShizuku(context.applicationContext)
    } else {
      unbindShizuku()
      shizukuNeedReboot = false
    }
  }

  fun isShizukuEnabled(context: Context): Boolean {
    return context
      .getSharedPreferences(PREFS, Context.MODE_PRIVATE)
      .getBoolean(KEY_SHIZUKU, false)
  }

  fun shizukuStatus(context: Context): Map<String, Any> {
    appContext = context.applicationContext
    val available = pingShizuku()
    val authorized =
      available &&
        try {
          Shizuku.checkSelfPermission() == PackageManager.PERMISSION_GRANTED
        } catch (_: Throwable) {
          false
        }
    val listening = shizukuListening && shizukuService != null
    val status =
      when {
        shizukuNeedReboot -> "need_reboot"
        !available -> "unavailable"
        !authorized -> "unauthorized"
        listening -> "listening"
        authorized -> "authorized"
        else -> "unavailable"
      }
    return mapOf(
      "status" to status,
      "available" to available,
      "authorized" to authorized,
      "listening" to listening,
    )
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

  private fun ensureShizukuListeners() {
    if (shizukuListenersReady) return
    try {
      Shizuku.addRequestPermissionResultListener(shizukuPermissionListener)
      Shizuku.addBinderReceivedListenerSticky {
        shizukuNeedReboot = false
        val ctx = appContext ?: return@addBinderReceivedListenerSticky
        if (shizukuWanted || isShizukuEnabled(ctx)) {
          tryEnableShizuku(ctx)
        }
      }
      Shizuku.addBinderDeadListener {
        stopShizukuPoll()
        shizukuService = null
        shizukuListening = false
        shizukuBound = false
        if (shizukuWanted) {
          shizukuNeedReboot = true
        }
        Log.i(TAG, "Shizuku binder dead")
      }
      shizukuListenersReady = true
    } catch (e: Throwable) {
      Log.w(TAG, "Failed to register Shizuku listeners", e)
    }
  }

  private fun pingShizuku(): Boolean {
    return try {
      Shizuku.pingBinder()
    } catch (_: Throwable) {
      false
    }
  }

  private fun tryEnableShizuku(context: Context) {
    appContext = context.applicationContext
    if (!pingShizuku()) {
      Log.i(TAG, "Shizuku not available")
      return
    }
    val granted =
      try {
        Shizuku.checkSelfPermission() == PackageManager.PERMISSION_GRANTED
      } catch (_: Throwable) {
        false
      }
    if (!granted) {
      try {
        Shizuku.requestPermission(REQUEST_CODE_SHIZUKU)
      } catch (e: Throwable) {
        Log.w(TAG, "Shizuku.requestPermission failed", e)
      }
      return
    }
    shizukuNeedReboot = false
    bindShizuku(context.applicationContext)
  }

  private fun bindShizuku(context: Context) {
    if (shizukuListening && shizukuService != null) return
    if (!pingShizuku()) return
    try {
      if (Shizuku.getVersion() < 10) {
        Log.w(TAG, "Shizuku API < 10; UserService unsupported")
        return
      }
      val args =
        Shizuku.UserServiceArgs(
          ComponentName(
            context.packageName,
            InvxClipboardUserService::class.java.name,
          ),
        )
          .daemon(false)
          .processNameSuffix("clip")
          .version(1)
      userServiceArgs = args
      Shizuku.bindUserService(args, shizukuServiceConnection)
      Log.i(TAG, "Shizuku.bindUserService requested")
    } catch (e: Throwable) {
      Log.w(TAG, "bindUserService failed", e)
      shizukuNeedReboot = true
    }
  }

  private fun unbindShizuku() {
    stopShizukuPoll()
    shizukuService = null
    shizukuListening = false
    val args = userServiceArgs
    if (args != null && shizukuBound) {
      try {
        Shizuku.unbindUserService(args, shizukuServiceConnection, true)
      } catch (e: Throwable) {
        Log.w(TAG, "unbindUserService failed", e)
      }
    }
    shizukuBound = false
  }

  private fun startShizukuPoll() {
    stopShizukuPoll()
    val runnable =
      object : Runnable {
        override fun run() {
          pollShizukuOnce()
          shizukuHandler.postDelayed(this, SHIZUKU_POLL_MS)
        }
      }
    shizukuPollRunnable = runnable
    shizukuHandler.post(runnable)
  }

  private fun stopShizukuPoll() {
    shizukuPollRunnable?.let { shizukuHandler.removeCallbacks(it) }
    shizukuPollRunnable = null
  }

  private fun pollShizukuOnce() {
    val ctx = appContext ?: return
    if (!shizukuWanted || !isAutoEnabled(ctx) || !shizukuListening) return
    val remote = shizukuService ?: return
    try {
      val text = remote.primaryText?.trim().orEmpty()
      if (text.isEmpty()) return
      val fp = "t:${text.hashCode()}"
      if (fp == lastFingerprint) return
      lastFingerprint = fp
      onText?.invoke(text)
    } catch (_: RemoteException) {
      Log.w(TAG, "Shizuku poll RemoteException — marking need_reboot")
      stopShizukuPoll()
      shizukuService = null
      shizukuListening = false
      shizukuBound = false
      shizukuNeedReboot = true
    } catch (e: Exception) {
      Log.w(TAG, "Shizuku poll failed", e)
    }
  }
}
