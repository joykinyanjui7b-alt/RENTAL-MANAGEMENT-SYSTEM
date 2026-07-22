require("dotenv").config();
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { URL } = require("url");
const { Pool } = require("pg");

const PORT = process.env.PORT || 3000;
const ROOT_DIR = __dirname;
const PUBLIC_DIR = path.join(ROOT_DIR, "public");
const PUBLIC_FILES_DIR = path.join(PUBLIC_DIR, "files");
const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  console.error("DATABASE_URL is required. Set it in .env for local development or in Supabase environment settings.");
  process.exit(1);
}

const ALLOWED_ORIGINS = process.env.CORS_ORIGIN ? process.env.CORS_ORIGIN.split(",").map((origin) => origin.trim()) : [];

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : undefined
});

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".pdf": "application/pdf",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".ico": "image/x-icon"
};

async function query(text, params = []) {
  const result = await pool.query(text, params);
  return result;
}

function mapDocument(row) {
  const dueDate = row.due_date ? (row.due_date instanceof Date ? row.due_date.toISOString().slice(0, 10) : String(row.due_date)) : "";
  return {
    id: row.id,
    title: row.title,
    owner: row.owner,
    category: row.category,
    status: row.status,
    priority: row.priority,
    dueDate,
    summary: row.summary,
    link: row.link,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString()
  };
}

function mapNote(row) {
  return {
    id: row.id,
    body: row.body,
    createdAt: new Date(row.created_at).toISOString()
  };
}

function parseCookies(cookieHeader) {
  return String(cookieHeader || "")
    .split(";")
    .map((pair) => pair.trim())
    .filter(Boolean)
    .reduce((cookies, pair) => {
      const [name, value] = pair.split("=");
      cookies[name] = value;
      return cookies;
    }, {});
}

function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  const derived = crypto.pbkdf2Sync(password, salt, 310000, 32, "sha256").toString("hex");
  return `${salt}:${derived}`;
}

function verifyPassword(password, storedHash) {
  if (!storedHash) {
    return false;
  }

  const [salt, hashed] = storedHash.split(":");
  if (!salt || !hashed) {
    return false;
  }

  const attempt = crypto.pbkdf2Sync(password, salt, 310000, 32, "sha256").toString("hex");
  return crypto.timingSafeEqual(Buffer.from(hashed, "hex"), Buffer.from(attempt, "hex"));
}

function sanitizeUser(row) {
  return {
    id: row.user_id || row.id,
    email: row.email,
    fullName: row.full_name,
    createdAt: new Date(row.created_at).toISOString()
  };
}

function getUserByEmail(email) {
  return query("SELECT * FROM users WHERE email = $1", [email]).then((result) =>
    result.rowCount === 0 ? null : result.rows[0]
  );
}

async function createUser(email, fullName, password) {
  const id = crypto.randomUUID();
  const passwordHash = hashPassword(password);
  await query(
    `INSERT INTO users (id, email, full_name, password_hash, created_at)
     VALUES ($1, $2, $3, $4, now())`,
    [id, email, fullName, passwordHash]
  );
  return { id, email, fullName };
}

async function requireAuth(res, req) {
  const user = await authenticateRequest(req);
  if (!user) {
    sendError(res, 401, "Authentication required", req);
    return null;
  }
  return user;
}

function sendSessionCookie(res, token) {
  const isProduction = process.env.NODE_ENV === "production";
  const sameSite = isProduction ? "None" : "Lax";
  const secure = isProduction ? "; Secure" : "";
  const maxAge = 7 * 24 * 60 * 60;

  res.setHeader(
    "Set-Cookie",
    `session_token=${token}; HttpOnly; SameSite=${sameSite}; Path=/; Max-Age=${maxAge}${secure}`
  );
}

