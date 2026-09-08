import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Bootstrap } from "./views/application/bootstrap.tsx";
import "./styles.css";

const rootElement = document.getElementById("root");
if (rootElement === null) throw new Error("Missing application root");

createRoot(rootElement).render(
  <StrictMode>
    <Bootstrap />
  </StrictMode>,
);
