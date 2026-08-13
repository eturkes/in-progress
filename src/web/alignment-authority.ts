import type { AlignSetupRequest, ProjectDto } from "../shared/contracts";

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

export function confirmAlignmentSetup(
  project: Pick<ProjectDto, "id" | "name" | "displayPath">,
  request: AlignSetupRequest,
  confirm: (message: string) => boolean,
): boolean {
  const bytes = new TextEncoder().encode(request.prompt).byteLength;
  return confirm(
    [
      "Set up Alignment",
      "",
      `Project: ${visible(project.name)}`,
      `Project ID: ${visible(project.id)}`,
      `Project root: ${visible(project.displayPath)}`,
      "",
      `The textarea's exact UTF-8 text (${bytes} bytes, including whitespace) becomes the immutable initiating intent.`,
      "Alignment writes .align inside this project's configured root and captures the current repository as its initial in_progress snapshot.",
      "The exact intent is sent only to this in-progress host; no model or external service is contacted. The baseline cannot be replaced through in-progress.",
      "",
      "Set up Alignment?",
    ].join("\n"),
  );
}
