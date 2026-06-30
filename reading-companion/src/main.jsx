import React from "react";
import ReactDOM from "react-dom/client";
import App, { PopoutApp } from "./App";

const isPopout = new URLSearchParams(window.location.search).get("mode") === "popout";

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    {isPopout ? <PopoutApp /> : <App />}
  </React.StrictMode>
);
