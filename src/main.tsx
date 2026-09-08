import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import RuntimeSetup from "./RuntimeSetup";
import "./styles.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <RuntimeSetup><App /></RuntimeSetup>
  </React.StrictMode>,
);
