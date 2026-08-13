import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App.jsx";

document.body.style.margin = "0";
createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
