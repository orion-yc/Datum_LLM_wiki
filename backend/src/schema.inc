R"SQL(PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
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
)SQL"