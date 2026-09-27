'use strict';

/* =========================================================================
   Visual Workspace — client
   Renders the canvas + file tree from data returned by the backend, keeps
   the existing interaction model (drag, kanban, rich text, file tree),
   and autosaves the full state back to /api/workspace.
   ========================================================================= */

const viewport = document.getElementById('viewport');
const world = document.getElementById('world');
const formatBar = document.getElementById('formatBar');
const fileSidebar = document.getElementById('fileSidebar');
const fileTree = document.getElementById('fileTree');
const fileSearch = document.getElementById('fileSearch');
const saveStatus = document.getElementById('saveStatus');

const selected = new Set();
let activeEditor = null, dragState = null, panState = null, pan = { x: 0, y: 0 }, groupId = 0;
const MIN_SCALE = 0.2, MAX_SCALE = 2.5;
const BASE_SCALE = 0.7;
let scale = BASE_SCALE;
const fileState = { selected: null, expanded: new Set(['workspace']) };
let currentFileId = null;
const cardCache = {};

/* ---------------------------------------------------------------------
   Helpers
--------------------------------------------------------------------- */
function refreshIcons() { if (window.lucide) window.lucide.createIcons(); }
function escapeHtml(s) { return String(s || '').replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m])); }
function escapeAttr(s) { return escapeHtml(s); }
function uid(prefix) { return prefix + '-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }

/* ---------------------------------------------------------------------
   Autosave
--------------------------------------------------------------------- */
let saveTimer = null;
function scheduleSave() {
  clearTimeout(saveTimer);
  showSaveStatus('Editing…');
  saveTimer = setTimeout(persistWorkspace, 700);
}
async function persistWorkspace() {
  const payload = serializeWorkspace();
  showSaveStatus('Saving…');
  try {
    const res = await fetch('/api/workspace', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    if (!res.ok) throw new Error('save failed');
    showSaveStatus('Saved');
  } catch (err) {
    console.error(err);
    showSaveStatus('Save failed — retrying…');
    saveTimer = setTimeout(persistWorkspace, 3000);
  }
}
let saveStatusTimer = null;
function showSaveStatus(text) {
  saveStatus.textContent = text;
  saveStatus.classList.add('show');
  clearTimeout(saveStatusTimer);
  if (text === 'Saved') saveStatusTimer = setTimeout(() => saveStatus.classList.remove('show'), 1500);
}

/* ---------------------------------------------------------------------
   Serialization — DOM -> data model
--------------------------------------------------------------------- */
function serializeWorkspace() {
  const currentCards = [...world.querySelectorAll(':scope > .workspace-card')].map(serializeCard);
  currentCards.forEach(c => c.fileId = currentFileId);
  cardCache[currentFileId] = currentCards;
  const cards = Object.values(cardCache).flat();
  const files = [...fileTree.querySelectorAll('.file-row')].map(row => ({
    id: row.dataset.node,
    parent: row.dataset.parent || null,
    name: row.querySelector('.file-label').textContent.trim(),
    isFolder: row.dataset.folder === 'true',
    depth: parseInt(row.dataset.depth) || 0
  }));
  const payload = { cards, files, fileExpanded: [...fileState.expanded] };
  if (currentFileId) payload.currentFile = currentFileId;
  return payload;
}

function serializeCard(card) {
  const type = card.dataset.cardType;
  const base = {
    id: card.id,
    type,
    title: card.querySelector('.card-title')?.value ?? '',
    x: parseFloat(card.style.left) || 0,
    y: parseFloat(card.style.top) || 0,
    group: card.dataset.group || null
  };
  if (type === 'board') {
    base.orientation = card.dataset.orientation || 'vertical';
    base.cards = [...card.querySelectorAll('.in-column')].map(serializeCard);
  } else if (type === 'task') {
    base.tasks = [...card.querySelectorAll('.task-row')].map(row => ({
      text: row.querySelector('.task-text').innerHTML,
      done: row.querySelector('input').checked
    }));
  } else if (type === 'link') {
    base.hasLink = card.classList.contains('has-link');
    base.url = card.querySelector('.link-empty input')?.value || '';
    base.linkTitle = card.querySelector('.link-preview-title')?.value || '';
    base.host = card.querySelector('.link-host')?.textContent || '';
  } else if (type === 'photo') {
    base.src = card.dataset.src || '';
    base.kind = card.dataset.kind || 'image';
    base.name = card.dataset.name || '';
  } else if (type === 'chinese') {
    base.chinese = card.querySelector('.chinese-word-input')?.value.trim() || '';
    base.pinyin = card.querySelector('.chinese-pinyin')?.value.trim() || '';
    base.english = card.querySelector('.chinese-english')?.value.trim() || '';
    base.meaning = card.querySelector('.chinese-meaning-input')?.value.trim() || '';
    base.examples = [...card.querySelectorAll('.chinese-example')].map(el => el.value.trim());
  } else {
    base.html = card.querySelector('.editor')?.innerHTML || '';
  }
  return base;
}

/* ---------------------------------------------------------------------
   Card creation — data model -> DOM (used for both fresh cards & hydration)
--------------------------------------------------------------------- */
function buildTaskBodyHTML(tasks) {
  const rows = (tasks && tasks.length) ? tasks : [{ text: 'New task', done: false }];
  const rowsHtml = rows.map(t => `<div class="task-row${t.done ? ' done' : ''}"><input type="checkbox" aria-label="Complete task"${t.done ? ' checked' : ''}><div class="task-text rich-editor" contenteditable="true">${t.text || ''}</div><button class="card-icon-btn task-delete" type="button" aria-label="Delete task"><i data-lucide="x"></i></button></div>`).join('');
  return `<div class="task-body">${rowsHtml}<button class="add-task" type="button">+ Add task</button></div>`;
}
function linkEmbedData(url) {
  let u;
  try { u = new URL(url); } catch { return null; }
  const host = u.hostname.replace(/^www\./, '');
  const p = u.pathname.replace(/\/+$/, '');

  if (host === 'youtu.be' || host.endsWith('youtube.com') || host === 'youtube-nocookie.com') {
    let id = null;
    if (host === 'youtu.be') id = p.split('/').filter(Boolean)[0] || null;
    else {
      const m = p.match(/^\/(embed|shorts|live)\/([A-Za-z0-9_-]{6,})/);
      id = m ? m[2] : (u.searchParams.get('v') || null);
    }
    if (id) return { src: `https://www.youtube.com/embed/${id}`, kind: 'video' };
  }
  if (host === 'vimeo.com') {
    const id = p.split('/').map(x => x.trim()).filter(x => /^\d+$/.test(x))[0];
    if (id) return { src: `https://player.vimeo.com/video/${id}`, kind: 'video' };
  }
  if (host === 'open.spotify.com') {
    const segs = p.split('/').filter(x => x && !/^intl-/i.test(x) && !/^[a-z]{2}(_|-)[a-z]{2}$/i.test(x));
    if (segs.length >= 2 && /^(track|album|playlist|episode|show|artist)$/.test(segs[segs.length - 2]) && /^[A-Za-z0-9_-]+$/.test(segs[segs.length - 1])) {
      const st = segs[segs.length - 2];
      const h = (st === 'album' || st === 'playlist' || st === 'artist') ? 352 : (st === 'episode' ? 232 : 152);
      return { src: `https://open.spotify.com/embed/${st}/${segs[segs.length - 1]}`, kind: 'audio', h };
    }
  }
  if (host.endsWith('soundcloud.com')) {
    return { src: `https://w.soundcloud.com/player/?url=${encodeURIComponent(url)}&color=%23ff5500&auto_play=false`, kind: 'audio' };
  }
  if (host === 'music.apple.com' || host === 'itunes.apple.com') {
    if (/^\/(album|playlist|artist|song|music-video)\b/.test(p) || p.includes('/album/') || p.includes('/playlist/') || p.includes('/artist/') || p.includes('/song/')) {
      return { src: `https://embed.music.apple.com${p || '/'}`, kind: 'audio' };
    }
  }
  if (host === 'pinterest.com' || host.endsWith('.pinterest.com') || /^pinterest\.[a-z]{2,3}$/.test(host)) {
    const segs = p.split('/').filter(Boolean);
    if (segs.length >= 2 && segs[0] === 'pin' && segs[1]) {
      return { kind: 'pinterest', pinDo: 'embedPin', src: url };
    }
    if (segs.length >= 2 && segs[0] !== 'pin') {
      return { kind: 'pinterest', pinDo: 'embedBoard', src: url };
    }
    if (segs.length === 1 && !/^(about|business|settings|login|account|search|explore|password|_|featured|forget)/.test(segs[0])) {
      return { kind: 'pinterest', pinDo: 'embedUser', src: url };
    }
  }
  return null;
}
function linkEmbedInner(url) {
  const e = url && linkEmbedData(url);
  if (!e) return '';
  if (e.kind === 'pinterest') {
    const w = e.pinDo === 'embedBoard' ? ' data-pin-columns="2" data-pin-width="500" data-pin-height="560"' : '';
    return `<a data-pin-do="${e.pinDo}"${w} href="${escapeAttr(e.src)}"></a>`;
  }
  return `<iframe src="${escapeAttr(e.src)}" style="${e.h ? 'height:' + e.h + 'px;aspect-ratio:auto;' : ''}" title="Embedded media" loading="lazy" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" allowfullscreen></iframe>`;
}
function linkMediaClass(url) {
  const e = url ? linkEmbedData(url) : null;
  if (!e) return '';
  if (e.kind === 'pinterest') return ' pinterest';
  return e.kind === 'audio' ? ' audio' : '';
}
function ensurePinit(cb) {
  if (window.parsePins) { cb(); return; }
  let s = document.querySelector('script[data-pin-build="parsePins"]');
  if (!s) {
    s = document.createElement('script');
    s.async = true;
    s.defer = true;
    s.src = 'https://assets.pinterest.com/js/pinit.js';
    s.setAttribute('data-pin-build', 'parsePins');
    document.body.appendChild(s);
  }
  s.addEventListener('load', cb, { once: true });
}
function renderPinterestEmbeds(scope) {
  const anchors = (scope || document).querySelectorAll('a[data-pin-do]');
  if (!anchors.length) return;
  const activate = () => {
    if (!window.parsePins) return;
    anchors.forEach(a => { try { window.parsePins(a); } catch (_) { /* noop */ } });
  };
  ensurePinit(activate);
}
function buildLinkBodyHTML(data) {
  const embed = `<div class="link-preview-media${linkMediaClass(data.url)}">${data.url ? linkEmbedInner(data.url) : ''}</div>`;
  return `<div class="link-body"><div class="link-empty"><i data-lucide="link" class="w-4 h-4"></i><input type="url" placeholder="Paste a link..." aria-label="Link URL" value="${escapeAttr(data.url || '')}"></div><div class="link-preview">${embed}<input class="link-preview-title" value="${escapeAttr(data.linkTitle || 'Untitled link')}" aria-label="Link title"><div class="link-host">${escapeHtml(data.host || '')}</div><div class="link-actions"><button type="button" class="card-icon-btn clear-link" aria-label="Clear link"><i data-lucide="x"></i></button></div></div></div>`;
}
function buildPhotoBodyHTML() {
  return `<div class="photo-body"><input type="file" class="photo-file-input" accept="image/*,video/*,.png,.jpg,.jpeg,.gif,.webp,.bmp,.svg,.avif,.mov,.mp4,.m4v,.webm" hidden><button type="button" class="photo-drop" aria-label="Add a photo"><i data-lucide="image-plus"></i><span>Add a photo</span></button><div class="photo-preview"></div></div>`;
}
function buildChineseBodyHTML(data) {
  const examples = [0, 1, 2].map(i =>
    `<input class="chinese-example" value="${escapeAttr((data.examples || [])[i] || '')}" placeholder="例句 ${i + 1}" aria-label="Example sentence ${i + 1}">`
  ).join('');
  return `<div class="chinese-body">
    <div class="chinese-word"><input class="chinese-word-input" value="${escapeAttr(data.chinese || '')}" placeholder="漢字" aria-label="Chinese word"></div>
    <div class="chinese-phonetics"><input class="chinese-pinyin" value="${escapeAttr(data.pinyin || '')}" placeholder="pīnyīn" aria-label="Pinyin"><input class="chinese-english" value="${escapeAttr(data.english || '')}" placeholder="English meaning" aria-label="English meaning"></div>
    <div class="chinese-meaning"><input class="chinese-meaning-input" value="${escapeAttr(data.meaning || '')}" placeholder="中文释义" aria-label="Meaning in Chinese"></div>
    <div class="chinese-examples">${examples}</div>
  </div>`;
}
function renderPhotoPreview(card, src, kind) {
  const preview = card.querySelector('.photo-preview');
  if (!preview) return;
  const media = kind === 'video'
    ? `<video src="${escapeAttr(src)}" controls></video>`
    : `<img src="${escapeAttr(src)}" alt="Photo">`;
  preview.innerHTML = media + '<button type="button" class="card-icon-btn photo-remove" aria-label="Remove photo"><i data-lucide="x"></i></button>';
  preview.querySelector('.photo-remove').addEventListener('click', () => { clearPhoto(card); scheduleSave(); });
  card.querySelector('.photo-drop')?.classList.add('hidden');
  preview.classList.remove('hidden');
  refreshIcons();
}
function clearPhoto(card) {
  delete card.dataset.src;
  delete card.dataset.kind;
  delete card.dataset.name;
  const preview = card.querySelector('.photo-preview');
  if (preview) { preview.classList.add('hidden'); preview.innerHTML = ''; }
  card.querySelector('.photo-drop')?.classList.remove('hidden');
  refreshIcons();
}
async function uploadPhoto(card, file) {
  if (!file) return;
  const reader = new FileReader();
  reader.onload = async () => {
    try {
      const res = await fetch('/api/upload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: file.name, file: reader.result })
      });
      if (!res.ok) throw new Error('upload failed');
      const { url, kind } = await res.json();
      card.dataset.src = url;
      card.dataset.kind = kind;
      card.dataset.name = file.name || '';
      renderPhotoPreview(card, url, kind);
      scheduleSave();
    } catch (err) {
      console.error(err);
      alert('Upload failed — try a smaller file.');
    }
  };
  reader.readAsDataURL(file);
}

function createCardElement(data) {
  let card;
  if (data.type === 'board') {
    card = document.getElementById('boardTemplate').content.firstElementChild.cloneNode(true);
    card.id = data.id || uid('board');
    card.querySelector('.card-title').value = data.title || 'Project flow';
    const orientation = data.orientation === 'horizontal' ? 'horizontal' : 'vertical';
    card.dataset.orientation = orientation;
    card.classList.toggle('layout-vertical', orientation === 'vertical');
  } else {
    card = document.getElementById('newCardTemplate').content.firstElementChild.cloneNode(true);
    card.id = data.id || uid('card');
    card.dataset.cardType = data.type;
    card.querySelector('.card-title').value = data.title ?? '';
    if (data.type === 'task') {
      card.querySelector('.editor').outerHTML = buildTaskBodyHTML(data.tasks);
    } else if (data.type === 'link') {
      card.classList.add('link-card');
      card.querySelector('.editor').outerHTML = buildLinkBodyHTML(data);
      if (data.hasLink) card.classList.add('has-link');
      const embedKind = data.hasLink && data.url ? linkEmbedData(data.url) : null;
      if (embedKind) card.classList.add('has-embed');
      if (embedKind && embedKind.kind === 'pinterest') card.classList.add('pinterest-card');
    } else if (data.type === 'photo') {
      card.classList.add('photo-card');
      card.querySelector('.editor').outerHTML = buildPhotoBodyHTML();
      if (data.src) {
        card.dataset.src = data.src;
        card.dataset.kind = data.kind || 'image';
        card.dataset.name = data.name || '';
        renderPhotoPreview(card, data.src, data.kind || 'image');
      }
    } else if (data.type === 'chinese') {
      card.classList.add('chinese-card');
      card.querySelector('.editor').outerHTML = buildChineseBodyHTML(data);
    } else {
      card.querySelector('.editor').innerHTML = data.html || 'Write something meaningful&hellip;';
    }
  }
  if (data.group) card.dataset.group = data.group;
  card.style.left = (data.x || 0) + 'px';
  card.style.top = (data.y || 0) + 'px';
  return card;
}

function attachInColumnDelete(card) {
  if (card.querySelector('.in-column-delete')) return;
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'card-icon-btn in-column-delete';
  btn.setAttribute('aria-label', 'Delete card from board');
  btn.title = 'Delete card';
  btn.innerHTML = '<i data-lucide="trash-2"></i>';
  card.querySelector('.card-head').appendChild(btn);
  btn.addEventListener('click', () => {
    if (btn.dataset.confirmed === 'true') {
      const board = card.closest('.board');
      card.remove();
      if (board) fitBoardToContent(board);
      scheduleSave();
    }
    else { btn.dataset.confirmed = 'true'; btn.title = 'Confirm delete card'; setTimeout(() => btn.dataset.confirmed = '', 3000); }
  });
  refreshIcons();
}

function hydrateCard(data) {
  const card = createCardElement(data);
  if (data.type === 'board') {
    world.appendChild(card);
    bindCard(card);
    (data.cards || []).forEach(childData => {
      const childCard = hydrateChildCard(childData);
      card.querySelector('.column-stack').appendChild(childCard);
    });
    fitBoardToContent(card);
  } else {
    world.appendChild(card);
    bindCard(card);
  }
  return card;
}

function hydrateChildCard(data) {
  const card = createCardElement(data);
  card.classList.add('in-column');
  card.style.left = '';
  card.style.top = '';
  bindCard(card);
  attachInColumnDelete(card);
  card.querySelector('.send-canvas')?.classList.remove('hidden');
  return card;
}

/* ---------------------------------------------------------------------
   Canvas interactions (selection, drag, pan)
--------------------------------------------------------------------- */
function selectCard(card, multi = false) {
  if (!multi) { selected.forEach(c => c.classList.remove('selected')); selected.clear(); }
  if (multi && selected.has(card)) { selected.delete(card); card.classList.remove('selected'); }
  else { selected.add(card); card.classList.add('selected'); }
  const bar = document.getElementById('selectionActions');
  bar.classList.toggle('show', selected.size > 1);
  document.getElementById('selectionCount').textContent = `${selected.size} selected`;
}

function bindCard(card) {
  const head = card.querySelector('.card-head');
  head.addEventListener('pointerdown', startCardDrag);
  card.addEventListener('pointerdown', e => {
    if (!e.target.closest('input,button,[contenteditable="true"]')) selectCard(card, e.shiftKey);
  });
  card.querySelectorAll('.rich-editor').forEach(editor => {
    editor.addEventListener('focus', () => { activeEditor = editor; formatBar.classList.add('visible'); });
    editor.addEventListener('keydown', handleEditorKeys);
  });
  card.querySelectorAll('.task-row input').forEach(check =>
    check.addEventListener('change', () => check.closest('.task-row').classList.toggle('done', check.checked)));
  card.querySelectorAll('.task-delete').forEach(btn =>
    btn.addEventListener('click', () => { btn.closest('.task-row').remove(); scheduleSave(); }));
  card.querySelector('.add-task')?.addEventListener('click', () => addTask(card.querySelector('.task-body')));
  card.querySelector('.send-canvas')?.addEventListener('click', () => sendToCanvas(card));

  const photoFileInput = card.querySelector('.photo-file-input');
  if (photoFileInput) {
    photoFileInput.addEventListener('change', () => {
      const f = photoFileInput.files[0];
      if (f) uploadPhoto(card, f);
      photoFileInput.value = '';
    });
  }
  card.querySelector('.photo-drop')?.addEventListener('click', () => photoFileInput?.click());
  const photoBody = card.querySelector('.photo-body');
  if (photoBody) {
    photoBody.addEventListener('dragover', e => { e.preventDefault(); photoBody.classList.add('drag-over'); });
    photoBody.addEventListener('dragleave', () => photoBody.classList.remove('drag-over'));
    photoBody.addEventListener('drop', e => {
      e.preventDefault();
      photoBody.classList.remove('drag-over');
      const f = e.dataTransfer.files[0];
      if (f) uploadPhoto(card, f);
    });
  }

  card.querySelectorAll('.chinese-word-input').forEach(inp => {
    inp.addEventListener('input', () => {
      const t = card.querySelector('.card-title');
      if (t && !t.dataset.synced) t.value = inp.value.trim() || 'Chinese card';
    });
  });
  card.querySelectorAll('.card-title').forEach(t =>
    t.addEventListener('input', () => { if (card.dataset.cardType === 'chinese') t.dataset.synced = '1'; }));

  if (card.classList.contains('board')) {
    setBoardOrientation(card, card.dataset.orientation || 'vertical');
    card.querySelectorAll('[data-orientation]').forEach(btn => {
      btn.addEventListener('pointerdown', e => e.stopPropagation());
      btn.addEventListener('click', e => { e.preventDefault(); e.stopPropagation(); setBoardOrientation(card, btn.dataset.orientation); scheduleSave(); });
    });
    card.querySelectorAll('.drop-area').forEach(btn => btn.addEventListener('click', () => {
      const newCard = document.getElementById('newCardTemplate').content.firstElementChild.cloneNode(true);
      newCard.id = uid('card');
      newCard.dataset.cardType = 'note';
      newCard.classList.add('in-column');
      card.querySelector('.column-stack').appendChild(newCard);
      bindCard(newCard);
      attachInColumnDelete(newCard);
      newCard.querySelector('.send-canvas')?.classList.remove('hidden');
      fitBoardToContent(card);
      refreshIcons();
      scheduleSave();
    }));
  }

  if (!card.classList.contains('in-column')) addResizeHandles(card);

  card.querySelectorAll('.link-empty input').forEach(input => {
    input.addEventListener('change', () => { setLink(card, input.value); scheduleSave(); });
    input.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); input.blur(); } });
  });
  card.querySelector('.clear-link')?.addEventListener('click', () => { clearLink(card); scheduleSave(); });
}

