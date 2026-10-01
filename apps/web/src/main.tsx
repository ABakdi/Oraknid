import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./index.css";
import { remote } from "./lib/remote";

createRoot(document.getElementById("root") as HTMLElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// Installable, and the target of web push (Notifications → Web push).
// Away from home the loader owns the page; the app registers nothing there.
if ("serviceWorker" in navigator && !remote()) {
  navigator.serviceWorker.register("/sw.js").catch(() => {});
}
