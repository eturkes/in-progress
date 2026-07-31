import type { KeyboardEvent as ReactKeyboardEvent } from "react";

const FOCUSABLE =
  'a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), iframe[tabindex="0"], [tabindex]:not([tabindex="-1"])';

export function trapTab(event: ReactKeyboardEvent<HTMLElement>): void {
  if (event.key !== "Tab") return;
  const elements = [...event.currentTarget.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
    (element) => !element.hidden && element.getClientRects().length > 0,
  );
  if (elements.length === 0) {
    event.preventDefault();
    return;
  }
  const first = elements[0]!;
  const last = elements.at(-1)!;
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

export function moveRovingTab(event: ReactKeyboardEvent<HTMLElement>): void {
  if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
  const tabs = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
  const index = tabs.indexOf(event.target as HTMLButtonElement);
  if (index < 0 || tabs.length === 0) return;
  event.preventDefault();
  const nextIndex =
    event.key === "Home"
      ? 0
      : event.key === "End"
        ? tabs.length - 1
        : (index + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
  const next = tabs[nextIndex]!;
  next.focus();
  next.click();
}