function clearSessionCookie(res) {
  const isProduction = process.env.NODE_ENV === "production";
  const sameSite = isProduction ? "None" : "Lax";
  const secure = isProduction ? "; Secure" : "";

  res.setHeader(
    "Set-Cookie",
    `session_token=; HttpOnly; SameSite=${sameSite}; Path=/; Max-Age=0${secure}`
  );
}

async function getSession(token) {
  const result = await query(
    `SELECT s.token, s.expires_at, u.id AS user_id, u.email, u.full_name, u.created_at
     FROM sessions s
     JOIN users u ON u.id = s.user_id
     WHERE s.token = $1`,
    [token]
  );

  return result.rowCount === 0 ? null : result.rows[0];
}

async function createSession(userId) {
  const token = crypto.randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

  await query(
    `INSERT INTO sessions (token, user_id, expires_at, created_at)
     VALUES ($1, $2, $3, now())`,
    [token, userId, expiresAt]
  );

  return token;
}

async function deleteSession(token) {
  await query("DELETE FROM sessions WHERE token = $1", [token]);
}

async function authenticateRequest(req) {
  const cookies = parseCookies(req.headers.cookie || "");
  const token = cookies.session_token;
  if (!token) {
    return null;
  }

  const session = await getSession(token);
  if (!session) {
    return null;
  }

  if (new Date(session.expires_at) < new Date()) {
    await deleteSession(token);
    return null;
  }

  return sanitizeUser(session);
}

function setCorsHeaders(res, req) {
  const origin = req && req.headers ? req.headers.origin : undefined;
  if (origin && (ALLOWED_ORIGINS.length === 0 || ALLOWED_ORIGINS.includes(origin))) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  } else if (!origin) {
    res.setHeader("Access-Control-Allow-Origin", "*");
  }
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS");
  res.setHeader("Access-Control-Allow-Credentials", "true");
}

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body)
  });
  res.end(body);
}

function sendError(res, statusCode, message, req) {
  setCorsHeaders(res, req);
  sendJson(res, statusCode, { error: message });
}

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";

    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1_000_000) {
        reject(new Error("Request body is too large"));
        req.destroy();
      }
    });

    req.on("end", () => {
      if (!body) {
        resolve({});
        return;
      }

      try {
        resolve(JSON.parse(body));
      } catch (error) {
        reject(new Error("Invalid JSON body"));
      }
    });

    req.on("error", reject);
  });
}

function normalizeDocument(input) {
  const title = String(input.title || "").trim();
  const owner = String(input.owner || "").trim();
  const category = String(input.category || "General").trim();
  const status = String(input.status || "draft").trim();
  const priority = String(input.priority || "medium").trim();
  const dueDate = String(input.dueDate || "").trim();
  const summary = String(input.summary || "").trim();
  const link = String(input.link || "").trim();

  if (!title) {
    return { error: "Document title is required" };
  }

  if (!owner) {
    return { error: "Document owner is required" };
  }

  if (!dueDate) {
    return { error: "Due date is required" };
  }

  const allowedStatuses = new Set(["draft", "in-review", "approved", "blocked"]);
  const allowedPriorities = new Set(["low", "medium", "high"]);

  return {
    title,
    owner,
    category,
    status: allowedStatuses.has(status) ? status : "draft",
    priority: allowedPriorities.has(priority) ? priority : "medium",
    dueDate,
    summary,
    link
  };
}

function buildStats(documents) {
  const total = documents.length;
  const approved = documents.filter((doc) => doc.status === "approved").length;
  const inReview = documents.filter((doc) => doc.status === "in-review").length;
  const blocked = documents.filter((doc) => doc.status === "blocked").length;
  const overdue = documents.filter((doc) => {
    if (!doc.dueDate || doc.status === "approved") {
      return false;
    }
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    return new Date(`${doc.dueDate}T00:00:00`) < today;
  }).length;

  return { total, approved, inReview, blocked, overdue };
}

