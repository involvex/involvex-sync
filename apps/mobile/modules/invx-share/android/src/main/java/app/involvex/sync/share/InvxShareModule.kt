package app.involvex.sync.share

import android.content.ContentResolver
import android.content.Intent
import android.net.Uri
import android.provider.OpenableColumns
import android.util.Base64
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.Promise
import java.io.ByteArrayOutputStream

class InvxShareModule : Module() {
  private var pendingText: String? = null
  private var pendingFiles: List<Map<String, Any?>> = emptyList()

  override fun definition() = ModuleDefinition {
    Name("InvxShare")

    Events("onShareText", "onShareFiles")

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

    AsyncFunction("getSharedFiles") { promise: Promise ->
      promise.resolve(pendingFiles)
    }

    AsyncFunction("clearSharedFiles") { promise: Promise ->
      pendingFiles = emptyList()
      promise.resolve(null)
    }

    AsyncFunction("readSharedFileBase64") { uriString: String, maxBytes: Int, promise: Promise ->
      val context = appContext.reactContext
      if (context == null) {
        promise.reject("NO_CONTEXT", "React context missing", null)
        return@AsyncFunction
      }
      try {
        val uri = Uri.parse(uriString)
        val cr = context.contentResolver
        val name = queryDisplayName(cr, uri) ?: "file"
        val mime = cr.getType(uri) ?: "application/octet-stream"
        cr.openInputStream(uri)?.use { input ->
          val buffer = ByteArrayOutputStream()
          val chunk = ByteArray(8192)
          var total = 0
          while (true) {
            val n = input.read(chunk)
            if (n <= 0) break
            total += n
            if (total > maxBytes) {
              promise.reject("TOO_LARGE", "file exceeds $maxBytes bytes", null)
              return@AsyncFunction
            }
            buffer.write(chunk, 0, n)
          }
          val b64 = Base64.encodeToString(buffer.toByteArray(), Base64.NO_WRAP)
          promise.resolve(
            mapOf(
              "name" to name,
              "mimeType" to mime,
              "size" to total,
              "dataBase64" to b64,
            ),
          )
        } ?: promise.reject("READ_FAILED", "could not open uri", null)
      } catch (e: Exception) {
        promise.reject("READ_FAILED", e.message, e)
      }
    }
  }

  private fun captureIntent(intent: Intent?) {
    if (intent == null) return
    val action = intent.action ?: return
    if (action != Intent.ACTION_SEND && action != Intent.ACTION_SEND_MULTIPLE) return

    val type = intent.type ?: "*/*"
    if (type.startsWith("text/")) {
      val text = intent.getStringExtra(Intent.EXTRA_TEXT)
      if (!text.isNullOrBlank()) {
        pendingText = text
        sendEvent("onShareText", mapOf("text" to text))
      }
    }

    val uris = mutableListOf<Uri>()
    if (action == Intent.ACTION_SEND) {
      @Suppress("DEPRECATION")
      val stream = intent.getParcelableExtra<Uri>(Intent.EXTRA_STREAM)
      if (stream != null) uris.add(stream)
    } else {
      @Suppress("DEPRECATION")
      val list = intent.getParcelableArrayListExtra<Uri>(Intent.EXTRA_STREAM)
      if (list != null) uris.addAll(list)
    }

    if (uris.isEmpty()) return
    val context = appContext.reactContext ?: return
    val cr = context.contentResolver
    pendingFiles = uris.map { uri ->
      mapOf(
        "uri" to uri.toString(),
        "name" to (queryDisplayName(cr, uri) ?: "file"),
        "mimeType" to (cr.getType(uri) ?: type),
      )
    }
    sendEvent("onShareFiles", mapOf("files" to pendingFiles))
  }

  private fun queryDisplayName(cr: ContentResolver, uri: Uri): String? {
    if (uri.scheme == "content") {
      cr.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { c ->
        if (c.moveToFirst()) {
          val idx = c.getColumnIndex(OpenableColumns.DISPLAY_NAME)
          if (idx >= 0) return c.getString(idx)
        }
      }
    }
    return uri.lastPathSegment
  }
}
