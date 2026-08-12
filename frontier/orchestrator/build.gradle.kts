plugins {
  application
  kotlin("jvm") version "2.4.0"
  kotlin("plugin.serialization") version "2.4.0"
  kotlin("plugin.allopen") version "2.4.0"
}

repositories { mavenCentral() }

if (System.getProperty("java.version") != "26.0.2") {
  throw GradleException("frontier orchestrator requires JDK 26.0.2, received ${System.getProperty("java.version")}")
}

val restateVersion = "2.9.3"

dependencies {
  implementation("dev.restate:sdk-kotlin-http:$restateVersion")
  implementation("io.vertx:vertx-core:4.5.30")
  implementation("org.apache.logging.log4j:log4j-api:2.25.3")
  runtimeOnly("org.apache.logging.log4j:log4j-core:2.25.3")
  testImplementation(kotlin("test"))
}

dependencyLocking {
  lockAllConfigurations()
  lockMode.set(org.gradle.api.artifacts.dsl.LockMode.STRICT)
}

kotlin { jvmToolchain(26) }

allOpen {
  annotation("dev.restate.sdk.annotation.Service")
  annotation("dev.restate.sdk.annotation.VirtualObject")
  annotation("dev.restate.sdk.annotation.Workflow")
}

application {
  mainClass.set("dev.inprogress.frontier.MainKt")
  applicationDefaultJvmArgs = listOf(
    "--enable-native-access=ALL-UNNAMED",
    "--sun-misc-unsafe-memory-access=allow",
  )
}

tasks.test { useJUnitPlatform() }
