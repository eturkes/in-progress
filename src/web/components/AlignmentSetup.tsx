import { ChartColumn, CircleAlert } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { AlignStatus, ProjectDto } from "../../shared/contracts";

interface AlignmentSetupProps {
  project: ProjectDto;
  status?: AlignStatus;
  error?: string;
  draft: string;
  starting: boolean;
  onDraft: (value: string) => void;
  onSetup: () => void;
}

export function AlignmentSetup({
  project,
  status,
  error,
  draft,
  starting,
  onDraft,
  onSetup,
}: AlignmentSetupProps) {
  const [open, setOpen] = useState(false);
  const controlsRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const menuId = `alignment-setup-${project.id}`;
  const promptBytes = new TextEncoder().encode(draft).byteLength;
  const valid = draft.trim().length > 0 && promptBytes <= 60_000;

  useEffect(() => {
    if (!open) return;
    textareaRef.current?.focus();
    const closeOutside = (event: PointerEvent) => {
      if (!controlsRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpen(false);
      triggerRef.current?.focus();
    };
    document.addEventListener("pointerdown", closeOutside);
    window.addEventListener("keydown", closeOnEscape, true);
    return () => {
      document.removeEventListener("pointerdown", closeOutside);
      window.removeEventListener("keydown", closeOnEscape, true);
    };
  }, [open]);

  return (
    <div className="alignment-setup" ref={controlsRef}>
      <button
        ref={triggerRef}
        type="button"
        className={`alignment-setup-trigger ${starting ? "is-busy" : ""}`}
        disabled={!status || Boolean(error) || starting}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={menuId}
        title={error ?? "Freeze this project's exact initiating intent and initial snapshot"}
        onClick={() => setOpen((value) => !value)}
      >
        <ChartColumn size={15} aria-hidden="true" />
        <span>
          {error
            ? "Alignment unavailable"
            : starting
              ? "Setting up…"
              : status
                ? "Set up Alignment"
                : "Checking Alignment…"}
        </span>
      </button>
      {open && status && !status.initialized ? (
        <section
          id={menuId}
          className="alignment-setup-panel"
          role="dialog"
          aria-label="Set up Alignment"
        >
          <div className="alignment-setup-heading">
            <div>
              <strong>Freeze initiating intent</strong>
              <span>One immutable baseline for {project.name}</span>
            </div>
            <span className="alignment-setup-badge">local</span>
          </div>
          <p className="alignment-setup-copy">
            Paste the exact request that started this project. Alignment stores it verbatim and
            captures the repository's current state as the initial in-progress snapshot.
          </p>
          <label className="alignment-intent-field">
            <span>
              Initiating intent <small>{promptBytes.toLocaleString()}/60,000 UTF-8 bytes</small>
            </span>
            <textarea
              ref={textareaRef}
              value={draft}
              maxLength={60_000}
              rows={8}
              placeholder="Paste the original project request…"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              onChange={(event) => onDraft(event.target.value)}
            />
          </label>
          {promptBytes > 60_000 ? (
            <p className="alignment-setup-warning">
              <CircleAlert size={14} aria-hidden="true" />
              Shorten the intent to 60,000 UTF-8 bytes.
            </p>
          ) : null}
          <button
            type="button"
            className="alignment-setup-submit"
            disabled={!valid || starting}
            onClick={onSetup}
          >
            <ChartColumn size={15} aria-hidden="true" />
            {starting ? "Freezing baseline…" : "Set up Alignment"}
          </button>
          <p className="alignment-setup-note">
            Writes only project-local .align state · no model or external service
          </p>
        </section>
      ) : null}
    </div>
  );
}
