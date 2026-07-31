import "@fontsource-variable/atkinson-hyperlegible-next";
import "@xterm/xterm/css/xterm.css";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./fonts.css";
import "./styles.css";

const root = document.querySelector<HTMLDivElement>("#root");
if (!root) throw new Error("Switchyard root element is missing");

function syncVisualViewport(): void {
  const viewport = window.visualViewport;
  document.documentElement.style.setProperty(
    "--app-height",
    `${Math.round(viewport?.height ?? window.innerHeight)}px`,
  );
  document.documentElement.style.setProperty(
    "--app-offset-top",
    `${Math.round(viewport?.offsetTop ?? 0)}px`,
  );
}

syncVisualViewport();
window.visualViewport?.addEventListener("resize", syncVisualViewport);
window.visualViewport?.addEventListener("scroll", syncVisualViewport);
createRoot(root).render(<App />);