function setBoardOrientation(board, orientation) {
  const next = orientation === 'horizontal' ? 'horizontal' : 'vertical';
  board.dataset.orientation = next;
  board.classList.toggle('layout-vertical', next === 'vertical');
  board.querySelectorAll('[data-orientation]').forEach(button => {
    const active = button.dataset.orientation === next;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
  });
  fitBoardToContent(board);
}

function startCardDrag(e) {
  if (e.button !== 0) return;
  if (e.target.closest('input,textarea,button,[contenteditable="true"]')) return;
  const card = e.currentTarget.closest('.workspace-card');
  selectCard(card, e.shiftKey);
  dragState = { card, startX: e.clientX, startY: e.clientY };
  card.setPointerCapture(e.pointerId);
  e.preventDefault();
}
document.addEventListener('pointermove', e => {
  if (dragState) {
    const d = dragState, dx = e.clientX - d.startX, dy = e.clientY - d.startY;
    const peers = d.card.dataset.group ? [...document.querySelectorAll(`[data-group="${d.card.dataset.group}"]`)] : [d.card];
    peers.forEach(c => {
      if (!c.classList.contains('in-column')) {
        c.style.left = (parseFloat(c.style.left) || 0) + dx / scale + 'px';
        c.style.top = (parseFloat(c.style.top) || 0) + dy / scale + 'px';
      }
    });
    d.startX = e.clientX; d.startY = e.clientY;
    document.querySelectorAll('.board-columns').forEach(col => {
      const r = col.getBoundingClientRect();
      col.classList.toggle('over', e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom);
    });
  }
  if (panState) { pan.x = panState.x + (e.clientX - panState.startX); pan.y = panState.y + (e.clientY - panState.startY); applyTransform(); }
});
document.addEventListener('pointerup', e => {
  if (dragState) {
    const over = [...document.querySelectorAll('.board-columns.over')][0];
    if (over && !dragState.card.classList.contains('board')) moveToBoard(dragState.card, over);
    else if (dragState.card.classList.contains('in-column')) dragOutToCanvas(dragState.card, e.clientX, e.clientY);
    document.querySelectorAll('.board-columns').forEach(c => c.classList.remove('over'));
    dragState = null;
    scheduleSave();
  }
  if (panState) { panState = null; viewport.classList.remove('panning'); }
});
viewport.addEventListener('pointerdown', e => {
  if (e.target === viewport || e.target === world) {
    selected.forEach(c => c.classList.remove('selected'));
    selected.clear();
    document.getElementById('selectionActions').classList.remove('show');
    formatBar.classList.remove('visible');
    activeEditor = null;
    panState = { startX: e.clientX, startY: e.clientY, x: pan.x, y: pan.y };
    viewport.classList.add('panning');
  }
});
function applyTransform() {
  world.style.transform = `translate(${pan.x}px,${pan.y}px) scale(${scale})`;
  viewport.style.backgroundSize = `${18 * scale}px ${18 * scale}px`;
  viewport.style.backgroundPosition = `${pan.x}px ${pan.y}px`;
  const zoomReset = document.getElementById('zoomReset');
  if (zoomReset) zoomReset.textContent = Math.round((scale / BASE_SCALE) * 100) + '%';
}
function screenToWorld(clientX, clientY) {
  const vr = viewport.getBoundingClientRect();
  return { x: (clientX - vr.left - pan.x) / scale, y: (clientY - vr.top - pan.y) / scale };
}
function viewportCenterWorld() {
  const vr = viewport.getBoundingClientRect();
  return screenToWorld(vr.left + vr.width / 2, vr.top + vr.height / 2);
}
function zoomAt(clientX, clientY, targetScale) {
  const vr = viewport.getBoundingClientRect();
  const cx = clientX - vr.left, cy = clientY - vr.top;
  const next = Math.min(MAX_SCALE, Math.max(MIN_SCALE, targetScale));
  if (next === scale) return;
  const worldX = (cx - pan.x) / scale, worldY = (cy - pan.y) / scale;
  scale = next;
  pan.x = cx - worldX * scale;
  pan.y = cy - worldY * scale;
  applyTransform();
}
function zoomByFactor(factor) {
  const vr = viewport.getBoundingClientRect();
  zoomAt(vr.left + vr.width / 2, vr.top + vr.height / 2, scale * factor);
}
function resetZoom() {
  const vr = viewport.getBoundingClientRect();
  zoomAt(vr.left + vr.width / 2, vr.top + vr.height / 2, BASE_SCALE);
}

