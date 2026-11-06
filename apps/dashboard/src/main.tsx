import { createRoot } from "react-dom/client";
import { installDemoRouting } from "./lib/demo";
import { App } from "./App";

installDemoRouting();
createRoot(document.getElementById("root")!).render(<App />);
