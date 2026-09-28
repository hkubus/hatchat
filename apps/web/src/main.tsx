window.addEventListener("error", (e) => {
  void fetch(`http://127.0.0.1:8899/js/error?${encodeURIComponent(e.message)}`, { mode: "no-cors" }).catch(() => undefined);
});
window.addEventListener("unhandledrejection", (e) => {
  void fetch(`http://127.0.0.1:8899/js/rejection?${encodeURIComponent(String(e.reason).slice(0, 120))}`, { mode: "no-cors" }).catch(() => undefined);
});

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("missing #root");

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
