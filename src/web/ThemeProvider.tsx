import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useState,
} from "react";
import {
  type ResolvedTheme,
  SYSTEM_THEME_QUERY,
  THEME_DEFINITIONS,
  THEME_STORAGE_KEY,
  type ThemePreference,
  parseThemePreference,
  resolveTheme,
} from "./theme";

interface ThemeContextValue {
  preference: ThemePreference;
  resolvedTheme: ResolvedTheme;
  setPreference: (preference: ThemePreference) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

function readPreference(): ThemePreference {
  try {
    return parseThemePreference(window.localStorage.getItem(THEME_STORAGE_KEY));
  } catch {
    return "auto";
  }
}

function persistPreference(preference: ThemePreference): void {
  try {
    if (preference === "auto") window.localStorage.removeItem(THEME_STORAGE_KEY);
    else window.localStorage.setItem(THEME_STORAGE_KEY, preference);
  } catch {
    // The selection remains active when persistent browser storage is unavailable.
  }
}

function systemPrefersDark(): boolean {
  return window.matchMedia(SYSTEM_THEME_QUERY).matches;
}

function applyDocumentTheme(preference: ThemePreference, resolvedTheme: ResolvedTheme): void {
  const root = document.documentElement;
  root.dataset.theme = resolvedTheme;
  root.dataset.themePreference = preference;
  document
    .querySelector<HTMLMetaElement>('meta[name="theme-color"]')
    ?.setAttribute("content", THEME_DEFINITIONS[resolvedTheme].browserColor);
  document
    .querySelector<HTMLMetaElement>('meta[name="color-scheme"]')
    ?.setAttribute("content", resolvedTheme);
}

export function initializeTheme(): void {
  const preference = readPreference();
  applyDocumentTheme(preference, resolveTheme(preference, systemPrefersDark()));
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [preference, setPreferenceState] = useState(readPreference);
  const [prefersDark, setPrefersDark] = useState(systemPrefersDark);
  const resolvedTheme = resolveTheme(preference, prefersDark);

  useEffect(() => {
    const media = window.matchMedia(SYSTEM_THEME_QUERY);
    const syncSystemTheme = () => setPrefersDark(media.matches);
    syncSystemTheme();
    media.addEventListener("change", syncSystemTheme);
    return () => media.removeEventListener("change", syncSystemTheme);
  }, []);

  useEffect(() => {
    const syncStoredTheme = (event: StorageEvent) => {
      if (event.key === THEME_STORAGE_KEY) setPreferenceState(parseThemePreference(event.newValue));
    };
    window.addEventListener("storage", syncStoredTheme);
    return () => window.removeEventListener("storage", syncStoredTheme);
  }, []);

  useLayoutEffect(() => applyDocumentTheme(preference, resolvedTheme), [preference, resolvedTheme]);

  const setPreference = useCallback((next: ThemePreference) => {
    persistPreference(next);
    setPreferenceState(next);
  }, []);
  const value = useMemo(
    () => ({ preference, resolvedTheme, setPreference }),
    [preference, resolvedTheme, setPreference],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const value = useContext(ThemeContext);
  if (!value) throw new Error("useTheme must be called within ThemeProvider");
  return value;
}
