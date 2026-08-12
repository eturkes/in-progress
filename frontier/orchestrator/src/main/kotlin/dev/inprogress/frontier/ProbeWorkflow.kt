package dev.inprogress.frontier

import dev.restate.sdk.common.TerminalException
import dev.restate.sdk.annotation.Workflow
import dev.restate.sdk.kotlin.runBlock
import dev.restate.sdk.kotlin.workflowKey

private const val CRASH_AFTER_EXECUTOR_ENV = "IN_PROGRESS_FRONTIER_CRASH_AFTER_EXECUTOR"

internal fun validatedProbeRequest(operationId: String, input: ProbeInput): ProbeRequest =
  try {
    ProbeRequest(
      operationId = ProbeContract.operationId(operationId),
      kind = ProbeContract.KIND,
      input = ProbeContract.input(input),
    ).also { ProbeContract.requestBody(it) }
  } catch (error: IllegalArgumentException) {
    throw TerminalException(TerminalException.BAD_REQUEST_CODE, error.message ?: "invalid probe request")
  }

@Workflow
class ProbeWorkflow(
  private val executor: ExecutorClient = ExecutorClient(),
  private val crashAfterExecutor: Boolean = System.getenv(CRASH_AFTER_EXECUTOR_ENV) == "1",
) {
  @Workflow
  suspend fun run(input: ProbeInput): ProbeResult {
    val request = validatedProbeRequest(workflowKey(), input)
    // Restate journals the response; the executor independently deduplicates the physical effect.
    return runBlock("idempotent executor call") {
      executor.execute(request).also {
        if (crashAfterExecutor) Runtime.getRuntime().halt(86)
      }
    }
  }
}
