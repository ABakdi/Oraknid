import { createContext, type ReactNode, useContext, useEffect, useState } from "react";
import { store } from "./store";

export type ThemeChoice = "dark" | "light" | "system";

const Ctx = createContext<{
  choice: ThemeChoice;
  resolved: "dark" | "light";
  set: (t: ThemeChoice) => void;
}>({
  choice: "dark",
  resolved: "dark",
  set: () => {},
});

const prefersDark = () => window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? true;

/** Dark first (Web-UI → Look), light, or following the system; remembered per device. */
export function ThemeProvider({ children }: { children: ReactNode }) {
  const [choice, setChoice] = useState<ThemeChoice>(
    () => (store.get("theme") as ThemeChoice | null) ?? "dark",
  );
  const [systemDark, setSystemDark] = useState(prefersDark);
  useEffect(() => {
    const m = window.matchMedia?.("(prefers-color-scheme: dark)");
    const on = () => setSystemDark(m.matches);
    m?.addEventListener("change", on);
    return () => m?.removeEventListener("change", on);
  }, []);
  const resolved = choice === "system" ? (systemDark ? "dark" : "light") : choice;
  useEffect(() => {
    document.documentElement.classList.toggle("dark", resolved === "dark");
    document
      .querySelector('meta[name="theme-color"]')
      ?.setAttribute("content", resolved === "dark" ? "#0b0a12" : "#efedf6");
  }, [resolved]);
  return (
    <Ctx.Provider
      value={{
        choice,
        resolved,
        set: (t) => {
          store.set("theme", t);
          setChoice(t);
        },
      }}
    >
      {children}
    </Ctx.Provider>
  );
}

export const useTheme = () => useContext(Ctx);
