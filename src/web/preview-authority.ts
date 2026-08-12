import type { PreviewStatus } from "../shared/contracts";

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

export function confirmPreviewGeneration(
  status: PreviewStatus,
  project: { id: string; name: string },
  confirm: (message: string) => boolean,
): boolean {
  const action = status.dashboard ? "Update" : "Generate";
  return confirm(
    [
      `${action} Preview dashboard`,
      "",
      `Project: ${visible(project.name)}`,
      `Project ID: ${visible(project.id)}`,
      `Model: ${status.model}`,
      `Reasoning effort: ${status.reasoningEffort}`,
      `External output: ${visible(status.artifactDirectory)}`,
      "",
      "This uses authenticated Codex through your ChatGPT subscription and spends subscription usage. A failed Codex invocation or invalid/unreadable output may trigger one complete repair retry (two Codex invocations maximum; each invocation can make multiple model requests and tool continuations). Codex and its shell can read any host-readable content, which may be sent to OpenAI; the read-only OS sandbox is not a confidentiality boundary. Repository instructions and skills are suppressed, but your global ~/.codex/AGENTS.md remains model-visible trusted authority. Continue only if you trust the source checkout and global instructions. Generated dashboard files are written only to the external output above.",
      "",
      "Continue?",
    ].join("\n"),
  );
}
