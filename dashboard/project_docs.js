import { getDb } from './db.js';

export function listDocs(projectId) {
  return getDb().prepare(
    'SELECT id, title, mime_type, source, created_at FROM project_docs WHERE project_id = ? ORDER BY created_at DESC'
  ).all(projectId);
}

export function getDoc(id) {
  return getDb().prepare('SELECT * FROM project_docs WHERE id = ?').get(id) ?? null;
}

export function createDoc({ projectId, title, mimeType = 'text/plain', content, source = 'upload' }) {
  const r = getDb().prepare(
    'INSERT INTO project_docs (project_id, title, mime_type, content, source) VALUES (?, ?, ?, ?, ?)'
  ).run(projectId, title, mimeType, content, source);
  return r.lastInsertRowid;
}

export function deleteDoc(id) {
  getDb().prepare('DELETE FROM project_docs WHERE id = ?').run(id);
}

export function listDocsWithContent(projectId) {
  return getDb().prepare(
    'SELECT id, title, content FROM project_docs WHERE project_id = ? ORDER BY created_at DESC'
  ).all(projectId);
}