async function initDb() {
  fs.mkdirSync(PUBLIC_FILES_DIR, { recursive: true });

  await query(`
    CREATE TABLE IF NOT EXISTS users (
      id text PRIMARY KEY,
      email text NOT NULL UNIQUE,
      full_name text NOT NULL,
      password_hash text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS sessions (
      token text PRIMARY KEY,
      user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at timestamptz NOT NULL DEFAULT now(),
      expires_at timestamptz NOT NULL
    )
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS documents (
      id text PRIMARY KEY,
      title text NOT NULL,
      owner text NOT NULL,
      category text NOT NULL,
      status text NOT NULL,
      priority text NOT NULL,
      due_date date NOT NULL,
      summary text,
      link text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS notes (
      id text PRIMARY KEY,
      body text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `);

  const countResult = await query("SELECT count(*) FROM documents");
  const count = Number(countResult.rows[0]?.count || 0);

  if (count === 0) {
    await query(
      `INSERT INTO documents (
        id, title, owner, category, status, priority, due_date, summary, link, created_at, updated_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11),
        ($12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)`,
      [
        "seed-milestone-2",
        "Milestone 2 Final Project",
        "Project Team",
        "Project Milestone",
        "in-review",
        "high",
        "2026-07-10",
        "Final project milestone package pending review and sign-off.",
        "/files/milestone-2-final-project.pdf",
        new Date().toISOString(),
        new Date().toISOString(),
        "seed-template",
        "System Documentation Template",
        "Documentation Lead",
        "Template",
        "approved",
        "medium",
        "2026-07-03",
        "Template used to standardize system documentation deliverables.",
        "/files/system-documentation-template.pdf",
        new Date().toISOString(),
        new Date().toISOString()
      ]
    );

    await query(
      `INSERT INTO notes (id, body, created_at) VALUES ($1, $2, $3)`,
      [
        "seed-note-review",
        "Confirm every submitted document has an owner, review status, due date, and link.",
        new Date().toISOString()
      ]
    );
  }

  const userCount = await query("SELECT count(*) FROM users");
  const userTotal = Number(userCount.rows[0]?.count || 0);

  if (userTotal === 0) {
    await createUser("demo@example.com", "Demo User", "Password123!");
  }
}

async function getDocuments() {
  const result = await query("SELECT * FROM documents ORDER BY created_at DESC");
  return result.rows.map(mapDocument);
}

async function getNotes() {
  const result = await query("SELECT * FROM notes ORDER BY created_at DESC");
  return result.rows.map(mapNote);
}

async function getDocumentById(id) {
  const result = await query("SELECT * FROM documents WHERE id = $1", [id]);
  return result.rowCount === 0 ? null : mapDocument(result.rows[0]);
}

