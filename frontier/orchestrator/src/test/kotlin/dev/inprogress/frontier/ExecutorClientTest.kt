package dev.inprogress.frontier

import com.sun.net.httpserver.HttpServer
import dev.restate.sdk.common.TerminalException
import java.net.InetSocketAddress
import java.util.concurrent.CountDownLatch
import java.util.concurrent.atomic.AtomicReference
import kotlin.coroutines.Continuation
import kotlin.coroutines.EmptyCoroutineContext
import kotlin.coroutines.startCoroutine
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith

class ExecutorClientTest {
  @Test
  fun acceptsLoopbackEndpoints() {
    ExecutorClient.requireLoopback("http://127.0.0.1:4319")
    ExecutorClient.requireLoopback("http://[::1]:4319")
  }

  @Test
  fun rejectsRemoteOrDecoratedEndpoints() {
    listOf(
        "https://127.0.0.1:4319",
        "http://192.0.2.1:4319",
        "http://localhost:4319",
        "http://127.0.0.1:4319/path",
        "http://user@127.0.0.1:4319",
        "http://127.0.0.1:4319?override=true",
      )
      .forEach { assertFailsWith<IllegalArgumentException>(it) { ExecutorClient.requireLoopback(it) } }
  }

  @Test
  fun sendsTheStrictWireContractAndCorrelatesTheReceipt() {
    val operationId = "3f6dfba4-5f40-4a58-9cf9-56c7228c6c49"
    val (server, capturedBody) = serverResponding(
      201,
      """{"operationId":"$operationId","value":"probe","digest":"ba9c736f19e7f60b7f6764adb0b7908c0a2b394e09b6c09863528c7f2bc86095","replayed":false}""",
    )
    try {
      val result =
        runSuspend {
          ExecutorClient("http://127.0.0.1:${server.address.port}")
            .execute(ProbeRequest(operationId, "frontier-probe", ProbeInput("probe")))
        }
      assertEquals(operationId, result.operationId)
      assertEquals("probe", result.value)
      assertEquals(
        """{"operationId":"$operationId","kind":"frontier-probe","input":{"value":"probe"}}""",
        capturedBody.get(),
      )
    } finally {
      server.stop(0)
    }
  }

  @Test
  fun ambiguousResponsesRetryAndDurableConflictsTerminate() {
    val operationId = "3f6dfba4-5f40-4a58-9cf9-56c7228c6c49"
    val request = ProbeRequest(operationId, "frontier-probe", ProbeInput("probe"))
    val cases = listOf(
      Triple(201, "{", IllegalStateException::class),
      Triple(201, """{"operationId":"00000000-0000-0000-0000-000000000000","value":"probe","digest":"ba9c736f19e7f60b7f6764adb0b7908c0a2b394e09b6c09863528c7f2bc86095","replayed":false}""", IllegalStateException::class),
      Triple(201, """{"operationId":"$operationId","value":"wrong","digest":"8810ad581e59f2bc3928b261707a71308f7e1394222f0526e107565493abf01b","replayed":false}""", IllegalStateException::class),
      Triple(201, """{"operationId":"$operationId","value":"probe","digest":"${"a".repeat(64)}","replayed":false}""", IllegalStateException::class),
      Triple(201, """{"operationId":"$operationId","value":"probe","digest":"ba9c736f19e7f60b7f6764adb0b7908c0a2b394e09b6c09863528c7f2bc86095","replayed":true}""", IllegalStateException::class),
      Triple(202, """{"operationId":"$operationId","value":"probe","digest":"ba9c736f19e7f60b7f6764adb0b7908c0a2b394e09b6c09863528c7f2bc86095","replayed":false}""", IllegalStateException::class),
      Triple(408, "{}", IllegalStateException::class),
      Triple(429, "{}", IllegalStateException::class),
      Triple(500, "{}", IllegalStateException::class),
      Triple(403, """{"error":"invalid_request"}""", IllegalStateException::class),
      Triple(409, "{}", IllegalStateException::class),
      Triple(409, """{"error":"operation_id_conflict"}""", TerminalException::class),
      Triple(400, """{"error":"invalid_request"}""", TerminalException::class),
    )
    cases.forEach { (status, body, expected) ->
      val (server) = serverResponding(status, body)
      try {
        val thrown = assertFailsWith<RuntimeException> {
          runSuspend { ExecutorClient("http://127.0.0.1:${server.address.port}").execute(request) }
        }
        check(expected.java.isInstance(thrown)) {
          "expected ${expected.simpleName}, received ${thrown::class.simpleName}"
        }
      } finally {
        server.stop(0)
      }
    }
  }

  @Test
  fun validatesWorkflowIdentityAndUtf8InputBeforeTheDurableCall() {
    val operationId = "3f6dfba4-5f40-4a58-9cf9-56c7228c6c49"
    assertEquals(operationId, validatedProbeRequest(operationId, ProbeInput("probe")).operationId)
    assertEquals(
      "174b4c1869b668204e1fe9b948c3946954b2e7d2f32585faab5d8e9188f5334c",
      ProbeContract.resultDigest("界\n"),
    )
    listOf(
        "3F6DFBA4-5F40-4A58-9CF9-56C7228C6C49",
        "not-a-uuid",
        "1-1-1-1-1",
      )
      .forEach { key ->
        assertFailsWith<TerminalException>(key) { validatedProbeRequest(key, ProbeInput("probe")) }
      }
    assertFailsWith<TerminalException> {
      validatedProbeRequest(operationId, ProbeInput("界".repeat(ProbeContract.MAX_VALUE_BYTES / 3 + 1)))
    }
    assertFailsWith<TerminalException> {
      validatedProbeRequest(operationId, ProbeInput("\u0000".repeat(3_000)))
    }
    validatedProbeRequest(operationId, ProbeInput("x".repeat(ProbeContract.MAX_VALUE_BYTES)))
  }

  private fun serverResponding(status: Int, responseBody: String): Pair<HttpServer, AtomicReference<String>> {
    val server = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
    val capturedBody = AtomicReference("")
    server.createContext("/v1/operations") { exchange ->
      capturedBody.set(exchange.requestBody.bufferedReader().readText())
      val bytes = responseBody.toByteArray()
      exchange.responseHeaders.add("content-type", "application/json")
      exchange.sendResponseHeaders(status, bytes.size.toLong())
      exchange.responseBody.use { it.write(bytes) }
    }
    server.start()
    return server to capturedBody
  }

  private fun <T> runSuspend(block: suspend () -> T): T {
    val latch = CountDownLatch(1)
    val outcome = AtomicReference<Result<T>>()
    block.startCoroutine(
      object : Continuation<T> {
        override val context = EmptyCoroutineContext

        override fun resumeWith(result: Result<T>) {
          outcome.set(result)
          latch.countDown()
        }
      },
    )
    latch.await()
    return outcome.get().getOrThrow()
  }
}
