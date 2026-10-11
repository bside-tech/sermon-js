import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { applyTheme } from "sermon-js/react";
import { StatusPage } from "sermon-js/react/heroui";
import "./index.css";

// Apply the viewer's theme before the first paint
applyTheme();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <StatusPage baseUrl="/api" brand={<h1 className="text-lg font-semibold">Acme Status</h1>} />
  </StrictMode>
);
