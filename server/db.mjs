import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { randomBytes, randomUUID, scryptSync, timingSafeEqual, createCipheriv, createDecipheriv } from 'node:crypto';

export const dataDir = resolve(process.env.DATA_DIR || 'data');
mkdirSync(join(dataDir, 'uploads'), { recursive: true });
export const db = new DatabaseSync(join(dataDir, 'knowledge.sqlite'));
db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
CREATE TABLE IF NOT EXISTS config (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, expires INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS sources (
 id TEXT PRIMARY KEY, title TEXT NOT NULL, filename TEXT NOT NULL, type TEXT NOT NULL,
 category TEXT NOT NULL DEFAULT '个人学习', size INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'processing',
 error TEXT NOT NULL DEFAULT '', progress INTEGER NOT NULL DEFAULT 0, pages INTEGER NOT NULL DEFAULT 0,
 read_progress INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS chunks (
 id TEXT PRIMARY KEY, source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
 page INTEGER NOT NULL, heading TEXT NOT NULL, content TEXT NOT NULL, position INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS chunks_source ON chunks(source_id, position);
CREATE TABLE IF NOT EXISTS notes (
 id TEXT PRIMARY KEY, source_id TEXT REFERENCES sources(id) ON DELETE CASCADE,
 chunk_id TEXT REFERENCES chunks(id) ON DELETE SET NULL, title TEXT NOT NULL, content TEXT NOT NULL,
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS knowledge (
 id TEXT PRIMARY KEY, title TEXT NOT NULL, summary TEXT NOT NULL, tags TEXT NOT NULL DEFAULT '[]',
 prerequisites TEXT NOT NULL DEFAULT '[]', source_id TEXT REFERENCES sources(id) ON DELETE SET NULL,
 chunk_id TEXT REFERENCES chunks(id) ON DELETE SET NULL, mastery TEXT NOT NULL DEFAULT '未评估',
 draft INTEGER NOT NULL DEFAULT 0, due_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS skills (
 id TEXT PRIMARY KEY, title TEXT NOT NULL, description TEXT NOT NULL, criteria TEXT NOT NULL,
 knowledge_ids TEXT NOT NULL DEFAULT '[]', status TEXT NOT NULL DEFAULT '学习中', evidence TEXT NOT NULL DEFAULT '',
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS plans (
 id TEXT PRIMARY KEY, title TEXT NOT NULL, goal TEXT NOT NULL, due_date TEXT,
 source_id TEXT REFERENCES sources(id) ON DELETE SET NULL, steps TEXT NOT NULL DEFAULT '[]',
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS practices (
 id TEXT PRIMARY KEY, knowledge_id TEXT REFERENCES knowledge(id) ON DELETE SET NULL,
 prompt TEXT NOT NULL, reference TEXT NOT NULL, answer TEXT NOT NULL DEFAULT '', feedback TEXT NOT NULL DEFAULT '',
 feedback_mode TEXT NOT NULL DEFAULT 'self', status TEXT NOT NULL DEFAULT 'pending', rating TEXT,
 due_at TEXT, reviewed_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS conversations (
 id TEXT PRIMARY KEY, title TEXT NOT NULL, source_id TEXT REFERENCES sources(id) ON DELETE SET NULL,
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS messages (
 id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
 role TEXT NOT NULL, content TEXT NOT NULL, citations TEXT NOT NULL DEFAULT '[]', mode TEXT NOT NULL DEFAULT '',
 created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS activity (
 id TEXT PRIMARY KEY, kind TEXT NOT NULL, label TEXT NOT NULL, created_at TEXT NOT NULL
);
`);

const keyPath = join(dataDir, '.encryption-key');
if (!existsSync(keyPath)) writeFileSync(keyPath, randomBytes(32), { mode: 0o600, flag: 'wx' });
const encryptionKey = readFileSync(keyPath);

export const now = () => new Date().toISOString();
export const id = () => randomUUID();
export const all = (sql, ...args) => db.prepare(sql).all(...args);
export const one = (sql, ...args) => db.prepare(sql).get(...args);
export const run = (sql, ...args) => db.prepare(sql).run(...args);
export function transaction(fn) { db.exec('BEGIN'); try { const result = fn(); db.exec('COMMIT'); return result; } catch (e) { db.exec('ROLLBACK'); throw e; } }
export function config(key) { return one('SELECT value FROM config WHERE key=?', key)?.value || ''; }
export function setConfig(key, value) { run('INSERT INTO config(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', key, value); }
export function activity(kind, label) { run('INSERT INTO activity VALUES(?,?,?,?)', id(), kind, label, now()); }
export function hashPassword(password) { const salt = randomBytes(16).toString('hex'); return `${salt}:${scryptSync(password, salt, 64).toString('hex')}`; }
export function verifyPassword(password, stored) { const [salt, hash] = stored.split(':'); if (!salt || !hash) return false; const candidate = scryptSync(password, salt, 64); const expected = Buffer.from(hash, 'hex'); return candidate.length === expected.length && timingSafeEqual(candidate, expected); }
export function encrypt(value) { if (!value) return ''; const iv = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', encryptionKey, iv); const content = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]); return [iv, cipher.getAuthTag(), content].map(b => b.toString('base64')).join('.'); }
export function decrypt(value) { if (!value) return ''; const [iv, tag, body] = value.split('.').map(s => Buffer.from(s, 'base64')); const cipher = createDecipheriv('aes-256-gcm', encryptionKey, iv); cipher.setAuthTag(tag); return cipher.update(body, undefined, 'utf8') + cipher.final('utf8'); }
export function decode(row) {
  if (!row) return row;
  const result = { ...row };
  for (const key of ['tags', 'prerequisites', 'steps', 'knowledge_ids', 'citations']) if (key in result) result[key] = JSON.parse(result[key]);
  if ('draft' in result) result.draft = Boolean(result.draft);
  return result;
}
