import type { PreviewGenerationRequest, PreviewStatus } from "../shared/contracts";

function visible(value: string): string {
  return [...value]
    .map((character) => {
      const code = character.codePointAt(0)!;
      return code >= 0x20 && code <= 0x7e && character !== "\\"
        ? character
        : `\\u{${code.toString(16)}}`;
    })
    .join("");
}

function directionLines(prompt: string): string[] {
  const direction = visible(prompt);
  if (!direction) return [];
  const suffix = direction.length > 1_000 ? "\n[…direction truncated in confirmation…]" : "";
  return ["", "Preview direction:", `${direction.slice(0, 1_000)}${suffix}`];
}

export function confirmPreviewGeneration(
  status: PreviewStatus,
  project: { id: string; name: string },
  request: PreviewGenerationRequest,
  confirm: (message: string) => boolean,
): boolean {
  const action =
    request.strategy === "fresh"
      ? "Regenerate Preview from scratch"
      : status.dashboard
        ? "Update Preview dashboard"
        : "Generate Preview dashboard";
  return confirm(
    [
      action,
      "",
      `Project: ${visible(project.name)}`,
      `Project ID: ${visible(project.id)}`,
      `Model: ${status.model}`,
      `Reasoning effort: ${status.reasoningEffort}`,
      `External output: ${visible(status.artifactDirectory)}`,
      `Strategy: ${
        request.strategy === "fresh"
          ? "fresh current-source generation"
          : status.dashboard
            ? "evolve the prior validated Preview"
            : "initial current-source generation"
      }`,
      ...directionLines(request.prompt),
      ...(status.mode === "automatic" && request.prompt !== status.prompt
        ? [
            "",
            "Automatic mode is active. This direction will also govern future runs at clean new commits.",
          ]
        : []),
      "",
      "This uses authenticated Codex through your ChatGPT subscription and spends subscription usage. A failed Codex invocation or invalid/unreadable output may trigger one complete repair retry (two Codex invocations maximum; each invocation can make multiple model requests and tool continuations). Codex and its shell can read any host-readable content, which may be sent to OpenAI; the read-only OS sandbox is not a confidentiality boundary. Repository instructions and skills are suppressed, but your global ~/.codex/AGENTS.md remains model-visible trusted authority. Continue only if you trust the source checkout and global instructions. Generated dashboard files are written only to the external output above.",
      "",
      "Continue?",
    ].join("\n"),
  );
}

export function confirmPreviewAutomatic(
  status: PreviewStatus,
  project: { id: string; name: string },
  prompt: string,
  confirm: (message: string) => boolean,
): boolean {
  return confirm(
    [
      "Enable automatic Preview updates",
      "",
      `Project: ${visible(project.name)}`,
      `Project ID: ${visible(project.id)}`,
      `Model: ${status.model}`,
      `Reasoning effort: ${status.reasoningEffort}`,
      `External output: ${visible(status.artifactDirectory)}`,
      ...directionLines(prompt),
      "",
      "This grants ongoing subscription-spending Preview runs while in-progress is running. A first run starts when no current Preview exists; later runs start only at a new clean Git commit. Dirty worktrees wait, and a failed commit is not retried automatically. Each run may make up to two Codex invocations, and each invocation can make multiple model requests and tool continuations.",
      "",
      "Codex and its shell can read any host-readable content, which may be sent to OpenAI; the read-only OS sandbox is not a confidentiality boundary. Repository instructions and skills are suppressed, but your global ~/.codex/AGENTS.md remains model-visible trusted authority. Validated artifacts and their generation metadata are committed only to the local Git repository at the external output; Preview never pushes it or mutates the project repository.",
      "",
      "Enable automatic updates?",
    ].join("\n"),
  );
}
