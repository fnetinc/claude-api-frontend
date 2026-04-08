import Anthropic from "@anthropic-ai/sdk";
import express from "express";
import multer from "multer";
import cookieParser from "cookie-parser";
import crypto from "crypto";
import Database from "better-sqlite3";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// SQLite database — use RAILWAY_VOLUME_MOUNT_PATH if available for persistence
const dbPath = process.env.RAILWAY_VOLUME_MOUNT_PATH
  ? join(process.env.RAILWAY_VOLUME_MOUNT_PATH, "notes.db")
  : join(__dirname, "notes.db");
const db = new Database(dbPath);
db.pragma("journal_mode = WAL");

// Create notes table
db.exec(`
  CREATE TABLE IF NOT EXISTS notes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL DEFAULT 'Untitled',
    command TEXT NOT NULL DEFAULT '',
    notes TEXT NOT NULL DEFAULT '',
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  )
`);

// Migrate: add columns if upgrading from old schema
try {
  db.exec(`ALTER TABLE notes ADD COLUMN command TEXT NOT NULL DEFAULT ''`);
} catch (e) { /* column already exists */ }
try {
  db.exec(`ALTER TABLE notes ADD COLUMN notes TEXT NOT NULL DEFAULT ''`);
} catch (e) { /* column already exists */ }
try {
  db.exec(`ALTER TABLE notes ADD COLUMN section TEXT NOT NULL DEFAULT 'creative_copy'`);
} catch (e) { /* column already exists */ }
try {
  db.exec(`ALTER TABLE notes ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0`);
} catch (e) { /* column already exists */ }
// Migrate old content column to command if it exists
try {
  db.exec(`UPDATE notes SET command = content WHERE command = '' AND content != ''`);
} catch (e) { /* no content column */ }
// Initialize sort_order for existing notes that have none
try {
  db.exec(`UPDATE notes SET sort_order = id WHERE sort_order = 0`);
} catch (e) { /* ignore */ }

const app = express();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
});

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Auth config — set LOGIN_USERNAME and LOGIN_PASSWORD env vars on Railway
const LOGIN_USERNAME = process.env.LOGIN_USERNAME || "admin";
const LOGIN_PASSWORD = process.env.LOGIN_PASSWORD || "changeme";

// In-memory session store (tokens mapped to expiry timestamps)
const sessions = new Map();

function createSession(rememberMe) {
  const token = crypto.randomBytes(32).toString("hex");
  const maxAge = rememberMe ? 30 * 24 * 60 * 60 * 1000 : 24 * 60 * 60 * 1000; // 30 days or 1 day
  sessions.set(token, Date.now() + maxAge);
  return { token, maxAge };
}

function isValidSession(token) {
  if (!token || !sessions.has(token)) return false;
  if (Date.now() > sessions.get(token)) {
    sessions.delete(token);
    return false;
  }
  return true;
}

// Cleanup expired sessions every hour
setInterval(() => {
  const now = Date.now();
  for (const [token, expiry] of sessions) {
    if (now > expiry) sessions.delete(token);
  }
}, 60 * 60 * 1000);

app.use(cookieParser());
app.use(express.json({ limit: "50mb" }));

// Auth middleware — protect everything except login routes and static login page
function requireAuth(req, res, next) {
  if (isValidSession(req.cookies.session)) {
    return next();
  }
  // For API calls, return 401
  if (req.path.startsWith("/api/")) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  // For page requests, redirect to login
  return res.redirect("/login.html");
}

// Login API
app.post("/api/login", (req, res) => {
  const { username, password, remember } = req.body;
  if (username === LOGIN_USERNAME && password === LOGIN_PASSWORD) {
    const rememberMe = remember === "on" || remember === "true";
    const { token, maxAge } = createSession(rememberMe);
    res.cookie("session", token, {
      httpOnly: true,
      sameSite: "lax",
      maxAge,
      secure: process.env.NODE_ENV === "production",
    });
    return res.json({ success: true });
  }
  return res.status(401).json({ error: "Invalid password" });
});

// Logout
app.post("/api/logout", (req, res) => {
  const token = req.cookies.session;
  if (token) sessions.delete(token);
  res.clearCookie("session");
  res.json({ success: true });
});

// Serve login page without auth
app.get("/login.html", (req, res) => {
  // If already logged in, redirect to app
  if (isValidSession(req.cookies.session)) {
    return res.redirect("/");
  }
  res.sendFile(join(__dirname, "public", "login.html"));
});

// Protect all other routes
app.get("/", requireAuth, (req, res) => {
  res.sendFile(join(__dirname, "public", "index.html"));
});

// Serve static files with auth (except login.html)
app.use((req, res, next) => {
  if (req.path === "/login.html") return next();
  requireAuth(req, res, next);
}, express.static(join(__dirname, "public")));

// --- Notes CRUD API ---
app.get("/api/notes", requireAuth, (req, res) => {
  const notes = db.prepare("SELECT * FROM notes ORDER BY section, sort_order ASC").all();
  res.json(notes);
});

