# Windows runtime input

The Windows installer bundles a self-contained `node.exe` next to this file.
`node.exe` is intentionally ignored by Git; GitHub Actions copies the Node 26
runtime into this directory before running the Tauri build.

Local development can place a Windows x64 Node 26 `node.exe` here and run the
same workflow commands from a Windows machine.
