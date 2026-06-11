# Collab Code IDE

A free, open-source, browser-based collaborative coding workspace inspired by Visual Studio Code.

## Features

- Link-based shared rooms — share a URL to invite collaborators
- First participant becomes the host automatically
- Host can promote/demote users between editor and viewer roles
- Monaco Editor with syntax highlighting, indentation, tabs, minimap, and VS Code-like editing
- Shared file tree with create, rename, and delete actions
- Real-time collaborative editing powered by [Yjs](https://github.com/yjs/yjs)
- Remote cursor and selection indicators per user
- In-room chat
- Session-only storage — no data persists after the room closes

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | React + Vite |
| Editor | Monaco Editor (`@monaco-editor/react`) |
| Collaboration | Yjs + y-monaco |
| Backend | Node.js + Express |
| Real-time transport | WebSockets (`ws`) |

## Getting Started

### Prerequisites

- Node.js 18+
- npm 9+

### Install & run

```bash
npm install
npm run build
npm start
```

Open [http://127.0.0.1:3001](http://127.0.0.1:3001) in your browser.

### Development mode

Run the backend and Vite dev server in separate terminals:

```bash
# Terminal 1 — backend
npm start

# Terminal 2 — frontend (hot reload)
npm run dev
```

Then open [http://127.0.0.1:5173](http://127.0.0.1:5173).

## Scripts

| Script | Description |
|--------|-------------|
| `npm run dev` | Start Vite dev server with HMR |
| `npm run build` | Build frontend to `dist/` |
| `npm start` | Start the Express/WebSocket server |
| `npm run preview` | Preview the production build locally |

## MVP Scope

This version intentionally excludes: accounts, database persistence, terminal access, code execution, Git integration, debugging tools, and paid services.