/* Wheel: two-finger trackpad scroll pans the canvas; Ctrl/Cmd+scroll or a
   pinch gesture zooms toward the cursor. Scrollable inner regions (long
   notes, search results, the file list) keep their native scroll. */
viewport.addEventListener('wheel', e => {
  if (e.ctrlKey || e.metaKey) {
    e.preventDefault();
    const factor = Math.exp(-e.deltaY * 0.0035);
    zoomAt(e.clientX, e.clientY, scale * factor);
    return;
  }
  const scrollable = e.target.closest('.editor, .search-results, .file-sidebar-content');
  if (scrollable && scrollable.scrollHeight > scrollable.clientHeight) return;
  e.preventDefault();
  pan.x -= e.deltaX;
  pan.y -= e.deltaY;
  applyTransform();
}, { passive: false });

document.getElementById('zoomIn').addEventListener('click', () => zoomByFactor(1.25));
document.getElementById('zoomOut').addEventListener('click', () => zoomByFactor(1 / 1.25));
document.getElementById('zoomReset').addEventListener('click', resetZoom);

document.addEventListener('keydown', e => {
  if (!(e.ctrlKey || e.metaKey)) return;
  if (e.key === '=' || e.key === '+') { e.preventDefault(); zoomByFactor(1.2); }
  else if (e.key === '-' || e.key === '_') { e.preventDefault(); zoomByFactor(1 / 1.2); }
  else if (e.key === '0') { e.preventDefault(); resetZoom(); }
});