async function createDocument(normalized) {
  const now = new Date().toISOString();
  const id = crypto.randomUUID();
  await query(
    `INSERT INTO documents (
      id, title, owner, category, status, priority, due_date, summary, link, created_at, updated_at
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [
      id,
      normalized.title,
      normalized.owner,
      normalized.category,
      normalized.status,
      normalized.priority,
      normalized.dueDate,
      normalized.summary,
      normalized.link,
      now,
      now
    ]
  );

  return {
    id,
    ...normalized,
    createdAt: now,
    updatedAt: now
  };
}

async function updateDocument(id, normalized) {
  const result = await query(
    `UPDATE documents SET
      title = $1,
      owner = $2,
      category = $3,
      status = $4,
      priority = $5,
      due_date = $6,
      summary = $7,
      link = $8,
      updated_at = now()
    WHERE id = $9
    RETURNING *`,
    [
      normalized.title,
      normalized.owner,
      normalized.category,
      normalized.status,
      normalized.priority,
      normalized.dueDate,
      normalized.summary,
      normalized.link,
      id
    ]
  );

  return result.rowCount === 0 ? null : mapDocument(result.rows[0]);
}

async function deleteDocument(id) {
  const result = await query("DELETE FROM documents WHERE id = $1", [id]);
  return result.rowCount > 0;
}

async function createNote(body) {
  const now = new Date().toISOString();
  const id = crypto.randomUUID();
  await query("INSERT INTO notes (id, body, created_at) VALUES ($1, $2, $3)", [id, body, now]);
  return { id, body, createdAt: now };
}

async function deleteNote(id) {
  const result = await query("DELETE FROM notes WHERE id = $1", [id]);
  return result.rowCount > 0;
}

async function handleApi(req, res, pathname) {
  const matchDocument = pathname.match(/^\/api\/documents\/([^/]+)$/);
  const matchNote = pathname.match(/^\/api\/notes\/([^/]+)$/);

  setCorsHeaders(res, req);

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.method === "GET" && pathname === "/api/health") {
    sendJson(res, 200, { ok: true, app: "system-documentation-tracker" });
    return;
  }

  if (req.method === "GET" && pathname === "/api/me") {
    const user = await authenticateRequest(req);
    sendJson(res, 200, { user });
    return;
  }

  if (req.method === "POST" && pathname === "/api/register") {
    const body = await readRequestBody(req);
    const email = String(body.email || "").trim().toLowerCase();
    const fullName = String(body.fullName || "").trim();
    const password = String(body.password || "");

    if (!email || !fullName || !password) {
      sendError(res, 400, "Email, full name, and password are required");
      return;
    }

    if (await getUserByEmail(email)) {
      sendError(res, 409, "Email is already registered");
      return;
    }

    const user = await createUser(email, fullName, password);
    const token = await createSession(user.id);
    sendSessionCookie(res, token);
    sendJson(res, 201, { user: sanitizeUser({ id: user.id, email: user.email, full_name: user.fullName, created_at: new Date() }) });
    return;
  }

  if (req.method === "POST" && pathname === "/api/login") {
    const body = await readRequestBody(req);
    const email = String(body.email || "").trim().toLowerCase();
    const password = String(body.password || "");

    if (!email || !password) {
      sendError(res, 400, "Email and password are required");
      return;
    }

    const user = await getUserByEmail(email);
    if (!user || !verifyPassword(password, user.password_hash)) {
      sendError(res, 401, "Invalid email or password");
      return;
    }

    const token = await createSession(user.id);
    sendSessionCookie(res, token);
    sendJson(res, 200, { user: sanitizeUser(user) });
    return;
  }

  if (req.method === "POST" && pathname === "/api/logout") {
    const cookies = parseCookies(req.headers.cookie || "");
    if (cookies.session_token) {
      await deleteSession(cookies.session_token);
    }
    clearSessionCookie(res);
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method === "GET" && pathname === "/api/dashboard") {
    const user = await requireAuth(res, req);
    if (!user) {
      return;
    }

    const [documents, notes] = await Promise.all([getDocuments(), getNotes()]);
    sendJson(res, 200, {
      stats: buildStats(documents),
      documents,
      notes
    });
    return;
  }

  if (req.method === "GET" && pathname === "/api/documents") {
    const user = await requireAuth(res, req);
    if (!user) {
      return;
    }
    sendJson(res, 200, await getDocuments());
    return;
  }

  if (req.method === "POST" && pathname === "/api/documents") {
    const user = await requireAuth(res, req);
    if (!user) {
      return;
    }
    const body = await readRequestBody(req);
    const normalized = normalizeDocument(body);

    if (normalized.error) {
      sendError(res, 400, normalized.error);
      return;
    }

    const document = await createDocument(normalized);
    sendJson(res, 201, document);
    return;
  }

  if (req.method === "PUT" && matchDocument) {
    const user = await requireAuth(res, req);
    if (!user) {
      return;
    }
    const id = matchDocument[1];
    const body = await readRequestBody(req);
    const normalized = normalizeDocument(body);

    if (normalized.error) {
      sendError(res, 400, normalized.error);
      return;
    }

    const document = await updateDocument(id, normalized);
    if (!document) {
      sendError(res, 404, "Document not found");
      return;
    }

    sendJson(res, 200, document);
    return;
  }

  if (req.method === "DELETE" && matchDocument) {
    const user = await requireAuth(res, req);
    if (!user) {
      return;
    }
    const id = matchDocument[1];
    const deleted = await deleteDocument(id);

    if (!deleted) {
      sendError(res, 404, "Document not found");
      return;
    }

    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method === "POST" && pathname === "/api/notes") {
    const user = await requireAuth(res, req);
    if (!user) {
      return;
    }
    const body = await readRequestBody(req);
    const noteBody = String(body.body || "").trim();

    if (!noteBody) {
      sendError(res, 400, "Note body is required");
      return;
    }

    const note = await createNote(noteBody);
    sendJson(res, 201, note);
    return;
  }

  if (req.method === "DELETE" && matchNote) {
    const user = await requireAuth(res, req);
    if (!user) {
      return;
    }
    const id = matchNote[1];
    const deleted = await deleteNote(id);

    if (!deleted) {
      sendError(res, 404, "Note not found");
      return;
    }

    sendJson(res, 200, { ok: true });
    return;
  }

  sendError(res, 404, "API route not found");
}

function serveStatic(req, res, pathname) {
  const requestedPath = pathname === "/" ? "/index.html" : pathname;
  const filePath = path.normalize(path.join(PUBLIC_DIR, requestedPath));

  if (!filePath.startsWith(PUBLIC_DIR)) {
    sendError(res, 403, "Forbidden");
    return;
  }

  fs.readFile(filePath, (error, content) => {
    if (error) {
      fs.readFile(path.join(PUBLIC_DIR, "index.html"), (fallbackError, fallback) => {
        if (fallbackError) {
          sendError(res, 404, "Page not found");
          return;
        }
        res.writeHead(200, { "Content-Type": MIME_TYPES[".html"] });
        res.end(fallback);
      });
      return;
    }

    const extension = path.extname(filePath).toLowerCase();
    res.writeHead(200, { "Content-Type": MIME_TYPES[extension] || "application/octet-stream" });
    res.end(content);
  });
}

function serveWorkspaceFile(req, res, pathname) {
  const fileName = path.basename(decodeURIComponent(pathname.replace(/^\/files\//, "")));
  const filePath = path.join(PUBLIC_FILES_DIR, fileName);
  const extension = path.extname(filePath).toLowerCase();

  if (extension !== ".pdf") {
    sendError(res, 403, "Only PDF references are available");
    return;
  }

  fs.readFile(filePath, (error, content) => {
    if (error) {
      sendError(res, 404, "File not found");
      return;  
    }

    res.writeHead(200, {
      "Content-Type": MIME_TYPES[extension],
      "Content-Disposition": `inline; filename="${fileName.replaceAll('"', "")}"`
    });
    res.end(content);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const pathname = decodeURIComponent(url.pathname);

    if (pathname.startsWith("/api/")) {
      if (req.method === "OPTIONS") {
        setCorsHeaders(res, req);
        res.writeHead(204);
        res.end();
        return;
      }

      await handleApi(req, res, pathname);
      return;
    }

    if (pathname.startsWith("/files/")) {
      serveWorkspaceFile(req, res, pathname);
      return;
    }

    serveStatic(req, res, pathname);
  } catch (error) {
    sendError(res, 500, error.message || "Internal server error");
  }
});

async function startServer() {
  await initDb();
  server.listen(PORT, () => {
    console.log(`System Documentation Tracker running at http://localhost:${PORT}`);
  });
}

if (require.main === module) {
  startServer().catch((error) => {
    console.error("Failed to initialize database:", error);
    process.exit(1);
  });
}

module.exports = { initDb };
