package app.involvex.sync.termux

import android.app.PendingIntent
import android.content.ComponentName
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.Parcel
import android.os.ResultReceiver
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.util.UUID
import java.util.concurrent.Executors

class InvxTermuxModule : Module() {
  private val waitExecutor = Executors.newCachedThreadPool()

  override fun definition() = ModuleDefinition {
    Name("InvxTermux")

    // Returns a result map after Termux fires the PendingIntent (or timeout).
    AsyncFunction("startRunCommand") { spec: Map<String, Any?> ->
      val context = appContext.reactContext
        ?: throw Exceptions.ReactContextLost()

      val action = spec["action"] as? String
        ?: throw IllegalArgumentException("action required")
      val packageName = spec["packageName"] as? String
        ?: throw IllegalArgumentException("packageName required")
      val serviceClass = spec["serviceClass"] as? String
        ?: throw IllegalArgumentException("serviceClass required")
      val commandPathRaw = spec["commandPath"] as? String
        ?: throw IllegalArgumentException("commandPath required")

      @Suppress("UNCHECKED_CAST")
      val args = (spec["args"] as? List<*>)?.map { it.toString() } ?: emptyList()
      val workdir = spec["workdir"] as? String
      val background = spec["background"] as? Boolean ?: true
      val label = spec["label"] as? String
      val stdin = spec["stdin"] as? String
      val timeoutMs =
        ((spec["timeoutMs"] as? Number)?.toLong() ?: 20_000L).coerceIn(3_000L, 60_000L)

      if (!isPackageInstalled(packageName)) {
        throw Exception(
          "Termux package not installed ($packageName). Install InVx Termux first.",
        )
      }

      val commandPath =
        resolveTermuxPath(
          context.filesDir.absolutePath,
          context.packageName,
          packageName,
          commandPathRaw,
        )
      val requestId = UUID.randomUUID().toString()
      InvxTermuxBridge.beginWait(requestId)

      // Same pattern as InVx termux-terminal-widget CommandRunner: parcel a
      // ResultReceiver into the PendingIntent so Termux can deliver results
      // across packages. Use getBroadcast — getService is dropped by Android
      // 12+ when Termux (another UID) tries to start our background Service.
      val resultReceiver =
        object : ResultReceiver(Handler(Looper.getMainLooper())) {
          override fun onReceiveResult(
            resultCode: Int,
            resultData: Bundle?,
          ) {
            val parsed =
              if (resultData != null) {
                InvxTermuxResultReceiver.parseResultBundle(resultData)
              } else {
                mapOf(
                  "ok" to false,
                  "exitCode" to -1,
                  "stdout" to "",
                  "stderr" to "",
                  "errmsg" to "empty Termux result bundle",
                )
              }
            InvxTermuxBridge.complete(requestId, parsed)
          }
        }

      val resultIntent =
        Intent(context, InvxTermuxResultReceiver::class.java).apply {
          setAction("${context.packageName}${InvxTermuxResultReceiver.ACTION_SUFFIX}")
          putExtra(InvxTermuxResultReceiver.EXTRA_REQUEST_ID, requestId)
          putExtra(Intent.EXTRA_RESULT_RECEIVER, receiverForSending(resultReceiver))
        }

      val piFlags =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
          PendingIntent.FLAG_ONE_SHOT or PendingIntent.FLAG_MUTABLE
        } else {
          PendingIntent.FLAG_ONE_SHOT
        }

      val pendingIntent =
        PendingIntent.getBroadcast(
          context,
          requestId.hashCode(),
          resultIntent,
          piFlags,
        )

      val intent =
        Intent(action).apply {
          component = ComponentName(packageName, serviceClass)
          putExtra("$packageName.RUN_COMMAND_PATH", commandPath)
          putExtra("$packageName.RUN_COMMAND_ARGUMENTS", args.toTypedArray())
          putExtra("$packageName.RUN_COMMAND_BACKGROUND", background)
          putExtra(
            "$packageName.RUN_COMMAND_WORKDIR",
            workdir ?: "~/",
          )
          putExtra("$packageName.RUN_COMMAND_PENDING_INTENT", pendingIntent)
          if (!stdin.isNullOrEmpty()) {
            putExtra("$packageName.RUN_COMMAND_STDIN", stdin)
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
      } catch (e: SecurityException) {
        InvxTermuxBridge.complete(
          requestId,
          mapOf(
            "ok" to false,
            "exitCode" to -1,
            "stdout" to "",
            "stderr" to "",
            "errmsg" to
              "Missing $packageName.permission.RUN_COMMAND or user denied it. " +
                "Also set allow-external-apps=true in Termux ~/.termux/termux.properties",
            "termuxPackage" to packageName,
            "commandPath" to commandPath,
          ),
        )
      } catch (e: IllegalStateException) {
        InvxTermuxBridge.complete(
          requestId,
          mapOf(
            "ok" to false,
            "exitCode" to -1,
            "stdout" to "",
            "stderr" to "",
            "errmsg" to
              "Could not start Termux RunCommandService: ${e.message}. " +
                "Check allow-external-apps=true in ~/.termux/termux.properties " +
                "and that serviceClass is com.invapp.app.RunCommandService",
            "termuxPackage" to packageName,
            "commandPath" to commandPath,
          ),
        )
      }

      // Never block the Expo/JS thread — wait on a worker so the result
      // BroadcastReceiver / ResultReceiver can run on the main looper.
      val future =
        waitExecutor.submit<Map<String, Any?>> {
          val result = InvxTermuxBridge.await(requestId, timeoutMs).toMutableMap()
          result["termuxPackage"] = packageName
          result["commandPath"] = commandPath
          result
        }
      future.get()
    }

    AsyncFunction("isPackageInstalled") { packageName: String ->
      isPackageInstalled(packageName)
    }

    AsyncFunction("resolveInstalledTermux") {
      val context = appContext.reactContext ?: throw Exceptions.ReactContextLost()
      val candidates =
        listOf(
          "com.involvex.termux_app",
          "com.termux",
        )
      val installed =
        candidates.filter { pkg ->
          try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
              context.packageManager.getPackageInfo(
                pkg,
                PackageManager.PackageInfoFlags.of(0),
              )
            } else {
              @Suppress("DEPRECATION")
              context.packageManager.getPackageInfo(pkg, 0)
            }
            true
          } catch (_: PackageManager.NameNotFoundException) {
            false
          }
        }
      mapOf(
        "target" to "com.involvex.termux_app",
        "installed" to installed,
        "using" to installed.firstOrNull { it == "com.involvex.termux_app" },
      )
    }
  }

  private fun isPackageInstalled(packageName: String): Boolean {
    val context = appContext.reactContext ?: return false
    return try {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
        context.packageManager.getPackageInfo(
          packageName,
          PackageManager.PackageInfoFlags.of(0),
        )
      } else {
        @Suppress("DEPRECATION")
        context.packageManager.getPackageInfo(packageName, 0)
      }
      true
    } catch (_: PackageManager.NameNotFoundException) {
      false
    }
  }

  companion object {
    /**
     * Expand `$PREFIX` / `~/` to absolute paths under the Termux data dir.
     * InVx RunCommandService rejects literal `$PREFIX` before shell expand.
     */
    fun resolveTermuxPath(
      syncFilesDir: String,
      syncPackage: String,
      termuxPackage: String,
      commandPath: String,
    ): String {
      val dataDirPrefix =
        syncFilesDir
          .split("/$syncPackage")
          .first()
      val termuxFiles = "$dataDirPrefix/$termuxPackage/files"
      val prefix = "$termuxFiles/usr"
      val home = "$termuxFiles/home"
      return when {
        commandPath.startsWith("\$PREFIX") ->
          commandPath.replace("\$PREFIX", prefix)
        commandPath.startsWith("~/") ->
          home + commandPath.removePrefix("~")
        commandPath == "~" -> home
        else -> commandPath
      }
    }

    /**
     * Make a ResultReceiver sendable across packages (Termux → Sync).
     * See https://stackoverflow.com/a/12183036 and termux-terminal-widget.
     */
    fun receiverForSending(original: ResultReceiver): ResultReceiver {
      val parcel = Parcel.obtain()
      try {
        original.writeToParcel(parcel, 0)
        parcel.setDataPosition(0)
        return ResultReceiver.CREATOR.createFromParcel(parcel)
      } finally {
        parcel.recycle()
      }
    }
  }
}
