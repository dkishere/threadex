import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { SecurityGate } from "./Security";
import "./styles/app-01.css";
import "./styles/app-02.css";
import "./styles/app-03.css";
import "./styles/app-04.css";
import "./styles/app-05.css";
import "./styles/app-06.css";
import "./styles/app-07.css";
import "./styles/app-08.css";
import "./styles/app-09.css";
import "./styles/app-10.css";
import "./styles/app-11.css";

function registerServiceWorker() {
  if (!import.meta.env.PROD || !("serviceWorker" in navigator)) return;

  window.addEventListener("load", () => {
    void navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch((error: unknown) => {
      console.warn("Threadex could not register its service worker.", error);
    });
  });
}

registerServiceWorker();

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <SecurityGate><App /></SecurityGate>
  </React.StrictMode>
);
