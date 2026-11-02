package app.involvex.sync.termux

import android.content.ComponentName
import android.content.Intent
import android.os.Build
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class InvxTermuxModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("InvxTermux")

    // Expo AsyncFunction supports at most 7 typed args (+ optional Promise).
    // Bundle the run-command payload into one map.
    AsyncFunction("startRunCommand") { spec: Map<String, Any?> ->
      val context = appContext.reactContext
        ?: throw Exceptions.ReactContextLost()

      val action = spec["action"] as? String
        ?: throw IllegalArgumentException("action required")
      val packageName = spec["packageName"] as? String
        ?: throw IllegalArgumentException("packageName required")
      val serviceClass = spec["serviceClass"] as? String
        ?: throw IllegalArgumentException("serviceClass required")
      val commandPath = spec["commandPath"] as? String
        ?: throw IllegalArgumentException("commandPath required")

      @Suppress("UNCHECKED_CAST")
      val args = (spec["args"] as? List<*>)?.map { it.toString() } ?: emptyList()
      val workdir = spec["workdir"] as? String
      val background = spec["background"] as? Boolean ?: true
      val label = spec["label"] as? String

      val intent = Intent(action).apply {
        component = ComponentName(packageName, serviceClass)
        putExtra("$packageName.RUN_COMMAND_PATH", commandPath)
        putExtra("$packageName.RUN_COMMAND_ARGUMENTS", args.toTypedArray())
        putExtra("$packageName.RUN_COMMAND_BACKGROUND", background)
        if (workdir != null) {
          putExtra("$packageName.RUN_COMMAND_WORKDIR", workdir)
        }
        if (label != null) {
          putExtra("$packageName.RUN_COMMAND_COMMAND_LABEL", label)
        }
      }

      try {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
          context.startForegroundService(intent)
        } else {
          context.startService(intent)
        }
        true
      } catch (e: SecurityException) {
        throw Exception(
          "Missing $packageName.permission.RUN_COMMAND or user denied it",
          e,
        )
      }
    }
  }
}
