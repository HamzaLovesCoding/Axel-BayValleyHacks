// Light by default; dark only when picked in Settings. Kept in its own localStorage key, outside the
// zustand store, so the inline script in the layout can read it before the first paint.
export type Theme = "light" | "dark";

const KEY = "theme";
const BAR = { light: "#f7f7f5", dark: "#0e0e0f" } satisfies Record<Theme, string>;

export const THEME_SCRIPT = `(function(){try{if(localStorage.getItem("${KEY}")==="dark")document.documentElement.setAttribute("data-theme","dark")}catch(e){}})()`;

export function readTheme(): Theme {
  try {
    return localStorage.getItem(KEY) === "dark" ? "dark" : "light";
  } catch {
    return "light";
  }
}

export function applyTheme(theme: Theme) {
  document.documentElement.setAttribute("data-theme", theme);
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", BAR[theme]);
}

const listeners = new Set<() => void>();

export function setTheme(theme: Theme) {
  try {
    localStorage.setItem(KEY, theme);
  } catch {}
  applyTheme(theme);
  listeners.forEach((fn) => fn());
}

export function subscribeTheme(fn: () => void) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
