import {
  DriftAnalyzeRequestSchema,
  TreeForkRequestSchema,
  type PluginCapability,
  type TreeForkRequest,
  driftReportPath,
} from "../shared/contracts";

export type PluginAuthorityDecision =
  | { allowed: true; params: unknown }
  | { allowed: false; error: string };

const AUTHORITY_POLICY: Record<PluginCapability, "none" | "drift-analyze" | "tree-fork"> = {
  "project.metadata": "none",
  "project.tree": "none",
  "project.readText": "none",
  "project.git": "none",
  "host.notify": "none",
  "align.status": "none",
  "drift.render": "none",
  "drift.analyze": "drift-analyze",
  "tree-complete.workspace": "none",
  "tree-complete.createFork": "tree-fork",
};

function visibleLabel(value: string): string {
  return [...value]
    .map((character) => {
      const code = character.codePointAt(0)!;
      return code >= 0x20 && code <= 0x7e && character !== "\\"
        ? character
        : `\\u{${code.toString(16)}}`;
    })
    .join("");
}

function visibleId(value: string): string {
  return [...value]
    .map((character) =>
      /[A-Za-z0-9._/-]/.test(character)
        ? character
        : `\\u{${character.codePointAt(0)!.toString(16)}}`,
    )
    .join("");
}

export function confirmTreeForkRequest(
  pluginName: string,
  pluginId: string,
  projectName: string,
  projectId: string,
  mode: "preview" | "codex",
  request: TreeForkRequest,
  confirm: (message: string) => boolean,
): boolean {
  const identity = [
    `Plugin: ${visibleLabel(pluginName)}`,
    `Plugin ID: ${visibleId(pluginId)}`,
    `Project: ${visibleLabel(projectName)}`,
    `Project ID: ${visibleId(projectId)}`,
    `Base version: ${visibleId(request.baseVersionId)}`,
    `Decision: ${visibleId(request.decisionId)}`,
    `Alternative: ${visibleId(request.alternativeId)}`,
  ].join("\n");
  const authority =
    mode === "preview"
      ? "Preview mode writes only Tree Complete's host-owned simulation state. It does not run Codex or change the project repository."
      : "Codex mode runs `codex --yolo` unsandboxed as the current OS user. Codex can read or modify anything that user can access; it may create a Git branch/worktree, change files, and create a commit.";
  return confirm(`Tree Complete fork request\n\n${identity}\n\n${authority}\n\nContinue?`);
}

function confirmDriftAnalysis(
  pluginName: string,
  pluginId: string,
  projectName: string,
  projectId: string,
  tracePath: string,
  confirm: (message: string) => boolean,
): boolean {
  const identity = [
    `Plugin: ${visibleLabel(pluginName)}`,
    `Plugin ID: ${visibleId(pluginId)}`,
    `Project: ${visibleLabel(projectName)}`,
    `Project ID: ${visibleId(projectId)}`,
    `Trace: ${visibleLabel(tracePath)}`,
    `Report: ${visibleLabel(driftReportPath(tracePath))}`,
  ].join("\n");
  return confirm(
    `Drift trace analysis\n\n${identity}\n\n` +
      "This runs gpt-5.6-sol through authenticated Codex using your ChatGPT subscription. " +
      "Trace content is sent to OpenAI and may contain source, terminal output, personal data, or secrets.\n\n" +
      "Drift will create or replace the report inside the selected project. The trace is embedded in that report.\n\n" +
      "Continue?",
  );
}

export function authorizePluginRequest(
  method: PluginCapability,
  params: unknown,
  pluginName: string,
  pluginId: string,
  projectName: string,
  projectId: string,
  mode: "preview" | "codex" | null,
  confirm: (message: string) => boolean,
): PluginAuthorityDecision {
  const policy = AUTHORITY_POLICY[method];
  if (policy === "none") return { allowed: true, params };
  if (policy === "drift-analyze") {
    const request = DriftAnalyzeRequestSchema.safeParse(params);
    if (!request.success) return { allowed: false, error: "Invalid Drift trace request" };
    if (
      !confirmDriftAnalysis(
        pluginName,
        pluginId,
        projectName,
        projectId,
        request.data.path,
        confirm,
      )
    ) {
      return { allowed: false, error: "Drift analysis canceled by the user" };
    }
    return { allowed: true, params: request.data };
  }
  const request = TreeForkRequestSchema.safeParse(params);
  if (!request.success) {
    return { allowed: false, error: "Invalid Tree Complete fork request" };
  }
  if (mode === null) {
    return { allowed: false, error: "Tree Complete integration is not configured" };
  }
  if (
    !confirmTreeForkRequest(
      pluginName,
      pluginId,
      projectName,
      projectId,
      mode,
      request.data,
      confirm,
    )
  ) {
    return { allowed: false, error: "Fork canceled by the user" };
  }
  return { allowed: true, params: request.data };
}