function moveToBoard(card, boardColumns) {
  const stack = boardColumns.querySelector('.column-stack');
  stack.appendChild(card);
  card.classList.add('in-column');
  card.style.left = ''; card.style.top = '';
  removeResizeHandles(card);
  attachInColumnDelete(card);
  card.querySelector('.send-canvas')?.classList.remove('hidden');
  fitBoardToContent(boardColumns.closest('.board'));
}
function dragOutToCanvas(card, clientX, clientY) {
  const board = card.closest('.board');
  const p = screenToWorld(clientX, clientY);
  world.appendChild(card);
  card.classList.remove('in-column');
  card.style.left = (p.x - card.offsetWidth / 2) + 'px';
  card.style.top = (p.y - 8) + 'px';
  card.querySelector('.send-canvas')?.classList.add('hidden');
  addResizeHandles(card);
  if (board) fitBoardToContent(board);
}
function sendToCanvas(card) {
  const board = card.closest('.board');
  const r = card.getBoundingClientRect();
  const dropPoint = screenToWorld(r.left, r.top);
  world.appendChild(card);
  card.classList.remove('in-column');
  card.style.left = (dropPoint.x + 40) + 'px';
  card.style.top = (dropPoint.y + 40) + 'px';
  card.querySelector('.send-canvas')?.classList.add('hidden');
  addResizeHandles(card);
  if (board) fitBoardToContent(board);
  scheduleSave();
}

/* ---------------------------------------------------------------------
   Card / board resizing
--------------------------------------------------------------------- */
function measureNaturalSize(el) {
  const clone = el.cloneNode(true);
  clone.style.cssText = 'position:fixed;top:0;left:-100000px;visibility:hidden;pointer-events:none;';
  clone.style.setProperty('width', 'min-content', 'important');
  clone.style.setProperty('height', 'max-content', 'important');
  document.body.appendChild(clone);
  const w = clone.scrollWidth;
  const h = clone.scrollHeight;
  clone.remove();
  return { w, h };
}
function computeCardMin(card) {
  const n = measureNaturalSize(card);
  return { w: Math.max(n.w + 2, 140), h: Math.max(n.h + 2, 90) };
}
function measureCardAtWidth(card, width) {
  const clone = card.cloneNode(true);
  clone.classList.add('measure-card');
  clone.style.cssText = 'position:fixed;top:0;left:-100000px;visibility:hidden;pointer-events:none;';
  clone.style.setProperty('width', width + 'px', 'important');
  clone.style.setProperty('height', 'max-content', 'important');
  document.body.appendChild(clone);
  const h = clone.offsetHeight;
  clone.remove();
  return h;
}
function measureCardNaturalWidth(card, cap) {
  const clone = card.cloneNode(true);
  clone.classList.add('measure-card');
  clone.style.cssText = 'position:fixed;top:0;left:-100000px;visibility:hidden;pointer-events:none;';
  clone.style.setProperty('width', 'max-content', 'important');
  clone.style.setProperty('height', 'max-content', 'important');
  document.body.appendChild(clone);
  const w = clone.offsetWidth;
  clone.remove();
  return Math.min(Math.max(w, 170), cap);
}
function computeBoardMin(board) {
  const vertical = board.dataset.orientation === 'vertical';
  const head = board.querySelector('.card-head');
  const headH = head ? head.offsetHeight : 41;
  const cards = [...board.querySelectorAll('.in-column')];
  const pad = 20, gap = 10, dropH = 58, border = 2;
  let w, h;
  if (!cards.length) {
    w = vertical ? 302 : 322;
    h = headH + pad + dropH + 44;
  } else if (vertical) {
    const colW = Math.max(240, cards[0].offsetWidth);
    const heights = cards.map(c => measureCardAtWidth(c, colW));
    w = 302;
    h = headH + pad + heights.reduce((a, x) => a + x + gap, -gap) + dropH;
  } else {
    const parts = cards.map(c => {
      const cw = measureCardNaturalWidth(c, 400);
      return { cw, ch: measureCardAtWidth(c, cw) };
    });
    w = parts.reduce((a, p) => a + p.cw + gap, -gap) + pad + border;
    h = headH + pad + Math.max(...parts.map(p => p.ch)) + gap + dropH;
  }
  return { w: Math.max(w, 220), h: Math.max(h, 140) };
}
function fitBoardToContent(board) {
  if (!board || !board.classList.contains('board')) return;
  const nat = computeBoardMin(board);
  const usrW = board.style.width && board.offsetWidth > nat.w ? board.offsetWidth : null;
  const wantW = usrW !== null ? Math.max(nat.w, usrW) : nat.w;
  board.style.width = wantW + 'px';
  board.style.height = '';
}
function addResizeHandles(card) {
  if (card.querySelector('.card-resize')) return;
  ['se', 'e', 's'].forEach(dir => {
    const handle = document.createElement('span');
    handle.className = 'card-resize';
    handle.dataset.dir = dir;
    handle.setAttribute('aria-hidden', 'true');
    card.appendChild(handle);
    handle.addEventListener('pointerdown', e => startCardResize(e, card, dir));
  });
}
function removeResizeHandles(card) {
  card.querySelectorAll('.card-resize').forEach(h => h.remove());
}
function startCardResize(e, card, dir) {
  if (e.button !== 0) return;
  e.preventDefault();
  e.stopPropagation();
  selectCard(card, e.shiftKey);
  const startX = e.clientX, startY = e.clientY;
  const startW = card.offsetWidth, startH = card.offsetHeight;
  const min = card.classList.contains('board') ? computeBoardMin(card) : computeCardMin(card);
  const move = ev => {
    if (dir === 'e' || dir === 'se') {
      card.style.width = Math.max(min.w, startW + (ev.clientX - startX) / scale) + 'px';
    }
    if (dir === 's' || dir === 'se') {
      card.style.height = Math.max(min.h, startH + (ev.clientY - startY) / scale) + 'px';
    }
  };
  const up = () => {
    document.removeEventListener('pointermove', move);
    document.removeEventListener('pointerup', up);
    scheduleSave();
  };
  document.addEventListener('pointermove', move);
  document.addEventListener('pointerup', up);
}

