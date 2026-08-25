import { useMemo, useState } from "react";
import { createRoot } from "react-dom/client";

import ChatMarkdown from "../t3code-viewer/t3/ChatMarkdown.jsx";
import "./viewer.css";

function readPayload() {
  const node = document.getElementById("claude-artifact-data");
  if (!node?.textContent) throw new Error("Missing artifact data.");
  return JSON.parse(node.textContent);
}

function App() {
  const artifact = useMemo(readPayload, []);
  const [dark, setDark] = useState(
    () => window.matchMedia("(prefers-color-scheme: dark)").matches,
  );
  return (
    <div className={dark ? "artifact-shell dark" : "artifact-shell"}>
      <header>
        <div>
          <span className="eyebrow">Recovered Claude artifact</span>
          <h1>{artifact.title}</h1>
          <p>{artifact.sourcePath}</p>
        </div>
        <nav>
          <a href={artifact.sourceName} download>Download source</a>
          <button type="button" onClick={() => setDark((value) => !value)}>
            {dark ? "Light" : "Dark"}
          </button>
        </nav>
      </header>
      <main>
        <ChatMarkdown text={artifact.source} className="markdown" />
      </main>
    </div>
  );
}

const root = document.getElementById("root");
if (root) createRoot(root).render(<App />);
