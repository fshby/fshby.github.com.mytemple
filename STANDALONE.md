# Standalone Packaging Target

This project must not use Electron or bundle Chromium. Those routes usually make the final app far larger than 10 MB.

## Target

- Final `.exe` target: under 10 MB.
- UI runtime: system WebView2 on Windows, not a bundled browser.
- Backend/runtime: native executable code, not bundled Node.js.
- Assets: keep `public/`, `docs/`, and `source/` outside the executable or compress them as external resources.

## Recommended Architecture

1. Keep the current HTML/CSS/JS UI as the frontend.
2. Replace `server.js` with a small native local HTTP server for production packaging.
3. Launch a WebView2 window that points to the local server.
4. Package only the native launcher and server code into the executable.
5. Keep Markdown documents and pasted screenshots as user data beside the executable.

## Size Rules

- Do not use Electron.
- Do not bundle Chromium.
- Do not bundle Node.js into the final executable.
- Avoid large icon packs, UI libraries, and Markdown libraries.
- Keep all rendering code local and dependency-free unless a dependency is proven small.

## Current Status

The current implementation is browser-based for development and testing. Its frontend is dependency-free, which keeps it ready for a later WebView2 wrapper. The remaining production packaging task is replacing the Node.js server with a native implementation or a tiny embedded runtime.
