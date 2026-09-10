import React from "react";
import ReactDOM from "react-dom/client";
import { getCurrentWindow } from "@tauri-apps/api/window";
import App from "./App";
import DropOverlay from "./DropOverlay";
import RuntimeSetup from "./RuntimeSetup";
import { loadStorage } from "./storage";
import "./styles.css";

const root = ReactDOM.createRoot(document.getElementById("root")!);
// The drop box window loads the same page.
if (getCurrentWindow().label === "dropbox") {
  root.render(<DropOverlay />);
} else {
  // Preferences are read synchronously while rendering, so they load first.
  void loadStorage().then(() => root.render(
    <React.StrictMode>
      <RuntimeSetup><App /></RuntimeSetup>
    </React.StrictMode>,
  ));
}