/* ---------------------------------------------------------------------
   Tasks
--------------------------------------------------------------------- */
function appendTaskRow(body, text) {
  const row = document.createElement('div');
  row.className = 'task-row';
  row.innerHTML = `<input type="checkbox" aria-label="Complete task"><div class="task-text rich-editor" contenteditable="true"></div><button class="card-icon-btn task-delete" type="button" aria-label="Delete task"><i data-lucide="x"></i></button>`;
  row.querySelector('.task-text').innerHTML = text;
  body.insertBefore(row, body.querySelector('.add-task'));
  row.querySelector('input').addEventListener('change', () => row.classList.toggle('done', row.querySelector('input').checked));
  row.querySelector('.task-delete').addEventListener('click', () => { row.remove(); scheduleSave(); });
  row.querySelector('.task-text').addEventListener('focus', () => { activeEditor = row.querySelector('.task-text'); formatBar.classList.add('visible'); });
  row.querySelector('.task-text').addEventListener('keydown', handleEditorKeys);
  return row;
}
function addTask(body, text = 'New task') {
  const row = appendTaskRow(body, text);
  refreshIcons();
  row.querySelector('.task-text').focus();
  scheduleSave();
}
function cleanTaskLine(line) {
  return line.replace(/^\s*\d+[.)]\s+/, '').replace(/^\s*[-*+]\s+/, '').trim();
}
function mdInline(text) {
  const escaped = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return escaped
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    .replace(/(^|[^_])__([^_\n]+)__(?!_)/g, '$1<strong>$2</strong>')
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(/~~([^~\n]+)~~/g, '<s>$1</s>');
}
document.addEventListener('paste', e => {
  const editor = e.target.closest('.task-text');
  if (!editor) return;
  e.preventDefault();
  const text = (e.clipboardData || window.clipboardData).getData('text/plain') || '';
  const lines = text.split(/\r?\n/).map(cleanTaskLine).filter(Boolean);
  if (!lines.length) return;
  editor.innerHTML = mdInline(lines[0]);
  const range = document.createRange();
  range.selectNodeContents(editor);
  range.collapse(false);
  const sel = window.getSelection();
  sel.removeAllRanges(); sel.addRange(range);
  const body = editor.closest('.task-body');
  lines.slice(1).forEach(line => appendTaskRow(body, mdInline(line)));
  scheduleSave();
});
function handleEditorKeys(e) {
  if (e.key === 'Enter' && e.currentTarget.classList.contains('task-text')) { e.preventDefault(); addTask(e.currentTarget.closest('.task-body'), ''); }
  if (e.key === 'Backspace' && e.currentTarget.classList.contains('task-text') && !e.currentTarget.textContent.trim()) {
    const body = e.currentTarget.closest('.task-body');
    if (body.querySelectorAll('.task-row').length > 1) { e.preventDefault(); e.currentTarget.closest('.task-row').remove(); scheduleSave(); }
  }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'b') { e.preventDefault(); document.execCommand('bold'); }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'i') { e.preventDefault(); document.execCommand('italic'); }
}

/* ---------------------------------------------------------------------
   Links
--------------------------------------------------------------------- */
async function resolveShortUrl(url) {
  try {
    const r = await fetch('/api/resolve?url=' + encodeURIComponent(url));
    const j = await r.json();
    if (j && typeof j.url === 'string' && j.url) {
      const u = new URL(j.url);
      if (u.hostname === 'pin.it' || u.hostname.endsWith('pinterest.com') || /^pinterest\.[a-z]{2,3}$/.test(u.hostname)) u.search = '';
      return u.toString();
    }
    return null;
  } catch {
    return null;
  }
}
function setLink(card, url) {
  const input = card.querySelector('.link-empty input');
  let host = null;
  try { host = new URL(url).hostname.toLowerCase(); }
  catch { if (input) input.focus(); return; }
  if (host === 'pin.it' || host.endsWith('.pin.it')) {
    resolveShortUrl(url).then(resolved => {
      const finalUrl = resolved || url;
      if (resolved) input.value = resolved;
      applyLink(card, finalUrl);
      scheduleSave();
    });
    return;
  }
  applyLink(card, url);
}
function applyLink(card, url) {
  try {
    const u = new URL(url);
    card.classList.add('has-link');
    const hostEl = card.querySelector('.link-host');
    const titleEl = card.querySelector('.link-preview-title');
    if (hostEl) hostEl.textContent = u.hostname;
    if (titleEl) titleEl.value = u.hostname;
    const media = card.querySelector('.link-preview-media');
    if (media) {
      const e = linkEmbedData(url);
      card.classList.toggle('has-embed', !!e);
      card.classList.toggle('pinterest-card', !!(e && e.kind === 'pinterest'));
      media.classList.toggle('audio', !!(e && e.kind === 'audio'));
      media.classList.toggle('pinterest', !!(e && e.kind === 'pinterest'));
      media.innerHTML = linkEmbedInner(url);
      if (media.querySelector('a[data-pin-do]')) renderPinterestEmbeds(media);
    }
  } catch {
    card.querySelector('.link-empty input').focus();
  }
}
function clearLink(card) {
  card.classList.remove('has-link');
  card.classList.remove('has-embed');
  card.classList.remove('pinterest-card');
  card.querySelector('.link-empty input').value = '';
  const media = card.querySelector('.link-preview-media');
  if (media) { media.innerHTML = ''; media.classList.remove('audio'); media.classList.remove('pinterest'); }
  card.querySelector('.link-empty input').focus();
}

/* ---------------------------------------------------------------------
   Toolbar: create cards
--------------------------------------------------------------------- */
function nextFreePosition(cx, cy, w, h) {
  const occupied = [...document.querySelectorAll('#world .workspace-card')]
    .filter(c => !c.classList.contains('in-column'))
    .map(c => ({
      x: parseFloat(c.style.left) || 0,
      y: parseFloat(c.style.top) || 0,
      w: c.offsetWidth || 400,
      h: c.offsetHeight || 220
    }));
  const collides = r => occupied.some(o =>
    r.x < o.x + o.w + 14 && r.x + r.w + 14 > o.x &&
    r.y < o.y + o.h + 14 && r.y + r.h + 14 > o.y);
  if (!collides({ x: cx, y: cy, w, h })) return { x: cx, y: cy };
  const cellW = w + 24, cellH = h + 24;
  for (let ring = 1; ring <= 5; ring++) {
    for (let dx = -ring; dx <= ring; dx++) {
      for (let dy = -ring; dy <= ring; dy++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== ring) continue;
        const x = cx + dx * cellW, y = cy + dy * cellH;
        if (!collides({ x, y, w, h })) return { x, y };
      }
    }
  }
  return { x: cx, y: cy };
}
document.querySelectorAll('[data-create]').forEach(btn => btn.addEventListener('click', () => {
  const type = btn.dataset.create;
  const center = viewportCenterWorld();
  if (type === 'board') {
    const pos = nextFreePosition(center.x - 260, center.y - 150, 520, 300);
    const card = hydrateCard({
      id: uid('board'), type: 'board', title: 'Project flow',
      x: pos.x, y: pos.y, orientation: 'vertical',
      cards: []
    });
    refreshIcons();
    selectCard(card);
    scheduleSave();
    return;
  }
  const estW = type === 'link' ? 800 : 500;
  const estH = type === 'link' ? 320 : 300;
  const pos = nextFreePosition(center.x - estW / 2, center.y - estH / 2, estW, estH);
  const data = { id: uid('card'), type, x: pos.x, y: pos.y };
  if (type === 'note') data.title = 'Untitled note';
  if (type === 'task') { data.title = 'To-do list'; data.tasks = [{ text: 'New task', done: false }]; }
  if (type === 'link') data.title = 'Reference';
  if (type === 'photo') { data.title = 'Photo'; data.kind = 'image'; }
  if (type === 'chinese') data.title = 'Chinese card';
  const card = hydrateCard(data);
  refreshIcons();
  selectCard(card);
  scheduleSave();
}));

document.getElementById('groupButton').addEventListener('click', () => {
  const id = 'group-' + (++groupId);
  selected.forEach(c => c.dataset.group = id);
  scheduleSave();
});

