export type ThemePreference = "auto" | "light" | "dark";
export type ResolvedTheme = Exclude<ThemePreference, "auto">;

export const THEME_STORAGE_KEY = "in-progress:theme";
export const SYSTEM_THEME_QUERY = "(prefers-color-scheme: dark)";

interface PluginThemeTokens {
  background: string;
  surface: string;
  surfaceRaised: string;
  border: string;
  text: string;
  muted: string;
  accent: string;
  warning: string;
  danger: string;
  uiFont: string;
  monoFont: string;
}

interface TerminalTheme {
  background: string;
  foreground: string;
  cursor: string;
  cursorAccent: string;
  selectionBackground: string;
  black: string;
  red: string;
  green: string;
  yellow: string;
  blue: string;
  magenta: string;
  cyan: string;
  white: string;
  brightBlack: string;
  brightRed: string;
  brightGreen: string;
  brightYellow: string;
  brightBlue: string;
  brightMagenta: string;
  brightCyan: string;
  brightWhite: string;
}

interface ThemeDefinition {
  browserColor: string;
  pluginTokens: PluginThemeTokens;
  terminal: TerminalTheme;
}

export const THEME_DEFINITIONS = {
  light: {
    browserColor: "#f4f7f6",
    pluginTokens: {
      background: "#f4f7f6",
      surface: "#ffffff",
      surfaceRaised: "#e9efec",
      border: "#c4d0cc",
      text: "#17231f",
      muted: "#65736f",
      accent: "#0b715b",
      warning: "#946000",
      danger: "#b83245",
      uiFont: "Atkinson Hyperlegible Next",
      monoFont: "Iosevka",
    },
    terminal: {
      background: "#f4f7f6",
      foreground: "#26312d",
      cursor: "#0b715b",
      cursorAccent: "#ffffff",
      selectionBackground: "#93cebcaa",
      black: "#26312d",
      red: "#ad293d",
      green: "#0b715b",
      yellow: "#865800",
      blue: "#2f5fb3",
      magenta: "#7546a8",
      cyan: "#087181",
      white: "#56635f",
      brightBlack: "#62706b",
      brightRed: "#c43d50",
      brightGreen: "#0f765f",
      brightYellow: "#925f00",
      brightBlue: "#3d68b8",
      brightMagenta: "#8b5abd",
      brightCyan: "#0b7686",
      brightWhite: "#17231f",
    },
  },
  dark: {
    browserColor: "#0b0e14",
    pluginTokens: {
      background: "#0b0e14",
      surface: "#121722",
      surfaceRaised: "#18202c",
      border: "#283142",
      text: "#e7ecf4",
      muted: "#909cb0",
      accent: "#67d5b5",
      warning: "#f2b84b",
      danger: "#ff6b78",
      uiFont: "Atkinson Hyperlegible Next",
      monoFont: "Iosevka",
    },
    terminal: {
      background: "#0b0e14",
      foreground: "#dbe4ee",
      cursor: "#67d5b5",
      cursorAccent: "#0b0e14",
      selectionBackground: "#315d56aa",
      black: "#121722",
      red: "#ff6b78",
      green: "#67d5b5",
      yellow: "#f2b84b",
      blue: "#7aa2f7",
      magenta: "#bb9af7",
      cyan: "#58c7d6",
      white: "#dbe4ee",
      brightBlack: "#68758a",
      brightRed: "#ff8993",
      brightGreen: "#84e3c7",
      brightYellow: "#ffd074",
      brightBlue: "#9bb9ff",
      brightMagenta: "#cfb4ff",
      brightCyan: "#82dce7",
      brightWhite: "#ffffff",
    },
  },
} as const satisfies Record<ResolvedTheme, ThemeDefinition>;

export function parseThemePreference(value: string | null): ThemePreference {
  return value === "light" || value === "dark" ? value : "auto";
}

export function resolveTheme(
  preference: ThemePreference,
  systemPrefersDark: boolean,
): ResolvedTheme {
  return preference === "auto" ? (systemPrefersDark ? "dark" : "light") : preference;
}

export function pluginTheme(mode: ResolvedTheme) {
  return { mode, tokens: THEME_DEFINITIONS[mode].pluginTokens };
}
