package app.involvex.sync.mdns

import android.content.Context
import android.net.nsd.NsdManager
import android.net.nsd.NsdServiceInfo
import android.os.Build
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.net.InetAddress
import java.nio.charset.Charset

class InvxMdnsModule : Module() {
  private var nsdManager: NsdManager? = null
  private var discoveryListener: NsdManager.DiscoveryListener? = null
  private val resolveListeners = mutableListOf<NsdManager.ResolveListener>()

  companion object {
    const val SERVICE_TYPE = "_invxconnect._tcp."
  }

  override fun definition() = ModuleDefinition {
    Name("InvxMdns")
    Events("onServiceFound", "onServiceLost", "onError")

    AsyncFunction("startBrowse") {
      val context = appContext.reactContext ?: throw Exceptions.ReactContextLost()
      stopBrowseInternal()
      val manager = context.getSystemService(Context.NSD_SERVICE) as NsdManager
      nsdManager = manager

      val listener = object : NsdManager.DiscoveryListener {
        override fun onDiscoveryStarted(regType: String) {}
        override fun onDiscoveryStopped(serviceType: String) {}
        override fun onStartDiscoveryFailed(serviceType: String, errorCode: Int) {
          sendEvent("onError", mapOf("message" to "start failed: $errorCode"))
        }
        override fun onStopDiscoveryFailed(serviceType: String, errorCode: Int) {
          sendEvent("onError", mapOf("message" to "stop failed: $errorCode"))
        }
        override fun onServiceFound(service: NsdServiceInfo) {
          resolveService(manager, service)
        }
        override fun onServiceLost(service: NsdServiceInfo) {
          sendEvent(
            "onServiceLost",
            mapOf(
              "name" to (service.serviceName ?: ""),
              "deviceId" to readAttr(service, "id"),
            ),
          )
        }
      }
      discoveryListener = listener
      manager.discoverServices(SERVICE_TYPE, NsdManager.PROTOCOL_DNS_SD, listener)
      true
    }

    AsyncFunction("stopBrowse") {
      stopBrowseInternal()
      true
    }

    OnDestroy {
      stopBrowseInternal()
    }
  }

  private fun resolveService(manager: NsdManager, service: NsdServiceInfo) {
    val resolveListener = object : NsdManager.ResolveListener {
      override fun onResolveFailed(serviceInfo: NsdServiceInfo, errorCode: Int) {
        sendEvent("onError", mapOf("message" to "resolve failed: $errorCode"))
      }

      override fun onServiceResolved(info: NsdServiceInfo) {
        val host = hostAddress(info) ?: return
        sendEvent(
          "onServiceFound",
          mapOf(
            "name" to (readAttr(info, "name").ifEmpty { info.serviceName ?: "PC" }),
            "deviceId" to readAttr(info, "id"),
            "host" to host,
            "port" to info.port,
            "type" to readAttr(info, "type").ifEmpty { "windows" },
          ),
        )
      }
    }
    resolveListeners.add(resolveListener)
    @Suppress("DEPRECATION")
    manager.resolveService(service, resolveListener)
  }

  private fun hostAddress(info: NsdServiceInfo): String? {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
      val addrs = info.hostAddresses
      if (!addrs.isNullOrEmpty()) {
        return addrs[0].hostAddress
      }
    }
    @Suppress("DEPRECATION")
    val host: InetAddress? = info.host
    return host?.hostAddress
  }

  private fun readAttr(info: NsdServiceInfo, key: String): String {
    val attrs = info.attributes ?: return ""
    val bytes = attrs[key] ?: return ""
    return try {
      String(bytes, Charset.forName("UTF-8"))
    } catch (_: Exception) {
      ""
    }
  }

  private fun stopBrowseInternal() {
    val manager = nsdManager
    val listener = discoveryListener
    if (manager != null && listener != null) {
      try {
        manager.stopServiceDiscovery(listener)
      } catch (_: Exception) {
      }
    }
    discoveryListener = null
    resolveListeners.clear()
    nsdManager = null
  }
}
