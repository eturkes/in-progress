import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  THEME_DEFINITIONS,
  parseThemePreference,
  pluginTheme,
  resolveTheme,
} from "../src/web/theme";

function luminance(hex: string): number {
  return [1, 3, 5]
    .map((index) => Number.parseInt(hex.slice(index, index + 2), 16) / 255)
    .map((channel) => (channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4))
    .reduce((sum, channel, index) => sum + channel * [0.2126, 0.7152, 0.0722][index]!, 0);
}

function contrast(first: string, second: string): number {
  const values = [luminance(first), luminance(second)].sort((left, right) => right - left);
  return (values[0]! + 0.05) / (values[1]! + 0.05);
}

describe("theme preferences", () => {
  test("defaults absent and invalid stored values to auto", () => {
    expect(parseThemePreference(null)).toBe("auto");
    expect(parseThemePreference("sepia")).toBe("auto");
    expect(parseThemePreference("AUTO")).toBe("auto");
  });

  test("preserves every supported preference", () => {
    expect(["auto", "light", "dark"].map(parseThemePreference)).toEqual(["auto", "light", "dark"]);
  });

  test("resolves auto from the system while explicit choices win", () => {
    expect(resolveTheme("auto", false)).toBe("light");
    expect(resolveTheme("auto", true)).toBe("dark");
    expect(resolveTheme("light", true)).toBe("light");
    expect(resolveTheme("dark", false)).toBe("dark");
  });

  test("exports complete resolved plugin themes", () => {
    for (const mode of ["light", "dark"] as const) {
      const exported = pluginTheme(mode);
      const tokens = THEME_DEFINITIONS[mode].pluginTokens;
      expect(exported.mode).toBe(mode);
      expect(exported.tokens).toBe(tokens);
      for (const token of [
        "background",
        "surface",
        "surfaceRaised",
        "border",
        "text",
        "muted",
        "accent",
        "warning",
        "danger",
      ] as const) {
        expect(tokens[token]).toMatch(/^#[0-9a-f]{6}$/);
      }
      expect(tokens.uiFont).toBe("Atkinson Hyperlegible Next");
      expect(tokens.monoFont).toBe("Iosevka");
    }
  });

  test("keeps light UI and terminal foregrounds at WCAG AA contrast", () => {
    const definition = THEME_DEFINITIONS.light;
    const { background, text, muted, accent, warning, danger } = definition.pluginTokens;
    for (const foreground of [text, muted, accent, warning, danger]) {
      expect(contrast(foreground, background)).toBeGreaterThanOrEqual(4.5);
    }

    const terminalForegrounds = Object.entries(definition.terminal)
      .filter(([name]) =>
        /^(foreground|black|red|green|yellow|blue|magenta|cyan|white|bright)/.test(name),
      )
      .map(([, color]) => color);
    for (const foreground of terminalForegrounds) {
      expect(contrast(foreground, definition.terminal.background)).toBeGreaterThanOrEqual(4.5);
    }
  });

  test("keeps host CSS palette anchors aligned with plugin tokens", () => {
    const css = readFileSync(new URL("../src/web/styles.css", import.meta.url), "utf8");
    const light = THEME_DEFINITIONS.light.pluginTokens;
    const dark = THEME_DEFINITIONS.dark.pluginTokens;
    for (const [property, token] of [
      ["bg", "background"],
      ["surface-raised", "surfaceRaised"],
      ["border", "border"],
      ["text", "text"],
      ["muted", "muted"],
      ["accent", "accent"],
      ["warning", "warning"],
      ["danger", "danger"],
    ] as const) {
      expect(css).toContain(`--${property}: light-dark(${light[token]}, ${dark[token]})`);
    }
  });
});
