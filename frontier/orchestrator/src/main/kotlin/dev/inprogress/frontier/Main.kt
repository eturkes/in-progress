package dev.inprogress.frontier

import dev.restate.sdk.http.vertx.RestateHttpServer
import dev.restate.sdk.kotlin.endpoint.endpoint
import io.vertx.core.http.HttpServerOptions

fun main() {
  val server =
    RestateHttpServer.fromEndpoint(
      endpoint { bind(ProbeWorkflow()) },
      HttpServerOptions().setHost("127.0.0.1").setPort(9080),
    )
  server.listen().toCompletionStage().toCompletableFuture().join()
}
