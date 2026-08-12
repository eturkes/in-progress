package dev.inprogress.frontier

import java.nio.charset.StandardCharsets
import java.security.MessageDigest
import java.util.HexFormat
import java.util.UUID
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json

@Serializable
data class ProbeInput(val value: String)

@Serializable
data class ProbeRequest(
  val operationId: String,
  val kind: String,
  val input: ProbeInput,
)

@Serializable
data class ProbeResult(
  val operationId: String,
  val value: String,
  val digest: String,
  val replayed: Boolean,
)

@Serializable
internal data class ExecutorErrorBody(val error: String)

internal object ProbeContract {
  const val KIND = "frontier-probe"
  const val MAX_VALUE_BYTES = 8 * 1024
  const val MAX_REQUEST_BYTES = 16 * 1024
  val json = Json { ignoreUnknownKeys = false }

  fun operationId(raw: String): String {
    val parsed = runCatching { UUID.fromString(raw) }.getOrNull()
    require(parsed != null && parsed.toString() == raw) { "workflow key must be a canonical UUID" }
    return raw
  }

  fun input(input: ProbeInput): ProbeInput {
    require(input.value.toByteArray(StandardCharsets.UTF_8).size <= MAX_VALUE_BYTES) {
      "probe value exceeds $MAX_VALUE_BYTES UTF-8 bytes"
    }
    return input
  }

  fun requestBody(request: ProbeRequest): String {
    val body = json.encodeToString(request)
    require(body.toByteArray(StandardCharsets.UTF_8).size <= MAX_REQUEST_BYTES) {
      "probe request exceeds $MAX_REQUEST_BYTES wire bytes"
    }
    return body
  }

  fun resultDigest(value: String): String =
    HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(value.toByteArray(StandardCharsets.UTF_8)))
}