/* ---------------------------------------------------------------------
   Formatting toolbar
--------------------------------------------------------------------- */
formatBar.querySelectorAll('[data-command]').forEach(btn => btn.addEventListener('mousedown', e => e.preventDefault()));
formatBar.querySelectorAll('[data-command]').forEach(btn => btn.addEventListener('click', () => {
  if (activeEditor) { activeEditor.focus(); document.execCommand(btn.dataset.command, false, btn.dataset.value || null); scheduleSave(); }
}));
document.getElementById('taskFormat').addEventListener('click', () => activeEditor?.closest('.task-body') ? addTask(activeEditor.closest('.task-body'), '') : null);
document.getElementById('linkFormat').addEventListener('click', () => {
  if (activeEditor) {
    const url = window.getSelection().toString() ? 'https://' : '';
    document.execCommand('createLink', false, url);
    scheduleSave();
  }
});

/* ---------------------------------------------------------------------
   Search
--------------------------------------------------------------------- */
const searchPopover = document.getElementById('searchPopover'), searchInput = document.getElementById('workspaceSearch'), results = document.getElementById('searchResults');
document.getElementById('searchButton').addEventListener('click', () => { searchPopover.classList.add('open'); searchInput.focus(); });
document.getElementById('closeSearch').addEventListener('click', () => searchPopover.classList.remove('open'));
searchInput.addEventListener('input', () => {
  const q = searchInput.value.trim().toLowerCase();
  results.innerHTML = '';
  if (!q) return;
  [...document.querySelectorAll('.workspace-card')].filter(card => card.innerText.toLowerCase().includes(q)).forEach(card => {
    const b = document.createElement('button');
    b.className = 'search-result';
    const title = card.querySelector('.card-title')?.value || card.querySelector('.link-preview-title')?.value || 'Card';
    b.innerHTML = `<strong></strong><span></span>`;
    b.querySelector('strong').textContent = title;
    b.querySelector('span').textContent = card.innerText.replace(/\s+/g, ' ').slice(0, 85);
    b.addEventListener('click', () => {
      if (card.classList.contains('in-column')) card.closest('.board').scrollIntoView({ behavior: 'smooth', block: 'center' });
      else {
        const cardCenterX = (parseFloat(card.style.left) || 0) + card.offsetWidth / 2;
        const cardCenterY = (parseFloat(card.style.top) || 0) + card.offsetHeight / 2;
        pan.x = viewport.clientWidth / 2 - cardCenterX * scale;
        pan.y = viewport.clientHeight / 2 - cardCenterY * scale;
        applyTransform();
      }
      selectCard(card);
      searchPopover.classList.remove('open');
    });
    results.appendChild(b);
  });
});
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    searchPopover.classList.remove('open');
    formatBar.classList.remove('visible');
    activeEditor = null;
    selected.forEach(c => c.classList.remove('selected'));
    selected.clear();
    document.getElementById('selectionActions').classList.remove('show');
  }
});

/* ---------------------------------------------------------------------
   Delete flow (Enter/Return + confirmation)
--------------------------------------------------------------------- */
const confirmDialog = document.getElementById('confirmDialog'), confirmTitle = document.getElementById('confirmTitle'),
  confirmMessage = document.getElementById('confirmMessage'), confirmActions = document.getElementById('confirmActions');
let pendingDelete = null;
function closeConfirm() { confirmDialog.classList.remove('open'); pendingDelete = null; }
function openDeleteConfirm(card) {
  pendingDelete = card;
  confirmDialog.classList.add('open');
  const board = card.classList.contains('board');
  confirmTitle.textContent = board ? 'Delete this board?' : 'Delete this card?';
  confirmMessage.textContent = board ? 'Choose whether to delete the board cards or move them back to the canvas.' : 'This action cannot be undone.';
  confirmActions.innerHTML = board
    ? '<button type="button" data-confirm="cancel">Cancel</button><button type="button" data-confirm="move">Move cards back</button><button type="button" class="primary" data-confirm="delete-all">Delete all</button>'
    : '<button type="button" data-confirm="cancel">Cancel</button><button type="button" class="primary" data-confirm="delete">Delete</button>';
  confirmActions.querySelector('[data-confirm="cancel"]').focus();
}
const DEFAULT_TITLES = new Set(['Untitled note', 'To-do list', 'Reference', 'Photo', 'Chinese card', 'Project flow']);
function cardHasContent(card) {
  if (!card || !card.classList.contains('workspace-card')) return false;
  const title = (card.querySelector('.card-title')?.value || '').trim();
  const retitled = !!title && title !== 'Untitled note' && title !== 'To-do list' && title !== 'Reference' && title !== 'Photo' && title !== 'Chinese card';
  if (card.classList.contains('board')) {
    if (card.querySelectorAll('.in-column').length > 0) return true;
    return !!(title && title !== 'Project flow');
  }
  if (retitled) return true;
  const type = card.dataset.cardType;
  if (type === 'task') {
    const rows = [...card.querySelectorAll('.task-row')];
    if (rows.length > 1) return true;
    return rows.some(r => {
      const t = (r.querySelector('.task-text')?.innerText || '').trim();
      return (r.querySelector('input')?.checked || false) || (!!t && t !== 'New task');
    });
  }
  if (type === 'link') {
    const url = (card.querySelector('.link-empty input')?.value || '').trim();
    const linkTitle = (card.querySelector('.link-preview-title')?.value || '').trim();
    return !!url || (!!linkTitle && linkTitle !== 'Untitled link');
  }
  if (type === 'photo') return !!card.dataset.src;
  if (type === 'chinese') {
    return ['.chinese-word-input', '.chinese-pinyin', '.chinese-english', '.chinese-meaning-input', '.chinese-example']
      .some(sel => (card.querySelector(sel)?.value || '').trim());
  }
  const text = (card.querySelector('.editor')?.innerText || '').replace(/\s+/g, ' ').trim();
  return !!text && text !== 'Write something meaningful…';
}
function deleteSelected(card) {
  if (!card) return;
  if (cardHasContent(card)) openDeleteConfirm(card);
  else {
    const board = card.closest('.board');
    card.remove();
    if (board) fitBoardToContent(board);
    scheduleSave();
  }
}
confirmActions.addEventListener('click', e => {
  const action = e.target.dataset.confirm, target = pendingDelete;
  if (!action || !target) return;
  if (action === 'cancel') { closeConfirm(); return; }
  if (target.kind === 'file') {
    if (action === 'delete') deleteFileNode(target.row);
  } else {
    const board = target.closest('.board');
    if (action === 'move') { [...target.querySelectorAll('.in-column')].forEach(sendToCanvas); target.remove(); }
    if (action === 'delete-all') target.remove();
    if (action === 'delete') target.remove();
    if (board && document.documentElement.contains(board)) fitBoardToContent(board);
  }
  closeConfirm();
  scheduleSave();
});
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && confirmDialog.classList.contains('open')) { e.preventDefault(); closeConfirm(); return; }
  if (e.target.closest('#fileTree,#fileSearch')) return;
  const editing = e.target.closest('input,textarea,[contenteditable="true"]');
  const deleteKey = e.key === 'Backspace' || e.key === 'Delete';
  if ((deleteKey || e.key === 'Enter') && !editing && !confirmDialog.classList.contains('open') && selected.size === 1) {
    e.preventDefault();
    deleteSelected([...selected][0]);
  }
});

/* ---------------------------------------------------------------------
   Export (PDF via print, PNG via canvas snapshot)
--------------------------------------------------------------------- */
const exportButton = document.getElementById('exportButton'), exportMenu = document.getElementById('exportMenu');
exportButton.addEventListener('click', () => {
  exportMenu.classList.toggle('open');
  if (exportMenu.classList.contains('open')) exportMenu.querySelector('button').focus();
});
function exportFeedback(message) {
  exportMenu.classList.remove('open');
  exportButton.setAttribute('title', message);
  setTimeout(() => exportButton.setAttribute('title', 'Export workspace'), 1800);
}
exportMenu.addEventListener('click', e => {
  const kind = e.target.dataset.export;
  if (!kind) return;
  if (kind === 'pdf') { window.print(); exportFeedback('PDF export opened'); return; }
  const cards = [...world.querySelectorAll('.workspace-card')];
  const maxX = Math.max(800, ...cards.map(c => (parseFloat(c.style.left) || 0) + c.offsetWidth));
  const maxY = Math.max(500, ...cards.map(c => (parseFloat(c.style.top) || 0) + c.offsetHeight));
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${maxX}" height="${maxY}"><rect width="100%" height="100%" fill="#f4f5f4"/><text x="24" y="36" font-family="DM Sans, sans-serif" font-size="18" fill="#26313d">Visual Workspace</text></svg>`;
  const image = new Image();
  image.onload = () => {
    const canvas = document.createElement('canvas');
    canvas.width = maxX; canvas.height = maxY;
    canvas.getContext('2d').drawImage(image, 0, 0);
    const a = document.createElement('a');
    a.download = 'visual-workspace.png';
    a.href = canvas.toDataURL('image/png');
    a.click();
    exportFeedback('PNG export ready');
  };
  image.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
});
document.addEventListener('click', e => { if (!e.target.closest('#exportButton,#exportMenu')) exportMenu.classList.remove('open'); });

