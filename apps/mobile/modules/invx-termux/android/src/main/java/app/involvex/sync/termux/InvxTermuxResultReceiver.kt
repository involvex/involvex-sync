package app.involvex.sync.termux

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Bundle

/**
 * Receives Termux RUN_COMMAND PendingIntent results and completes waiting promises.
 */
class InvxTermuxResultReceiver : BroadcastReceiver() {
  override fun onReceive(
    context: Context?,
    intent: Intent?,
  ) {
    if (intent == null) return
    val requestId = intent.getStringExtra(EXTRA_REQUEST_ID) ?: return
    InvxTermuxBridge.complete(requestId, parseResult(intent))
  }

  companion object {
    const val ACTION_SUFFIX = ".TERMUX_RUN_RESULT"
    const val EXTRA_REQUEST_ID = "invx_termux_request_id"

    fun parseResult(intent: Intent): Map<String, Any?> {
      val invx = "com.involvex.termux_app"
      val official = "com.termux"

      val bundleKeys =
        listOf(
          // TermuxConstants.TERMUX_SERVICE.EXTRA_PLUGIN_RESULT_BUNDLE
          "$invx.service_plugin_result_bundle",
          "$official.service_plugin_result_bundle",
          "$invx.plugin_result",
          "$official.plugin_result",
          "result",
        )
      var bundle: Bundle? = null
      for (key in bundleKeys) {
        bundle = intent.getBundleExtra(key)
        if (bundle != null) break
      }

      var exitCode = -1
      var stdout = ""
      var stderr = ""
      var errmsg: String? = null

      if (bundle != null) {
        exitCode =
          firstInt(
            bundle,
            listOf(
              "$invx.service_plugin_result_bundle_exit_code",
              "$official.service_plugin_result_bundle_exit_code",
              "$invx.plugin_result.exit_code",
              "$official.plugin_result.exit_code",
              "exitCode",
              "resultCode",
            ),
            -1,
          )
        stdout =
          firstString(
            bundle,
            listOf(
              "$invx.service_plugin_result_bundle_stdout",
              "$official.service_plugin_result_bundle_stdout",
              "$invx.plugin_result.stdout",
              "$official.plugin_result.stdout",
              "stdout",
            ),
          )
        stderr =
          firstString(
            bundle,
            listOf(
              "$invx.service_plugin_result_bundle_stderr",
              "$official.service_plugin_result_bundle_stderr",
              "$invx.plugin_result.stderr",
              "$official.plugin_result.stderr",
              "stderr",
            ),
          )
        errmsg =
          firstStringOrNull(
            bundle,
            listOf(
              "$invx.service_plugin_result_bundle_errmsg",
              "$official.service_plugin_result_bundle_errmsg",
              "$invx.plugin_result.errmsg",
              "$official.plugin_result.errmsg",
              "errmsg",
            ),
          )
      } else {
        exitCode =
          intent.getIntExtra(
            "$invx.RUN_COMMAND_RESULT_CODE",
            intent.getIntExtra(
              "$official.RUN_COMMAND_RESULT_CODE",
              intent.getIntExtra("resultCode", -1),
            ),
          )
        errmsg =
          intent.getStringExtra("$invx.RUN_COMMAND_ERRMSG")
            ?: intent.getStringExtra("$official.RUN_COMMAND_ERRMSG")
        stdout = intent.getStringExtra("stdout") ?: ""
        stderr = intent.getStringExtra("stderr") ?: ""
      }

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
