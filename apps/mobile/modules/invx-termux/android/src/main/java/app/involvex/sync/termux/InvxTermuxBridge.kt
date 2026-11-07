package app.involvex.sync.termux

import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

object InvxTermuxBridge {
  private data class Waiter(
    val latch: CountDownLatch = CountDownLatch(1),
    @Volatile var result: Map<String, Any?>? = null,
  )

  private val waiters = ConcurrentHashMap<String, Waiter>()

  fun beginWait(requestId: String) {
    waiters[requestId] = Waiter()
  }

  fun complete(
    requestId: String,
    result: Map<String, Any?>,
  ) {
    val waiter = waiters[requestId] ?: return
    waiter.result = result
    waiter.latch.countDown()
  }

  fun await(
    requestId: String,
    timeoutMs: Long,
  ): Map<String, Any?> {
    val waiter = waiters[requestId] ?: return mapOf(
      "ok" to false,
      "exitCode" to -1,
      "stdout" to "",
      "stderr" to "",
      "errmsg" to "internal: waiter missing",
    )
    try {
      val done = waiter.latch.await(timeoutMs, TimeUnit.MILLISECONDS)
      if (!done) {
        return mapOf(
          "ok" to false,
          "exitCode" to -1,
          "stdout" to "",
          "stderr" to "",
          "errmsg" to
            "Timed out waiting for Termux result. " +
            "If allow-external-apps is set, check Termux notification " +
            "for the real error (missing termux-api, bad path, etc.).",
        )
      }
      return waiter.result ?: mapOf(
        "ok" to false,
        "exitCode" to -1,
        "stdout" to "",
        "stderr" to "",
        "errmsg" to "empty Termux result",
      )
    } finally {
      waiters.remove(requestId)
    }
  }
}