/* ---------------------------------------------------------------------
   File sidebar / file tree
--------------------------------------------------------------------- */
function buildFileRow(f) {
  const row = document.createElement('div');
  row.className = 'file-row';
  row.dataset.node = f.id;
  if (f.parent) row.dataset.parent = f.parent;
  row.dataset.folder = f.isFolder ? 'true' : 'false';
  row.dataset.depth = f.depth;
  row.setAttribute('role', 'treeitem');
  row.tabIndex = 0;
  if (f.isFolder) {
    const chevronHtml = f.parent
      ? `<button type="button" class="file-chevron" aria-label="Expand ${escapeAttr(f.name)}"><i data-lucide="chevron-right"></i></button>`
      : `<span style="width:14px"></span>`;
    row.innerHTML = `${chevronHtml}<i data-lucide="folder"></i><span class="file-label" contenteditable="true">${escapeHtml(f.name)}</span><span class="file-row-actions"><button type="button" class="file-add" aria-label="Add inside ${escapeAttr(f.name)}"><i data-lucide="plus"></i></button><button type="button" class="file-delete" aria-label="Delete ${escapeAttr(f.name)}"><i data-lucide="trash-2"></i></button></span>`;
  } else {
    row.draggable = true;
    row.innerHTML = `<span style="width:14px"></span><i data-lucide="file-text"></i><span class="file-label" contenteditable="true">${escapeHtml(f.name)}</span><span class="file-row-actions"><button type="button" class="file-delete" aria-label="Delete ${escapeAttr(f.name)}"><i data-lucide="trash-2"></i></button></span>`;
  }
  return row;
}

function renderFileTree(filter = '') {
  const query = filter.trim().toLowerCase();
  const rows = [...fileTree.querySelectorAll('.file-row')];
  const byParent = new Map();
  for (const r of rows) {
    const p = r.dataset.parent || '';
    if (!byParent.has(p)) byParent.set(p, []);
    byParent.get(p).push(r);
  }
  const knownIds = new Set(rows.map(r => r.dataset.node));
  const roots = rows.filter(r => !r.dataset.parent || !knownIds.has(r.dataset.parent));
  const ordered = [];
  const visible = new Set();
  const visit = (row, hidden) => {
    ordered.push(row);
    const isFolder = row.dataset.folder === 'true';
    const collapsed = isFolder && row.dataset.parent && !fileState.expanded.has(row.dataset.node);
    const nextHidden = query ? false : hidden || collapsed;
    const matches = !query || row.querySelector('.file-label').textContent.toLowerCase().includes(query);
    if (!hidden && matches) visible.add(row);
    (byParent.get(row.dataset.node) || []).forEach(child => visit(child, nextHidden));
  };
  roots.forEach(r => visit(r, false));
  ordered.forEach(r => fileTree.appendChild(r));

  let shown = 0;
  rows.forEach(row => {
    const show = visible.has(row);
    row.style.display = show ? 'flex' : 'none';
    if (show) shown++;
    row.style.paddingLeft = (5 + (parseInt(row.dataset.depth) || 0) * 15) + 'px';
if (row.dataset.folder === 'true' && row.querySelector('.file-chevron')) {
      const open = fileState.expanded.has(row.dataset.node);
      const chevron = row.querySelector('.file-chevron');
      chevron.innerHTML = `<i data-lucide="${open ? 'chevron-down' : 'chevron-right'}"></i>`;
      chevron.setAttribute('aria-label', `${open ? 'Collapse' : 'Expand'} ${row.querySelector('.file-label').textContent}`);
    }
  });
  document.getElementById('fileFilterEmpty').classList.toggle('show', !!query && !shown);
  refreshIcons();
}

function selectFile(row) {
  fileTree.querySelectorAll('.file-row').forEach(r => r.classList.remove('selected'));
  row.classList.add('selected');
  fileState.selected = row.dataset.node;
  if (row.dataset.folder !== 'true') switchToFile(row.dataset.node);
}

function expandAncestorsOf(nodeId) {
  let row = nodeId && fileTree.querySelector(`[data-node="${nodeId}"]`);
  let parent = row?.dataset.parent;
  while (parent) {
    fileState.expanded.add(parent);
    row = fileTree.querySelector(`[data-node="${parent}"]`);
    parent = row?.dataset.parent;
  }
}
function ensureCurrentFileExists() {
  let leaf = [...fileTree.querySelectorAll('.file-row')].find(r => r.dataset.folder !== 'true');
  if (!leaf) {
    const id = uid('file');
    leaf = buildFileRow({ id, parent: workspaceRootId(), name: 'Untitled', isFolder: false, depth: 1 });
    fileTree.appendChild(leaf);
    renderFileTree(fileSearch.value);
    refreshIcons();
  }
  return leaf.dataset.node;
}
function renderCurrentCanvas() {
  world.querySelectorAll(':scope > .workspace-card').forEach(c => c.remove());
  (cardCache[currentFileId] || []).forEach(hydrateCard);
  selected.clear();
  document.getElementById('selectionActions').classList.remove('show');
  refreshIcons();
  renderPinterestEmbeds(world);
}
function cardsBoundingBox() {
  const cards = [...world.querySelectorAll(':scope > .workspace-card')];
  if (!cards.length) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  cards.forEach(c => {
    const x = parseFloat(c.style.left) || 0;
    const y = parseFloat(c.style.top) || 0;
    const w = c.offsetWidth || 465;
    const h = c.offsetHeight || 110;
    minX = Math.min(minX, x); minY = Math.min(minY, y);
    maxX = Math.max(maxX, x + w); maxY = Math.max(maxY, y + h);
  });
  return { minX, minY, maxX, maxY };
}
function focusOnCards() {
  const b = cardsBoundingBox();
  if (!b) return;
  const vw = viewport.clientWidth, vh = viewport.clientHeight;
  const bw = Math.max(b.maxX - b.minX, 1), bh = Math.max(b.maxY - b.minY, 1);
  const pad = 80;
  const fit = Math.min(BASE_SCALE, (vw - pad * 2) / bw, (vh - pad * 2) / bh);
  scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, fit));
  pan.x = vw / 2 - (b.minX + bw / 2) * scale;
  pan.y = vh / 2 - (b.minY + bh / 2) * scale;
  applyTransform();
}
function highlightCurrentFile() {
  if (!currentFileId) return;
  [...fileTree.querySelectorAll('.file-row')].forEach(r =>
    r.classList.toggle('selected', r.dataset.node === currentFileId && r.dataset.folder !== 'true'));
  fileState.selected = currentFileId;
}
function switchToFile(fileId) {
  if (!fileId || fileId === currentFileId) return;
  persistWorkspace();
  currentFileId = fileId;
  expandAncestorsOf(fileId);
  renderFileTree(fileSearch.value);
  highlightCurrentFile();
  renderCurrentCanvas();
  requestAnimationFrame(focusOnCards);
  scheduleSave();
}

