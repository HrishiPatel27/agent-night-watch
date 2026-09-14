# Nightwatch for VS Code

Start, watch and review guarded overnight agent runs without leaving the editor. The extension is a thin
client over the `nightwatch` CLI: install the CLI first (`npm install -g nightwatch-agent`).

Commands (Command Palette → "Nightwatch"):

- **Initialize this repository** – runs `nightwatch init` with a chosen preset.
- **Start a guarded run** – asks for the task, hours and budget, then runs `nightwatch run` in a terminal.
- **Show run status / Stop the active run**
- **Open latest report** – renders the morning report in a webview.
- **Open live dashboard** – opens the loopback dashboard of the active run.
- **Check a command against the policy** – `nightwatch policy check`.
- **Edit policy.yaml**

The status bar shows the active run's action and block counts.

Build: `npm run build --workspace packages/vscode`; package: `npm run package --workspace packages/vscode` (produces a `.vsix` you can install with *Extensions: Install from VSIX…*).
