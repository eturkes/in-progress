package dev.inprogress.frontier

import dev.restate.sdk.common.TerminalException
import java.net.URI
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.nio.charset.StandardCharsets
import java.time.Duration
import kotlin.coroutines.resumeWithException
import kotlin.coroutines.suspendCoroutine

class ExecutorClient(
  endpoint: String = System.getenv("IN_PROGRESS_EXECUTOR_URL") ?: "http://127.0.0.1:4319",
) {
  private val baseUri = requireLoopback(endpoint)
  private val client =
    HttpClient.newBuilder()
      .proxy(HttpClient.Builder.NO_PROXY)
      .connectTimeout(Duration.ofSeconds(2))
      .build()
  private val json = ProbeContract.json

  suspend fun execute(request: ProbeRequest): ProbeResult {
    val body = ProbeContract.requestBody(request)
    val call =
      HttpRequest.newBuilder(baseUri.resolve("/v1/operations"))
        .timeout(Duration.ofSeconds(5))
        .header("content-type", "application/json")
        .POST(HttpRequest.BodyPublishers.ofString(body))
        .build()
    val response = send(call)
    val terminalError = terminalError(response.statusCode(), response.body())
    if (terminalError != null) throw terminalError
    if (response.statusCode() !in 200..299) {
      throw IllegalStateException("executor temporarily unavailable: HTTP ${response.statusCode()}")
    }
    val result: ProbeResult = try {
      json.decodeFromString<ProbeResult>(response.body())
    } catch (_: Exception) {
      throw IllegalStateException("executor returned an invalid result")
    }
    check(result.operationId == request.operationId) { "executor returned a mismatched operation ID" }
    check(result.value == request.input.value) { "executor returned a mismatched result value" }
    check(result.digest == ProbeContract.resultDigest(result.value)) {
      "executor returned an invalid result digest"
    }
    check(
      (response.statusCode() == 201 && !result.replayed) ||
        (response.statusCode() == 200 && result.replayed),
    ) {
      "executor returned inconsistent receipt metadata"
    }
    return result
  }

  private suspend fun send(call: HttpRequest): HttpResponse<String> =
    suspendCoroutine { continuation ->
      client
        .sendAsync(
          call,
          HttpResponse.BodyHandlers.limiting(
            HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8),
            RESPONSE_LIMIT_BYTES.toLong(),
          ),
        )
        .whenComplete { response, error ->
          if (error != null) continuation.resumeWithException(error)
          else continuation.resumeWith(Result.success(response))
        }
    }

  private fun terminalError(status: Int, body: String): TerminalException? {
    val error = runCatching { json.decodeFromString<ExecutorErrorBody>(body).error }.getOrNull()
    return when {
      status == 409 && error == "operation_id_conflict" ->
        TerminalException(TerminalException.ABORTED_CODE, "executor operation ID conflicts with its stored request")
      status in setOf(400, 413, 415, 422) && error == "invalid_request" ->
        TerminalException(TerminalException.BAD_REQUEST_CODE, "executor rejected the operation contract")
      else -> null
    }
  }

  companion object {
    // Accepted request JSON is <=16 KiB; escaped receipt JSON adds fixed envelope overhead.
    private const val RESPONSE_LIMIT_BYTES = 32 * 1024

    internal fun requireLoopback(raw: String): URI {
      val uri = URI.create(raw)
      require(uri.scheme == "http") { "executor endpoint must use HTTP" }
      require(uri.userInfo == null && uri.query == null && uri.fragment == null) {
        "executor endpoint must not contain credentials, query, or fragment"
      }
      require(uri.host in setOf("127.0.0.1", "::1", "[::1]")) {
        "executor endpoint must be loopback"
      }
      require(uri.port in 1..65535) { "executor endpoint must include a port" }
      require(uri.path.isNullOrEmpty() || uri.path == "/") { "executor endpoint must not include a path" }
      return uri
    }
  }
}
