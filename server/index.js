'use strict';

const path = require('node:path');
const fs = require('node:fs');
const express = require('express');
const { getWorkspace, saveWorkspace, DB_PATH } = require('./db');

const app = express();
const PORT = process.env.PORT || 4000;

const UPLOAD_DIR = path.join(__dirname, '..', 'data', 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

app.use(express.json({ limit: '300mb' }));
app.use('/uploads', express.static(UPLOAD_DIR));
app.use(express.static(path.join(__dirname, '..', 'public')));

const MIME_EXT = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/bmp': '.bmp',
  'image/svg+xml': '.svg',
  'image/avif': '.avif',
  'image/heic': '.heic',
  'video/quicktime': '.mov',
  'video/mp4': '.mp4',
  'video/webm': '.webm',
  'video/x-m4v': '.m4v'
};

// Accept an uploaded photo/video as a base64 data URL and write it to disk
app.post('/api/upload', (req, res) => {
  try {
    const { file } = req.body || {};
    if (!file || typeof file !== 'string') {
      return res.status(400).json({ error: 'No file data provided' });
    }
    const match = /^data:([a-zA-Z0-9/+.\-]+);base64,(.+)$/.exec(file);
    if (!match) return res.status(400).json({ error: 'Invalid file data' });
    const mime = match[1];
    const ext = MIME_EXT[mime];
    if (!ext) return res.status(400).json({ error: 'Unsupported file type' });
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
    const filename = id + ext;
    fs.writeFileSync(path.join(UPLOAD_DIR, filename), Buffer.from(match[2], 'base64'));
    res.json({ url: '/uploads/' + filename, kind: mime.startsWith('video/') ? 'video' : 'image' });
  } catch (err) {
    console.error('Upload failed:', err);
    res.status(500).json({ error: 'Failed to save upload' });
  }
});

// Fetch the full canvas + file-tree state
app.get('/api/workspace', (req, res) => {
  try {
    res.json(getWorkspace());
  } catch (err) {
    console.error('Failed to load workspace:', err);
    res.status(500).json({ error: 'Failed to load workspace' });
  }
});

// Follow redirects (e.g. pin.it short links) and return the final canonical URL
app.get('/api/resolve', async (req, res) => {
  try {
    const raw = String(req.query.url || '').trim();
    const u = new URL(raw);
    if (!/^https?:$/.test(u.protocol)) return res.json({ url: null });
    const resp = await fetch(raw, { method: 'GET', redirect: 'follow', signal: AbortSignal.timeout(10000) });
    res.json({ url: resp.url || null });
  } catch {
    res.json({ url: null });
  }
});

// Persist the full canvas + file-tree state (autosaved by the client)
app.put('/api/workspace', (req, res) => {
  try {
    saveWorkspace(req.body);
    res.json({ ok: true, savedAt: new Date().toISOString() });
  } catch (err) {
    console.error('Failed to save workspace:', err);
    res.status(500).json({ error: 'Failed to save workspace' });
  }
});

app.get('/api/health', (req, res) => {
  res.json({ ok: true, db: DB_PATH });
});

app.listen(PORT, () => {
  console.log(`\n  Visual Workspace running at http://localhost:${PORT}`);
  console.log(`  Database file: ${DB_PATH}\n`);
});