function fileDescendants(nodeId) {
  const result = [], queue = [nodeId];
  while (queue.length) {
    const id = queue.shift();
    fileTree.querySelectorAll(`[data-parent="${id}"]`).forEach(r => { result.push(r); queue.push(r.dataset.node); });
  }
  return result;
}
function deleteFileNode(row) {
  const id = row.dataset.node;
  const doomed = [row, ...fileDescendants(id)];
  doomed.forEach(r => { r.remove(); delete cardCache[r.dataset.node]; });
  if (fileState.selected === id) fileState.selected = null;
  renderFileTree(fileSearch.value);
  if (![...fileTree.querySelectorAll('.file-row')].some(r => r.dataset.folder !== 'true' && r.dataset.node === currentFileId)) {
    currentFileId = ensureCurrentFileExists();
    expandAncestorsOf(currentFileId);
    renderFileTree(fileSearch.value);
    highlightCurrentFile();
    renderCurrentCanvas();
    scheduleSave();
  }
}
function openFileDeleteConfirm(row) {
  if (!row) return;
  const isFolder = row.dataset.folder === 'true';
  const name = row.querySelector('.file-label').textContent.trim();
  pendingDelete = { kind: 'file', row };
  confirmDialog.classList.add('open');
  confirmTitle.textContent = isFolder ? 'Delete this folder?' : 'Delete this file?';
  confirmMessage.textContent = isFolder
    ? `Delete "${name}" and everything inside it? This action cannot be undone.`
    : `Delete "${name}"? This action cannot be undone.`;
  confirmActions.innerHTML = '<button type="button" data-confirm="cancel">Cancel</button><button type="button" class="primary" data-confirm="delete">Delete</button>';
  confirmActions.querySelector('[data-confirm="cancel"]').focus();
}
document.getElementById('deleteFile').addEventListener('click', () => {
  const selectedRow = [...fileTree.querySelectorAll('.file-row.selected')][0] ||
    [...fileTree.querySelectorAll('.file-row')].find(r => fileState.selected === r.dataset.node);
  openFileDeleteConfirm(selectedRow);
});

function clearFileSelection() {
  fileTree.querySelectorAll('.file-row.selected').forEach(r => r.classList.remove('selected'));
  fileState.selected = null;
}

fileTree.addEventListener('click', e => {
  const row = e.target.closest('.file-row');
  if (!row) { clearFileSelection(); return; }
  if (e.target.closest('.file-chevron')) {
    fileState.expanded.has(row.dataset.node) ? fileState.expanded.delete(row.dataset.node) : fileState.expanded.add(row.dataset.node);
    renderFileTree(fileSearch.value);
    scheduleSave();
    return;
  }
  if (e.target.closest('.file-delete')) {
    if (row.dataset.folder === 'true' && fileTree.querySelector(`[data-parent="${row.dataset.node}"]`)) {
      if (!row.dataset.confirm) { row.dataset.confirm = '1'; e.target.closest('button').title = 'Click again to delete'; setTimeout(() => row.dataset.confirm = '', 3000); return; }
    }
    row.remove();
    renderFileTree(fileSearch.value);
    scheduleSave();
    return;
  }
  if (e.target.closest('.file-add')) { addFileNode(row.dataset.node); return; }
  if (e.target.closest('.file-row-actions')) return;
  selectFile(row);
});
fileTree.addEventListener('keydown', e => {
  const row = e.target.closest('.file-row');
  if (!row) return;
  if ((e.key === 'Enter' || e.key === ' ') && row.dataset.folder === 'true' && e.target === row) {
    e.preventDefault();
    fileState.expanded.has(row.dataset.node) ? fileState.expanded.delete(row.dataset.node) : fileState.expanded.add(row.dataset.node);
    renderFileTree(fileSearch.value);
  }
});
fileTree.addEventListener('dragstart', e => { const row = e.target.closest('[draggable="true"]'); if (row) e.dataTransfer.setData('text/plain', row.dataset.node); });
fileTree.addEventListener('dragover', e => { const row = e.target.closest('[data-folder="true"]'); if (row) { e.preventDefault(); row.classList.add('drop-target'); } });
fileTree.addEventListener('dragleave', e => e.target.closest('.file-row')?.classList.remove('drop-target'));
fileTree.addEventListener('drop', e => {
  const target = e.target.closest('[data-folder="true"]'), id = e.dataTransfer.getData('text/plain'), source = fileTree.querySelector(`[data-node="${id}"]`);
  if (target && source && target !== source && source.dataset.folder !== 'true') {
    e.preventDefault();
    source.dataset.parent = target.dataset.node;
    source.dataset.depth = (parseInt(target.dataset.depth) || 0) + 1;
    fileState.expanded.add(target.dataset.node);
    target.classList.remove('drop-target');
    renderFileTree(fileSearch.value);
    scheduleSave();
  }
});
fileTree.addEventListener('dblclick', e => { if (e.target.classList.contains('file-label')) { e.target.focus(); document.execCommand('selectAll', false, null); } });

function workspaceRootId() {
  return [...fileTree.querySelectorAll('.file-row')].find(r => r.dataset.folder === 'true' && !r.dataset.parent)?.dataset.node || 'workspace';
}
function addFileNode(folder) {
  const fRow = folder ? fileTree.querySelector(`[data-node="${folder}"]`) : null;
  const inFolder = fRow && fRow.dataset.folder === 'true' && fRow.dataset.parent;
  const parent = inFolder ? fRow.dataset.node : workspaceRootId();
  const id = uid('file');
  const depth = ((fRow && inFolder ? parseInt(fRow.dataset.depth) || 0 : 0)) + 1;
  const row = buildFileRow({ id, parent, name: 'New file', isFolder: false, depth });
  fileTree.appendChild(row);
  fileState.expanded.add(parent);
  row.querySelector('.file-label').focus();
  refreshIcons();
  renderFileTree(fileSearch.value);
  switchToFile(id);
}
function addFolderNode(/* parent ignored: folders are always created directly under Workspace */) {
  const parent = workspaceRootId();
  const id = uid('folder');
  const depth = (parseInt(fileTree.querySelector(`[data-node="${parent}"]`)?.dataset.depth) || 0) + 1;
  const row = buildFileRow({ id, parent, name: 'New folder', isFolder: true, depth });
  fileTree.appendChild(row);
  fileState.expanded.add(parent);
  row.querySelector('.file-label').focus();
  refreshIcons();
  renderFileTree(fileSearch.value);
  scheduleSave();
}

document.getElementById('filesToggle').addEventListener('click', () => {
  const collapsed = fileSidebar.classList.toggle('collapsed');
  const btn = document.getElementById('filesToggle');
  btn.setAttribute('aria-label', collapsed ? 'Expand files' : 'Collapse files');
  btn.setAttribute('title', collapsed ? 'Expand files' : 'Collapse files');
  btn.innerHTML = `<i data-lucide="${collapsed ? 'panel-left-open' : 'panel-left-close'}"></i>`;
  refreshIcons();
});
fileSearch.addEventListener('focus', () => fileSidebar.classList.remove('collapsed'));
fileSearch.addEventListener('input', () => renderFileTree(fileSearch.value));
document.getElementById('addFile').addEventListener('click', () => {
  const activeFolder = [...fileTree.querySelectorAll('.selected')].find(r => r.dataset.folder === 'true');
  addFileNode(activeFolder ? activeFolder.dataset.node : null);
});
document.getElementById('addFolder').addEventListener('click', () => addFolderNode('workspace'));

/* ---------------------------------------------------------------------
   Global autosave triggers for plain input/change events
--------------------------------------------------------------------- */
document.addEventListener('input', e => {
  if (e.target.id === 'fileSearch' || e.target.id === 'workspaceSearch') return;
  const board = e.target.closest('.board');
  if (board) requestAnimationFrame(() => fitBoardToContent(board));
  scheduleSave();
});
document.addEventListener('change', e => {
  if (e.target.id === 'fileSearch' || e.target.id === 'workspaceSearch') return;
  scheduleSave();
});

/* ---------------------------------------------------------------------
   Boot: load workspace from the server
--------------------------------------------------------------------- */
async function loadWorkspace() {
  try {
    const res = await fetch('/api/workspace');
    const data = await res.json();
    (data.files || []).forEach(f => fileTree.appendChild(buildFileRow(f)));
    const leafNodes = [...fileTree.querySelectorAll('.file-row')].filter(r => r.dataset.folder !== 'true');
    currentFileId = (data.currentFile && leafNodes.find(r => r.dataset.node === data.currentFile))?.dataset.node
      || leafNodes[0]?.dataset.node || null;
    if (!currentFileId) currentFileId = ensureCurrentFileExists();

    fileState.expanded = new Set(data.fileExpanded && data.fileExpanded.length ? data.fileExpanded : ['workspace']);
    expandAncestorsOf(currentFileId);
    renderFileTree(fileSearch.value);

    (data.cards || []).forEach(c => {
      const fid = c.fileId || currentFileId;
      (cardCache[fid] ||= []).push(c);
    });

    highlightCurrentFile();
    renderCurrentCanvas();
    requestAnimationFrame(focusOnCards);

    showSaveStatus('Saved');
  } catch (err) {
    console.error('Failed to load workspace', err);
    showSaveStatus('Offline — changes will not be saved');
  }
  refreshIcons();
}

applyTransform();
loadWorkspace();
