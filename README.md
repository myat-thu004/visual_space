# Visual Workspace

A Milanote/Obsidian-inspired infinite canvas for notes, to-do lists, Kanban
boards, and link cards — with a real backend and a SQLite database, so
everything you create is saved and reloaded automatically.

## Project structure

```
visual-workspace/
├── package.json
├── data/
│   └── workspace.db        ← SQLite database file (created automatically)
├── server/
│   ├── index.js            ← Express server (API + static file host)
│   └── db.js                ← Database schema, seed data, load/save logic
└── public/
    ├── index.html            ← App shell
    ├── styles.css            ← All styling
    └── app.js                 ← Canvas, cards, kanban, file tree, autosave
```

## Requirements

- Node.js **22.5+** (uses the built-in `node:sqlite` module — no native
  compilation or extra database server needed).

## Run it

From a terminal, inside the `visual-workspace` folder:

```bash
npm install
npm start
```

You should see:

```
  Visual Workspace running at http://localhost:4000
  Database file: /path/to/visual-workspace/data/workspace.db
```

Open **http://localhost:4000** in your browser.

For development with auto-restart on file changes:

```bash
npm run dev
```

## How persistence works

- On load, the browser fetches the full canvas + file-tree state from
  `GET /api/workspace`.
- Any change (moving a card, typing, checking a task, dragging into a
  Kanban column, renaming a file, etc.) schedules an autosave that sends
  the whole state to `PUT /api/workspace` about 700ms after you stop
  interacting. A small "Saving… / Saved" indicator sits in the bottom-right
  corner of the canvas.
- The server stores everything in `data/workspace.db`, a real SQLite
  database file with two tables: `cards` (one row per note/task/link/
  comment/drawing/board, including cards nested inside Kanban columns)
  and `files` (the file-tree entries). Delete that file any time to reset
  to the default demo content — it will be recreated automatically.

## API

| Method | Path              | Description                              |
|--------|-------------------|-------------------------------------------|
| GET    | `/api/workspace`  | Returns `{ cards, files, fileExpanded }`  |
| PUT    | `/api/workspace`  | Replaces the stored state with the body   |
| GET    | `/api/health`     | Basic health check / DB file path         |

## Notes

- The port defaults to `4000`. Override with `PORT=5000 npm start` if needed.
- Icons are loaded from a CDN (`lucide-static`) and the DM Sans font from
  Google Fonts — both need internet access on first load.
