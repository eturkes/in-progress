import { ChevronDown, CircleAlert, RefreshCw, Sparkles } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { PreviewStatus, ProjectDto } from "../../shared/contracts";

interface PreviewControlsProps {
  project: ProjectDto;
  status?: PreviewStatus;
  error?: string;
  draft: string;
  starting: boolean;
  saving: boolean;
  onDraft: (value: string) => void;
  onRun: (strategy: "update" | "fresh") => void;
  onSave: (mode: "manual" | "automatic") => void;
}

export function PreviewControls({
  project,
  status,
  error,
  draft,
  starting,
  saving,
  onDraft,
  onRun,
  onSave,
}: PreviewControlsProps) {
  const [open, setOpen] = useState(false);
  const controlsRef = useRef<HTMLDivElement>(null);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const menuId = `preview-menu-${project.id}`;
  const busy = starting || saving || Boolean(status?.activeProjectId);

  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: PointerEvent) => {
      if (!controlsRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpen(false);
      menuButtonRef.current?.focus();
    };
    document.addEventListener("pointerdown", closeOutside);
    window.addEventListener("keydown", closeOnEscape, true);
    return () => {
      document.removeEventListener("pointerdown", closeOutside);
      window.removeEventListener("keydown", closeOnEscape, true);
    };
  }, [open]);

  return (
    <div className="preview-controls" ref={controlsRef}>
      <div className="preview-split-button">
        <button
          type="button"
          className={`preview-button ${status?.state === "generating" ? "is-busy" : ""}`}
          disabled={!status || Boolean(error) || busy}
          onClick={() => onRun("update")}
          title={
            error ??
            status?.error ??
            "Generate or incrementally update this project's external Preview dashboard"
          }
        >
          {status?.dashboard ? (
            <RefreshCw size={15} aria-hidden="true" />
          ) : (
            <Sparkles size={15} aria-hidden="true" />
          )}
          <span>
            {error
              ? "Preview unavailable"
              : starting || status?.state === "generating"
                ? "Generating…"
                : status?.activeProjectId
                  ? "Preview busy"
                  : status?.dashboard
                    ? "Update Preview"
                    : "Generate Preview"}
          </span>
        </button>
        <button
          ref={menuButtonRef}
          type="button"
          className="preview-menu-button"
          disabled={!status || Boolean(error)}
          aria-label="Preview generation settings"
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-controls={menuId}
          title="Preview mode, prompt, and fresh regeneration"
          onClick={() => setOpen((value) => !value)}
        >
          {status?.mode === "automatic" ? <span aria-hidden="true">A</span> : null}
          <ChevronDown size={13} aria-hidden="true" />
        </button>
      </div>
      {open && status ? (
        <section
          id={menuId}
          className="preview-menu"
          role="dialog"
          aria-label="Preview generation settings"
        >
          <div className="preview-menu-heading">
            <div>
              <strong>Preview lifecycle</strong>
              <span>
                {status.sourceRevision === null
                  ? "Manual only — source is not Git-backed"
                  : status.sourceDirty
                    ? "Uncommitted edits — automatic waits"
                    : status.stale
                      ? "Source commit needs a Preview"
                      : "Preview matches the source commit"}
              </span>
            </div>
            <span className={`preview-mode-badge is-${status.mode}`}>{status.mode}</span>
          </div>

          <fieldset className="preview-mode-options">
            <legend>Update mode</legend>
            <label>
              <input
                type="radio"
                name={`preview-update-mode-${project.id}`}
                checked={status.mode === "manual"}
                disabled={saving}
                onChange={() => onSave("manual")}
              />
              <span>
                <strong>Manual</strong>
                <small>Run only when requested</small>
              </span>
            </label>
            <label>
              <input
                type="radio"
                name={`preview-update-mode-${project.id}`}
                checked={status.mode === "automatic"}
                disabled={saving}
                onChange={() => onSave("automatic")}
              />
              <span>
                <strong>Automatic</strong>
                <small>Run once per clean new commit</small>
              </span>
            </label>
          </fieldset>

          <label className="preview-prompt-field">
            <span>
              Preview direction <small>{draft.length}/8000</small>
            </span>
            <textarea
              value={draft}
              maxLength={8_000}
              rows={5}
              placeholder="Emphasize a workflow, audience, risk, visual structure…"
              onChange={(event) => onDraft(event.target.value)}
            />
          </label>

          {status.automaticBlockedReason ? (
            <p className="preview-blocked">
              <CircleAlert size={14} aria-hidden="true" />
              {status.automaticBlockedReason}
            </p>
          ) : null}

          <dl className="preview-metadata">
            <div>
              <dt>Source</dt>
              <dd>{status.sourceRevision?.slice(0, 10) ?? "not Git-backed"}</dd>
            </div>
            <div>
              <dt>Generated</dt>
              <dd>{status.generatedRevision?.slice(0, 10) ?? "none"}</dd>
            </div>
            <div>
              <dt>Artifacts</dt>
              <dd>{status.artifactGitTracked ? "local Git" : "Git pending"}</dd>
            </div>
          </dl>

          <div className="preview-menu-actions">
            <button
              type="button"
              className="preview-save-button"
              disabled={saving || draft === status.prompt}
              onClick={() => onSave(status.mode)}
            >
              {saving ? "Saving…" : "Save direction"}
            </button>
            <button
              type="button"
              className="preview-fresh-button"
              disabled={busy}
              onClick={() => {
                setOpen(false);
                onRun("fresh");
              }}
            >
              <RefreshCw size={14} aria-hidden="true" />
              Regenerate from scratch
            </button>
          </div>
          <p className="preview-model-note">
            {status.model} · {status.reasoningEffort} · external local history
          </p>
        </section>
      ) : null}
    </div>
  );
}