app.post("/api/notes", requireAuth, (req, res) => {
  const { title, command, notes, section } = req.body;
  const validSection = section === "images" ? "images" : "creative_copy";
  // Place new note at end of its section
  const maxOrder = db.prepare("SELECT MAX(sort_order) as m FROM notes WHERE section = ?").get(validSection);
  const sortOrder = (maxOrder.m || 0) + 1;
  const result = db.prepare(
    "INSERT INTO notes (title, command, notes, section, sort_order) VALUES (?, ?, ?, ?, ?)"
  ).run(title || "Untitled", command || "", notes || "", validSection, sortOrder);
  const note = db.prepare("SELECT * FROM notes WHERE id = ?").get(result.lastInsertRowid);
  res.json(note);
});

app.put("/api/notes/:id", requireAuth, (req, res) => {
  const { title, command, notes, section } = req.body;
  const { id } = req.params;
  const validSection = section === "images" ? "images" : "creative_copy";
  db.prepare(
    "UPDATE notes SET title = ?, command = ?, notes = ?, section = ?, updated_at = datetime('now') WHERE id = ?"
  ).run(title, command, notes, validSection, id);
  const note = db.prepare("SELECT * FROM notes WHERE id = ?").get(id);
  if (!note) return res.status(404).json({ error: "Note not found" });
  res.json(note);
});

app.delete("/api/notes/:id", requireAuth, (req, res) => {
  const { id } = req.params;
  const result = db.prepare("DELETE FROM notes WHERE id = ?").run(id);
  if (result.changes === 0) return res.status(404).json({ error: "Note not found" });
  res.json({ success: true });
});

// Reorder notes within a section
app.post("/api/notes/reorder", requireAuth, (req, res) => {
  const { orders } = req.body; // [{ id, sort_order }]
  if (!Array.isArray(orders)) return res.status(400).json({ error: "Invalid payload" });
  const update = db.prepare("UPDATE notes SET sort_order = ? WHERE id = ?");
  const tx = db.transaction(() => {
    for (const { id, sort_order } of orders) {
      update.run(sort_order, id);
    }
  });
  tx();
  res.json({ success: true });
});

// Detect image media type from magic bytes
function detectImageType(buffer) {
  if (!buffer || buffer.length < 4) return null;
  // PNG: 89 50 4E 47
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4E && buffer[3] === 0x47) return "image/png";
  // JPEG: FF D8 FF
  if (buffer[0] === 0xFF && buffer[1] === 0xD8 && buffer[2] === 0xFF) return "image/jpeg";
  // GIF: 47 49 46 38
  if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x38) return "image/gif";
  // WebP: RIFF....WEBP
  if (buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46 &&
      buffer.length >= 12 && buffer[8] === 0x57 && buffer[9] === 0x45 && buffer[10] === 0x42 && buffer[11] === 0x50) return "image/webp";
  return null;
}

app.post("/api/chat", requireAuth, upload.array("images", 50), async (req, res) => {
  try {
    const { prompt, model } = req.body;

    if (!prompt) {
      return res.status(400).json({ error: "Prompt is required" });
    }

    const modelId =
      model === "opus" ? "claude-opus-4-6" : "claude-sonnet-4-6";

    const content = [];

    // Add uploaded images
    if (req.files && req.files.length > 0) {
      for (const file of req.files) {
        const base64 = file.buffer.toString("base64");

        // Detect actual media type from magic bytes — don't trust browser MIME
        const mediaType = detectImageType(file.buffer) || file.mimetype;

        if (!mediaType.startsWith("image/")) {
          continue;
        }

        content.push({
          type: "image",
          source: {
            type: "base64",
            media_type: mediaType,
            data: base64,
          },
        });
      }
    }

    // Add uploaded text / HTML files as text content blocks
    if (req.body.textFilesData) {
      try {
        const textFiles = JSON.parse(req.body.textFilesData);
        for (const { name, content: fileContent } of textFiles) {
          content.push({
            type: "text",
            text: `--- File: ${name} ---\n${fileContent}\n--- End of ${name} ---`,
          });
        }
      } catch (e) { /* malformed JSON, skip */ }
    }

    content.push({ type: "text", text: prompt });

    // Use streaming for long responses
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");

    const stream = await client.messages.stream({
      model: modelId,
      max_tokens: 32000,
      messages: [{ role: "user", content }],
    });

    for await (const event of stream) {
      if (
        event.type === "content_block_delta" &&
        event.delta.type === "text_delta"
      ) {
        res.write(`data: ${JSON.stringify({ text: event.delta.text })}\n\n`);
      }
    }

    const finalMessage = await stream.finalMessage();
    res.write(
      `data: ${JSON.stringify({
        done: true,
        usage: {
          input_tokens: finalMessage.usage.input_tokens,
          output_tokens: finalMessage.usage.output_tokens,
        },
      })}\n\n`
    );
    res.end();
  } catch (err) {
    console.error("API error:", err);
    if (!res.headersSent) {
      res.status(500).json({ error: err.message });
    } else {
      res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
      res.end();
    }
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
