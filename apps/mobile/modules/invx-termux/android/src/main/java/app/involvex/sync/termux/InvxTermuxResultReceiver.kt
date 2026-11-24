package app.involvex.sync.termux

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.os.ResultReceiver

/**
 * Receives Termux RUN_COMMAND PendingIntent results.
 *
 * Termux's ResultSender merges a `"result"` Bundle into the PendingIntent
 * extras (`stdout` / `stderr` / `exitCode` / `errmsg`). We forward that to
 * the in-process [ResultReceiver] (widget pattern) and also complete the
 * bridge waiter by request id.
 */
class InvxTermuxResultReceiver : BroadcastReceiver() {
  override fun onReceive(
    context: Context?,
    intent: Intent?,
  ) {
    if (intent == null) return

    val requestId = intent.getStringExtra(EXTRA_REQUEST_ID)
    val resultBundle = extractResultBundle(intent)
    val parsed =
      if (resultBundle != null) {
        parseResultBundle(resultBundle)
      } else {
        parseResult(intent)
      }

    // Prefer ResultReceiver so completion works even if request id was dropped.
    @Suppress("DEPRECATION")
    val receiver =
      intent.getParcelableExtra<ResultReceiver>(Intent.EXTRA_RESULT_RECEIVER)
    if (receiver != null && resultBundle != null) {
      receiver.send(0, resultBundle)
      // ResultReceiver already completed the waiter; still fall through if
      // requestId path is needed when ResultReceiver was not the one we packed.
    }

    if (!requestId.isNullOrBlank()) {
      InvxTermuxBridge.complete(requestId, parsed)
    }
  }

  companion object {
    const val ACTION_SUFFIX = ".TERMUX_RUN_RESULT"
    const val EXTRA_REQUEST_ID = "invx_termux_request_id"

    fun extractResultBundle(intent: Intent): Bundle? {
      val keys =
        listOf(
          // TermuxConstants.TERMUX_SERVICE.EXTRA_PLUGIN_RESULT_BUNDLE = "result"
          "result",
          "com.involvex.termux_app.service_plugin_result_bundle",
          "com.termux.service_plugin_result_bundle",
          "com.involvex.termux_app.plugin_result",
          "com.termux.plugin_result",
        )
      for (key in keys) {
        val bundle = intent.getBundleExtra(key)
        if (bundle != null) return bundle
      }
      return null
    }

    /** Parse Termux's plugin result Bundle (`result` extra keys). */
    fun parseResultBundle(bundle: Bundle): Map<String, Any?> {
      val exitCode =
        firstInt(
          bundle,
          listOf(
            "exitCode",
            "com.involvex.termux_app.service_plugin_result_bundle_exit_code",
            "com.termux.service_plugin_result_bundle_exit_code",
          ),
          -1,
        )
      val stdout =
        firstString(
          bundle,
          listOf(
            "stdout",
            "com.involvex.termux_app.service_plugin_result_bundle_stdout",
            "com.termux.service_plugin_result_bundle_stdout",
          ),
        )
      val stderr =
        firstString(
          bundle,
          listOf(
            "stderr",
            "com.involvex.termux_app.service_plugin_result_bundle_stderr",
            "com.termux.service_plugin_result_bundle_stderr",
          ),
        )
      val errmsg =
        firstStringOrNull(
          bundle,
          listOf(
            "errmsg",
            "com.involvex.termux_app.service_plugin_result_bundle_errmsg",
            "com.termux.service_plugin_result_bundle_errmsg",
          ),
        )
      val ok = errmsg.isNullOrBlank() && exitCode == 0
      return mapOf(
        "ok" to ok,
        "exitCode" to exitCode,
        "stdout" to stdout,
        "stderr" to stderr,
        "errmsg" to (errmsg ?: ""),
      )
    }

    fun parseResult(intent: Intent): Map<String, Any?> {
      val bundle = extractResultBundle(intent)
      if (bundle != null) return parseResultBundle(bundle)

      val invx = "com.involvex.termux_app"
      val official = "com.termux"
      val exitCode =
        intent.getIntExtra(
          "$invx.RUN_COMMAND_RESULT_CODE",
          intent.getIntExtra(
            "$official.RUN_COMMAND_RESULT_CODE",
            intent.getIntExtra("resultCode", -1),
          ),
        )
      val errmsg =
        intent.getStringExtra("$invx.RUN_COMMAND_ERRMSG")
          ?: intent.getStringExtra("$official.RUN_COMMAND_ERRMSG")
      val stdout = intent.getStringExtra("stdout") ?: ""
      val stderr = intent.getStringExtra("stderr") ?: ""
      val ok = errmsg.isNullOrBlank() && exitCode == 0
      return mapOf(
        "ok" to ok,
        "exitCode" to exitCode,
        "stdout" to stdout,
        "stderr" to stderr,
        "errmsg" to (errmsg ?: ""),
      )
    }

    private fun firstInt(
      bundle: Bundle,
      keys: List<String>,
      default: Int,
    ): Int {
      for (key in keys) {
        if (bundle.containsKey(key)) return bundle.getInt(key, default)
      }
      return default
    }

    private fun firstString(
      bundle: Bundle,
      keys: List<String>,
    ): String = firstStringOrNull(bundle, keys) ?: ""

    private fun firstStringOrNull(
      bundle: Bundle,
      keys: List<String>,
    ): String? {
      for (key in keys) {
        val v = bundle.getString(key)
        if (v != null) return v
      }
      return null
    }
  }
}
