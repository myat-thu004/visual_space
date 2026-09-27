'use strict';

const path = require('node:path');
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');

const DATA_DIR = path.join(__dirname, '..', 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const DB_PATH = path.join(DATA_DIR, 'workspace.db');
const db = new DatabaseSync(DB_PATH);

db.exec(`
  CREATE TABLE IF NOT EXISTS cards (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    title TEXT DEFAULT '',
    x REAL DEFAULT 0,
    y REAL DEFAULT 0,
    parent_board TEXT,
    parent_column TEXT,
    position INTEGER DEFAULT 0,
    file_id TEXT,
    data TEXT NOT NULL DEFAULT '{}',
    updated_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS files (
    id TEXT PRIMARY KEY,
    parent_id TEXT,
    name TEXT NOT NULL DEFAULT 'Untitled',
    is_folder INTEGER NOT NULL DEFAULT 0,
    depth INTEGER NOT NULL DEFAULT 0,
    position INTEGER NOT NULL DEFAULT 0,
    expanded INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT
  );
`);
try { db.exec("ALTER TABLE cards ADD COLUMN file_id TEXT"); } catch { /* already exists */ }

function seedIfEmpty() {
  const count = db.prepare('SELECT COUNT(*) AS n FROM cards').get().n;
  if (count > 0) return;

  const now = new Date().toISOString();

  const cards = [
    {
      id: 'chapterNote', type: 'note', title: 'Chapter Notes', x: 120, y: 100,
      parent_board: null, parent_column: null, position: 0,
      data: {
        html: '<h3>Key concepts</h3><p>The first chapter introduces the framework and explains why small, repeatable systems make complex work easier to understand.</p><p>Keep the central idea visible as you read. Capture questions beside the passages that need a second pass.</p><ul><li>Define the main terms</li><li>Compare the two examples</li><li>Bring one question to discussion</li></ul>'
      }
    },
    {
      id: 'studyPlan', type: 'task', title: 'Study Plan', x: 485, y: 136,
      parent_board: null, parent_column: null, position: 0,
      data: {
        tasks: [
          { text: 'Read Chapter 1', done: false },
          { text: 'Take notes', done: false },
          { text: 'Finish exercise', done: true },
          { text: 'Review tomorrow', done: false }
        ]
      }
    },
    {
      id: 'projectBoard', type: 'board', title: 'Project flow', x: 155, y: 455,
      parent_board: null, parent_column: null, position: 0,
      data: {
        orientation: 'vertical'
      }
    },
    {
      id: 'referenceLink', type: 'link', title: 'Reference', x: 910, y: 150,
      parent_board: null, parent_column: null, position: 0,
      data: { hasLink: false, url: '', linkTitle: 'Untitled link', host: '' }
    }
  ];

  const insertCard = db.prepare(`
    INSERT INTO cards (id, type, title, x, y, parent_board, parent_column, position, file_id, data, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const c of cards) {
    insertCard.run(c.id, c.type, c.title, c.x, c.y, c.parent_board, c.parent_column, c.position, c.file_id || null, JSON.stringify(c.data), now);
  }

  const files = [
    { id: 'workspace', parent_id: null, name: 'Workspace', is_folder: 1, depth: 0, position: 0, expanded: 1 },
    { id: 'projects', parent_id: 'workspace', name: 'Projects', is_folder: 1, depth: 1, position: 0, expanded: 0 },
    { id: 'knowledge', parent_id: 'projects', name: 'Knowledge Hub', is_folder: 0, depth: 2, position: 0, expanded: 0 },
    { id: 'website', parent_id: 'projects', name: 'Website Planning', is_folder: 0, depth: 2, position: 1, expanded: 0 },
    { id: 'notes', parent_id: 'workspace', name: 'Notes', is_folder: 1, depth: 1, position: 1, expanded: 0 },
    { id: 'chapter', parent_id: 'notes', name: 'Chapter Notes', is_folder: 0, depth: 2, position: 0, expanded: 0 },
    { id: 'study', parent_id: 'notes', name: 'Study Plan', is_folder: 0, depth: 2, position: 1, expanded: 0 },
    { id: 'resources', parent_id: 'workspace', name: 'Resources', is_folder: 1, depth: 1, position: 2, expanded: 0 },
    { id: 'links', parent_id: 'resources', name: 'Useful Links', is_folder: 0, depth: 2, position: 0, expanded: 0 }
  ];
  const insertFile = db.prepare(`
    INSERT INTO files (id, parent_id, name, is_folder, depth, position, expanded)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  for (const f of files) {
    insertFile.run(f.id, f.parent_id, f.name, f.is_folder, f.depth, f.position, f.expanded);
  }
}

function normalizeFileTree() {
  db.exec('BEGIN');
  try {
    const rows = db.prepare('SELECT * FROM files').all();
    const byId = new Map(rows.map(r => [r.id, r]));

    const root = byId.get('workspace');
    if (!root) {
      db.prepare("INSERT INTO files (id, parent_id, name, is_folder, depth, position, expanded) VALUES ('workspace', NULL, 'Workspace', 1, 0, ?, 1)")
        .run(rows.length);
      rows.push({ id: 'workspace', parent_id: null, name: 'Workspace', is_folder: 1, depth: 0, position: rows.length, expanded: 1 });
      byId.set('workspace', rows[rows.length - 1]);
    } else if (!root.is_folder) {
      db.prepare("UPDATE files SET is_folder = 1, name = 'Workspace', parent_id = NULL, depth = 0 WHERE id = 'workspace'").run();
      root.is_folder = 1;
    }

    const upd = db.prepare('UPDATE files SET parent_id = ?, is_folder = ?, depth = ?, position = ? WHERE id = ?');
    for (const r of rows) {
      if (r.id === 'workspace') {
        upd.run(null, 1, 0, r.position, r.id);
        continue;
      }
      const parent = byId.get(r.parent_id);
      if (r.is_folder) {
        upd.run('workspace', 1, 1, r.position, r.id);
      } else {
        const parentOk = parent && parent.is_folder && parent.id !== 'workspace';
        upd.run(parentOk ? parent.id : 'workspace', 0, parentOk ? 2 : 1, r.position, r.id);
      }
    }

    const byParent = new Map();
    for (const r of db.prepare('SELECT * FROM files').all()) {
      const key = r.parent_id || '\0root';
      if (!byParent.has(key)) byParent.set(key, []);
      byParent.get(key).push(r);
    }
    const order = db.prepare('UPDATE files SET position = ? WHERE id = ?');
    for (const group of byParent.values()) {
      group.sort((a, b) => (a.position - b.position) || a.id.localeCompare(b.id));
      group.forEach((r, i) => order.run(i, r.id));
    }

    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

function getWorkspace() {
  seedIfEmpty();
  normalizeFileTree();

  const fileRows = db.prepare('SELECT * FROM files ORDER BY depth ASC, position ASC').all();

  let currentFile = db.prepare('SELECT value FROM meta WHERE key = ?').get('current_file')?.value || null;
  const currentIsLeaf = currentFile && fileRows.some(r => r.id === currentFile && !r.is_folder);
  if (!currentIsLeaf) {
    const firstLeaf = fileRows.find(r => !r.is_folder);
    currentFile = firstLeaf ? firstLeaf.id : null;
    if (!currentFile) {
      currentFile = 'main-canvas';
      db.prepare('INSERT INTO files (id, parent_id, name, is_folder, depth, position, expanded) VALUES (?, NULL, ?, 0, 0, 0, 0)')
        .run(currentFile, 'Untitled');
    }
    db.prepare("INSERT INTO meta (key, value) VALUES ('current_file', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(currentFile);
  }

  db.prepare('UPDATE cards SET file_id = ? WHERE file_id IS NULL AND parent_board IS NULL').run(currentFile);
  db.prepare(`
    UPDATE cards SET file_id = (SELECT b.file_id FROM cards b WHERE b.id = cards.parent_board)
    WHERE parent_board IS NOT NULL AND file_id IS NULL
      AND EXISTS (SELECT 1 FROM cards b WHERE b.id = cards.parent_board)
  `).run();

  const cardRows = db.prepare('SELECT * FROM cards ORDER BY position ASC').all();
  const allCards = cardRows.map(rowToCard);

  const topLevel = allCards.filter(c => !c.parentBoard);
  const childrenOf = boardId => allCards.filter(c => c.parentBoard === boardId);

  const cards = topLevel.map(card => {
    if (card.type === 'board') {
      const { columns, ...rest } = card;
      return { ...rest, cards: childrenOf(card.id) };
    }
    return card;
  });

  const files = fileRows.map(r => ({
    id: r.id,
    parent: r.parent_id,
    name: r.name,
    isFolder: !!r.is_folder,
    depth: r.depth
  }));
  const fileExpanded = fileRows.filter(r => r.expanded).map(r => r.id);

  return { cards, files, fileExpanded, currentFile };
}

function rowToCard(row) {
  let data = {};
  try { data = JSON.parse(row.data || '{}'); } catch { data = {}; }
  return {
    id: row.id,
    type: row.type,
    title: row.title,
    x: row.x,
    y: row.y,
    parentBoard: row.parent_board,
    parentColumn: row.parent_column,
    fileId: row.file_id,
    ...data
  };
}

function saveWorkspace(payload) {
  const { cards = [], files = [], fileExpanded = [], currentFile } = payload || {};
  const now = new Date().toISOString();

  db.exec('BEGIN');
  try {
    db.exec('DELETE FROM cards');
    db.exec('DELETE FROM files');
    db.exec("DELETE FROM meta WHERE key = 'current_file'");
    if (currentFile) {
      db.prepare("INSERT INTO meta (key, value) VALUES ('current_file', ?)").run(String(currentFile));
    }

    const insertCard = db.prepare(`
      INSERT INTO cards (id, type, title, x, y, parent_board, parent_column, position, file_id, data, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    let topPos = 0;
    for (const card of cards) {
      insertTree(card, null, null, topPos++, null);
    }

    function insertTree(card, parentBoard, parentColumn, position, fileId) {
      const { id, type, title, x, y, columns, cards, fileId: ownFileId, ...rest } = card;
      // Strip child-card arrays out of the stored JSON for boards; children are separate rows.
      const fId = fileId || ownFileId || currentFile || null;
      insertCard.run(
        id, type, title || '', x || 0, y || 0,
        parentBoard, parentColumn, position, fId,
        JSON.stringify(rest), now
      );
      if (type === 'board' && Array.isArray(cards)) {
        cards.forEach((childCard, i) => insertTree(childCard, id, null, i, fId));
      }
    }

    const insertFile = db.prepare(`
      INSERT INTO files (id, parent_id, name, is_folder, depth, position, expanded)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    const expandedSet = new Set(fileExpanded);
    files.forEach((f, i) => {
      insertFile.run(f.id, f.parent || null, f.name || 'Untitled', f.isFolder ? 1 : 0, f.depth || 0, i, expandedSet.has(f.id) ? 1 : 0);
    });

    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

module.exports = { getWorkspace, saveWorkspace, DB_PATH };
