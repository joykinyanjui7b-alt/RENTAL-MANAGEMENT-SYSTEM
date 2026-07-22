require("dotenv").config();
const fs = require("fs");
const http = require("http");
const crypto = require("crypto");
const path = require("path");
const { URL } = require("url");
const { Pool } = require("pg");

const PORT = process.env.PORT || 3000;
const DATABASE_URL = (process.env.DATABASE_URL || process.env.SUPABASE_URL || process.env.SUPABASE_DATABASE_URL || "").trim();
const usePostgres = Boolean(DATABASE_URL);
const localDbFile = path.join(__dirname, "dev-db.json");

let pool;
let localDb;

// ---------------------------------------------------------------------------
// Static file serving — serves the frontend (HTML/CSS/JS) from the same
// server and port as the API, so the browser treats everything as one
// origin. This avoids cross-origin cookie issues that break login when the
// frontend and backend run on two different ports/servers.
// ---------------------------------------------------------------------------

const publicDir = path.join(__dirname, "..", "frontend", "public");

const mimeTypes = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml"
};

function serveStaticFile(req, res, pathname) {
  let filePath = pathname === "/" ? "/index.html" : pathname;
  filePath = path.join(publicDir, filePath);

  if (!filePath.startsWith(publicDir)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  fs.readFile(filePath, (err, content) => {
    if (err) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not found");
      return;
    }
    const ext = path.extname(filePath);
    res.writeHead(200, { "Content-Type": mimeTypes[ext] || "application/octet-stream" });
    res.end(content);
  });
}

if (usePostgres) {
  pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : undefined
  });
}

function loadLocalDb() {
  if (localDb) {
    return localDb;
  }

  if (fs.existsSync(localDbFile)) {
    try {
      localDb = JSON.parse(fs.readFileSync(localDbFile, "utf8"));
    } catch (error) {
      localDb = null;
    }
  }

  if (!localDb || typeof localDb !== "object") {
    localDb = { users: [], sessions: [], houses: [], tenants: [], applications: [], payments: [] };
  }

  for (const key of ["users", "sessions", "houses", "tenants", "applications", "payments"]) {
    if (!Array.isArray(localDb[key])) {
      localDb[key] = [];
    }
  }

  for (const tenant of localDb.tenants) {
    tenant.status = tenant.status || "active";
    tenant.move_out_date = tenant.move_out_date || null;
  }

  return localDb;
}

function saveLocalDb() {
  fs.writeFileSync(localDbFile, JSON.stringify(loadLocalDb(), null, 2) + "\n", "utf8");
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
  if (!storedHash) return false;
  const [salt, hashed] = storedHash.split(":");
  if (!salt || !hashed) return false;
  const attempt = crypto.pbkdf2Sync(password, salt, 310000, 32, "sha256").toString("hex");
  return crypto.timingSafeEqual(Buffer.from(hashed, "hex"), Buffer.from(attempt, "hex"));
}

function sanitizeUser(user) {
  return {
    id: user.id,
    email: user.email,
    fullName: user.full_name || user.fullName,
    role: user.role || "landlord",
    createdAt: user.created_at || user.createdAt
  };
}

async function initDb() {
  if (usePostgres) {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id text PRIMARY KEY, email text NOT NULL UNIQUE, full_name text NOT NULL,
        role text NOT NULL DEFAULT 'landlord', password_hash text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS sessions (
        token text PRIMARY KEY, user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL
      );
      CREATE TABLE IF NOT EXISTS houses (
        id text PRIMARY KEY, house_number text NOT NULL, rent_amount numeric NOT NULL,
        room_type text, location text, description text, price numeric,
        status text NOT NULL DEFAULT 'vacant'
      );
      CREATE TABLE IF NOT EXISTS tenants (
        id text PRIMARY KEY, name text NOT NULL, phone text NOT NULL, email text,
        house_id text REFERENCES houses(id), move_in_date date, move_out_date date,
        status text NOT NULL DEFAULT 'active', created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS applications (
        id text PRIMARY KEY, applicant_name text NOT NULL, contact text NOT NULL,
        house_id text REFERENCES houses(id), message text, date_applied date NOT NULL,
        status text NOT NULL DEFAULT 'pending'
      );
      CREATE TABLE IF NOT EXISTS payments (
        id text PRIMARY KEY, tenant_id text REFERENCES tenants(id), amount numeric NOT NULL,
        payment_date date NOT NULL, balance numeric NOT NULL DEFAULT 0
      );
      ALTER TABLE tenants ADD COLUMN IF NOT EXISTS move_out_date date;
      ALTER TABLE tenants ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'active';
      ALTER TABLE applications ADD COLUMN IF NOT EXISTS message text;
      ALTER TABLE houses ADD COLUMN IF NOT EXISTS room_type text;
      ALTER TABLE houses ADD COLUMN IF NOT EXISTS location text;
      ALTER TABLE houses ADD COLUMN IF NOT EXISTS description text;
      ALTER TABLE houses ADD COLUMN IF NOT EXISTS price numeric;
    `);
  }

  const db = usePostgres ? null : loadLocalDb();

  if (!usePostgres && db.houses.some((house) => house.houseNumber === "C-305")) {
    db.houses = db.houses.filter((house) => house.houseNumber !== "C-305");
    saveLocalDb();
  }

  await ensureSeedUsers();

  const houseCount = usePostgres
    ? Number((await pool.query("SELECT count(*) FROM houses")).rows[0].count)
    : db.houses.length;

  if (houseCount === 0) {
    const seedHouses = [
      { id: crypto.randomUUID(), houseNumber: "One bedroom", rentAmount: 12000, roomType: "One bedroom", location: "Along Thika Road", description: "Bright one-bedroom unit with a private bathroom and cooking area." },
      { id: crypto.randomUUID(), houseNumber: "Bedsitter", rentAmount: 10000, roomType: "Bedsitter", location: "Westlands", description: "Comfortable bedsitter with fitted kitchen and Wi-Fi ready." }
    ];

    if (usePostgres) {
      for (const h of seedHouses) {
        await pool.query(
          "INSERT INTO houses (id, house_number, rent_amount, room_type, location, description, price, status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)",
          [h.id, h.houseNumber, h.rentAmount, h.roomType || h.houseNumber, h.location || "", h.description || "", h.rentAmount, "vacant"]
        );
      }
    } else {
      db.houses.push(...seedHouses.map((h) => ({ ...h, status: "vacant" })));
      saveLocalDb();
    }
  }
}

async function getUserByEmail(email) {
  if (usePostgres) {
    const result = await pool.query("SELECT * FROM users WHERE email = $1", [email]);
    return result.rowCount === 0 ? null : result.rows[0];
  }
  const db = loadLocalDb();
  return db.users.find((u) => u.email === email) || null;
}

async function getUsers() {
  if (usePostgres) {
    const result = await pool.query("SELECT id, email, full_name, role, created_at FROM users ORDER BY created_at DESC");
    return result.rows.map((user) => sanitizeUser(user));
  }
  return loadLocalDb().users.map((user) => sanitizeUser(user));
}

async function createUser(email, fullName, role, password) {
  const id = crypto.randomUUID();
  const passwordHash = hashPassword(password);
  const createdAt = new Date().toISOString();

  if (usePostgres) {
    await pool.query(
      "INSERT INTO users (id, email, full_name, role, password_hash, created_at) VALUES ($1,$2,$3,$4,$5,now())",
      [id, email, fullName, role, passwordHash]
    );
  } else {
    const db = loadLocalDb();
    db.users.push({ id, email, full_name: fullName, role, password_hash: passwordHash, created_at: createdAt });
    saveLocalDb();
  }

  return { id, email, full_name: fullName, role, created_at: createdAt };
}

async function ensureSeedUsers() {
  const presentationUsers = [
    ["admin@rms.com", "RMS Administrator", "admin"],
    ["landlord@rms.com", "RMS Landlord", "landlord"],
    ["landlord2@rms.com", "Second RMS Landlord", "landlord"],
    ["tenant1@rms.com", "Tenant One", "tenant"],
    ["tenant2@rms.com", "Tenant Two", "tenant"],
    ["tenant3@rms.com", "Tenant Three", "tenant"],
    ["tenant4@rms.com", "Tenant Four", "tenant"],
    ["tenant5@rms.com", "Tenant Five", "tenant"]
  ];

  for (const [email, fullName, role] of presentationUsers) {
    const existing = await getUserByEmail(email);
    if (existing) {
      continue;
    }
    await createUser(email, fullName, role, "RmsDemo2026!");
  }
}

async function createSession(userId) {
  const token = crypto.randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

  if (usePostgres) {
    await pool.query("INSERT INTO sessions (token, user_id, expires_at, created_at) VALUES ($1,$2,$3,now())", [
      token, userId, expiresAt
    ]);
  } else {
    const db = loadLocalDb();
    db.sessions.push({ token, user_id: userId, expires_at: expiresAt, created_at: new Date().toISOString() });
    saveLocalDb();
  }

  return token;
}

async function getSession(token) {
  if (usePostgres) {
    const result = await pool.query(
      `SELECT s.token, s.expires_at, u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = $1`,
      [token]
    );
    return result.rowCount === 0 ? null : result.rows[0];
  }
  const db = loadLocalDb();
  const session = db.sessions.find((s) => s.token === token);
  if (!session) return null;
  const user = db.users.find((u) => u.id === session.user_id);
  if (!user) return null;
  return { ...user, expires_at: session.expires_at };
}

async function deleteSession(token) {
  if (usePostgres) {
    await pool.query("DELETE FROM sessions WHERE token = $1", [token]);
    return;
  }
  const db = loadLocalDb();
  db.sessions = db.sessions.filter((s) => s.token !== token);
  saveLocalDb();
}

async function authenticateRequest(req) {
  const cookies = parseCookies(req.headers.cookie || "");
  const token = cookies.session_token;
  if (!token) return null;

  const session = await getSession(token);
  if (!session) return null;

  if (new Date(session.expires_at) < new Date()) {
    await deleteSession(token);
    return null;
  }

  return sanitizeUser(session);
}

async function requireAuth(res, req) {
  const user = await authenticateRequest(req);
  if (!user) {
    sendError(res, 401, "Authentication required", req);
    return null;
  }
  return user;
}

async function requireRole(res, req, roles) {
  const user = await requireAuth(res, req);
  if (!user) return null;
  if (!roles.includes(user.role)) {
    sendError(res, 403, "You do not have permission to perform this action", req);
    return null;
  }
  return user;
}

async function getHouses() {
  if (usePostgres) {
    const result = await pool.query("SELECT * FROM houses ORDER BY house_number");
    return result.rows.map((h) => ({
      id: h.id,
      houseNumber: h.house_number,
      roomType: h.room_type || h.house_number,
      location: h.location || "",
      description: h.description || "",
      rentAmount: Number(h.rent_amount ?? h.price ?? 0),
      price: Number(h.price ?? h.rent_amount ?? 0),
      status: h.status
    }));
  }
  const db = loadLocalDb();
  return db.houses.map((h) => ({
    id: h.id,
    houseNumber: h.houseNumber,
    roomType: h.roomType || h.houseNumber,
    location: h.location || "",
    description: h.description || "",
    rentAmount: Number(h.rentAmount ?? h.price ?? 0),
    price: Number(h.price ?? h.rentAmount ?? 0),
    status: h.status
  }));
}

async function setHouseStatus(houseId, status) {
  if (usePostgres) {
    await pool.query("UPDATE houses SET status = $1 WHERE id = $2", [status, houseId]);
    return;
  }
  const db = loadLocalDb();
  const house = db.houses.find((h) => h.id === houseId);
  if (house) {
    house.status = status;
    saveLocalDb();
  }
}

async function createHouse({ houseNumber, rentAmount, roomType, location, description, price }) {
  const id = crypto.randomUUID();
  const numericPrice = Number(price ?? rentAmount);
  const numericRent = Number(rentAmount ?? numericPrice);
  const roomTitle = String(roomType || houseNumber || "").trim();
  const house = {
    id,
    houseNumber: roomTitle || String(houseNumber).trim(),
    roomType: roomTitle || String(houseNumber).trim(),
    location: String(location || "").trim(),
    description: String(description || "").trim(),
    rentAmount: numericRent,
    price: numericPrice,
    status: "vacant"
  };

  if (usePostgres) {
    await pool.query(
      "INSERT INTO houses (id, house_number, rent_amount, room_type, location, description, price, status) VALUES ($1,$2,$3,$4,$5,$6,$7,'vacant')",
      [id, house.houseNumber, house.rentAmount, house.roomType, house.location, house.description, house.price]
    );
  } else {
    const db = loadLocalDb();
    db.houses.push(house);
    saveLocalDb();
  }

  return house;
}

async function getTenants() {
  const houses = await getHouses();
  const houseMap = Object.fromEntries(houses.map((h) => [h.id, h]));

  if (usePostgres) {
    const result = await pool.query("SELECT * FROM tenants ORDER BY created_at DESC");
    return result.rows.map((t) => mapTenant(t, houseMap));
  }
  const db = loadLocalDb();
  return [...db.tenants].sort((a, b) => new Date(b.created_at) - new Date(a.created_at)).map((t) => mapTenant(t, houseMap));
}

function mapTenant(t, houseMap) {
  const house = houseMap[t.house_id || t.houseId] || {};
  return {
    id: t.id,
    name: t.name,
    phone: t.phone,
    email: t.email || "",
    houseId: t.house_id || t.houseId,
    houseNumber: house.houseNumber || "Unassigned",
    rentStatus: t.rent_status || t.rentStatus || "unpaid",
    moveInDate: t.move_in_date || t.moveInDate || null,
    moveOutDate: t.move_out_date || t.moveOutDate || null,
    status: t.status || "active"
  };
}

async function createTenant({ name, phone, email, houseId }) {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const tenant = { id, name, phone, email, house_id: houseId, houseId, move_in_date: now.slice(0, 10), moveInDate: now.slice(0, 10), move_out_date: null, moveOutDate: null, status: "active", rent_status: "unpaid", rentStatus: "unpaid", created_at: now, createdAt: now };

  if (usePostgres) {
    await pool.query(
      "INSERT INTO tenants (id, name, phone, email, house_id, move_in_date, status, created_at) VALUES ($1,$2,$3,$4,$5,$6,'active',now())",
      [id, name, phone, email, houseId, now.slice(0, 10)]
    );
  } else {
    const db = loadLocalDb();
    db.tenants.push(tenant);
    saveLocalDb();
  }

  await setHouseStatus(houseId, "occupied");
  return tenant;
}

async function updateTenant(id, { name, phone, email, houseId }) {
  if (usePostgres) {
    const existing = await pool.query("SELECT house_id FROM tenants WHERE id=$1", [id]);
    if (existing.rowCount === 0) return null;
    const result = await pool.query(
      "UPDATE tenants SET name=$1, phone=$2, email=$3, house_id=$4, status='active', move_out_date=NULL WHERE id=$5 RETURNING *",
      [name, phone, email, houseId, id]
    );
    if (existing.rows[0].house_id && existing.rows[0].house_id !== houseId) {
      await setHouseStatus(existing.rows[0].house_id, "vacant");
    }
  } else {
    const db = loadLocalDb();
    const tenant = db.tenants.find((t) => t.id === id);
    if (!tenant) return null;
    const previousHouseId = tenant.house_id;
    Object.assign(tenant, { name, phone, email, house_id: houseId, houseId });
    tenant.status = "active";
    tenant.move_out_date = null;
    saveLocalDb();
    if (previousHouseId && previousHouseId !== houseId) {
      await setHouseStatus(previousHouseId, "vacant");
    }
  }
  await setHouseStatus(houseId, "occupied");
  return true;
}

async function deleteTenant(id) {
  if (usePostgres) {
    const existing = await pool.query("SELECT house_id, status FROM tenants WHERE id=$1", [id]);
    if (existing.rowCount === 0) return false;
    await pool.query("UPDATE tenants SET status='former', move_out_date=CURRENT_DATE WHERE id=$1", [id]);
    if (existing.rows[0].status !== "former") {
      await setHouseStatus(existing.rows[0].house_id, "vacant");
    }
    return true;
  }
  const db = loadLocalDb();
  const tenant = db.tenants.find((t) => t.id === id);
  if (!tenant) return false;
  const houseId = tenant.house_id;
  const wasActive = tenant.status !== "former";
  tenant.status = "former";
  tenant.move_out_date = new Date().toISOString().slice(0, 10);
  saveLocalDb();
  if (wasActive) {
    await setHouseStatus(houseId, "vacant");
  }
  return true;
}

async function getApplications() {
  const houses = await getHouses();
  const houseMap = Object.fromEntries(houses.map((h) => [h.id, h]));

  if (usePostgres) {
    const result = await pool.query("SELECT * FROM applications ORDER BY date_applied DESC");
    return result.rows.map((a) => mapApplication(a, houseMap));
  }
  const db = loadLocalDb();
  return [...db.applications].sort((a, b) => new Date(b.date_applied) - new Date(a.date_applied)).map((a) => mapApplication(a, houseMap));
}

function mapApplication(a, houseMap) {
  const house = houseMap[a.house_id || a.houseId] || {};
  return {
    id: a.id,
    applicantName: a.applicant_name || a.applicantName,
    contact: a.contact,
    message: a.message || "",
    houseId: a.house_id || a.houseId,
    houseNumber: house.houseNumber || "Unknown",
    dateApplied: a.date_applied || a.dateApplied,
    status: a.status
  };
}

async function createApplication({ applicantName, contact, houseId, message, dateApplied }) {
  const id = crypto.randomUUID();
  const record = { id, applicant_name: applicantName, applicantName, contact, message: message || "", house_id: houseId, houseId, date_applied: dateApplied, dateApplied, status: "pending" };

  if (usePostgres) {
    await pool.query(
      "INSERT INTO applications (id, applicant_name, contact, house_id, message, date_applied, status) VALUES ($1,$2,$3,$4,$5,$6,'pending')",
      [id, applicantName, contact, houseId, message || "", dateApplied]
    );
  } else {
    const db = loadLocalDb();
    db.applications.push(record);
    saveLocalDb();
  }

  return record;
}

async function getApplicationById(id) {
  if (usePostgres) {
    const result = await pool.query("SELECT * FROM applications WHERE id=$1", [id]);
    return result.rowCount === 0 ? null : result.rows[0];
  }
  const db = loadLocalDb();
  return db.applications.find((a) => a.id === id) || null;
}

async function setApplicationStatus(id, status) {
  if (usePostgres) {
    await pool.query("UPDATE applications SET status=$1 WHERE id=$2", [status, id]);
    return;
  }
  const db = loadLocalDb();
  const app = db.applications.find((a) => a.id === id);
  if (app) {
    app.status = status;
    saveLocalDb();
  }
}

async function approveApplication(id) {
  const application = await getApplicationById(id);
  if (!application) return null;

  const houseId = application.house_id || application.houseId;
  const tenant = await createTenant({
    name: application.applicant_name || application.applicantName,
    phone: application.contact,
    email: "",
    houseId
  });

  await setApplicationStatus(id, "approved");
  return tenant;
}

async function rejectApplication(id) {
  const application = await getApplicationById(id);
  if (!application) return false;
  await setApplicationStatus(id, "rejected");
  return true;
}

async function getPayments() {
  const tenants = await getTenants();
  const tenantMap = Object.fromEntries(tenants.map((t) => [t.id, t]));

  if (usePostgres) {
    const result = await pool.query("SELECT * FROM payments ORDER BY payment_date DESC");
    return result.rows.map((p) => mapPayment(p, tenantMap));
  }
  const db = loadLocalDb();
  return [...db.payments].sort((a, b) => new Date(b.payment_date) - new Date(a.payment_date)).map((p) => mapPayment(p, tenantMap));
}

function mapPayment(p, tenantMap) {
  const tenant = tenantMap[p.tenant_id || p.tenantId] || {};
  return {
    id: p.id,
    tenantId: p.tenant_id || p.tenantId,
    tenantName: tenant.name || "Unknown tenant",
    houseNumber: tenant.houseNumber || "",
    amount: Number(p.amount),
    paymentDate: p.payment_date || p.paymentDate,
    balance: Number(p.balance)
  };
}

async function createPayment({ tenantId, amount, paymentDate }) {
  const tenants = await getTenants();
  const tenant = tenants.find((t) => t.id === tenantId);
  const houses = await getHouses();
  const house = houses.find((h) => h.id === (tenant && tenant.houseId));
  const rentAmount = house ? house.rentAmount : 0;
  const balance = Math.max(rentAmount - Number(amount), 0);

  const id = crypto.randomUUID();
  const record = { id, tenant_id: tenantId, tenantId, amount: Number(amount), payment_date: paymentDate, paymentDate, balance };

  if (usePostgres) {
    await pool.query(
      "INSERT INTO payments (id, tenant_id, amount, payment_date, balance) VALUES ($1,$2,$3,$4,$5)",
      [id, tenantId, amount, paymentDate, balance]
    );
  } else {
    const db = loadLocalDb();
    db.payments.push(record);
    saveLocalDb();
  }

  if (!usePostgres) {
    const db = loadLocalDb();
    const t = db.tenants.find((item) => item.id === tenantId);
    if (t) {
      t.rent_status = balance === 0 ? "paid" : "unpaid";
      t.rentStatus = t.rent_status;
      saveLocalDb();
    }
  }

  return record;
}

function isProductionEnvironment() {
  return process.env.NODE_ENV === "production" || Boolean(process.env.RENDER) || Boolean(process.env.RENDER_SERVICE_NAME) || Boolean(process.env.VERCEL);
}

function getAllowedOrigin(req) {
  const requestOrigin = req && req.headers ? req.headers.origin : "";
  const configuredOrigins = (process.env.ALLOWED_ORIGINS || process.env.FRONTEND_URL || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);

  if (requestOrigin && (configuredOrigins.includes(requestOrigin) || requestOrigin.includes("vercel.app") || requestOrigin.includes("localhost") || requestOrigin.includes("127.0.0.1"))) {
    return requestOrigin;
  }

  return configuredOrigins[0] || requestOrigin || "*";
}

function setCorsHeaders(res, req) {
  const origin = getAllowedOrigin(req);
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS");
  res.setHeader("Access-Control-Allow-Credentials", "true");
}

function sendJson(res, statusCode, payload, req) {
  setCorsHeaders(res, req);
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body)
  });
  res.end(body);
}

function sendError(res, statusCode, message, req) {
  sendJson(res, statusCode, { error: message }, req);
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
      if (!body) return resolve({});
      try {
        resolve(JSON.parse(body));
      } catch (error) {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

function sendSessionCookie(res, token) {
  const isProduction = isProductionEnvironment();
  const sameSite = isProduction ? "None" : "Lax";
  const secure = isProduction ? "; Secure" : "";
  const maxAge = 7 * 24 * 60 * 60;
  res.setHeader("Set-Cookie", `session_token=${token}; HttpOnly; SameSite=${sameSite}; Path=/; Max-Age=${maxAge}${secure}`);
}

function clearSessionCookie(res) {
  const isProduction = isProductionEnvironment();
  const sameSite = isProduction ? "None" : "Lax";
  const secure = isProduction ? "; Secure" : "";
  res.setHeader("Set-Cookie", `session_token=; HttpOnly; SameSite=${sameSite}; Path=/; Max-Age=0${secure}`);
}

async function handleApi(req, res, pathname) {
  setCorsHeaders(res, req);

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  const matchTenant = pathname.match(/^\/api\/tenants\/([^/]+)$/);
  const matchApprove = pathname.match(/^\/api\/applications\/([^/]+)\/approve$/);
  const matchReject = pathname.match(/^\/api\/applications\/([^/]+)\/reject$/);

  if (req.method === "GET" && pathname === "/api/health") {
    sendJson(res, 200, { ok: true, app: "rental-management-system" }, req);
    return;
  }

  if (req.method === "GET" && pathname === "/api/me") {
    const user = await authenticateRequest(req);
    sendJson(res, 200, { user }, req);
    return;
  }

  if (req.method === "POST" && pathname === "/api/register") {
    const body = await readRequestBody(req);
    const email = String(body.email || "").trim().toLowerCase();
    const fullName = String(body.fullName || "").trim();
    const requestedRole = String(body.role || "landlord").trim();
    const password = String(body.password || "");

    if (!email || !fullName || !password) {
      sendError(res, 400, "Email, full name, and password are required", req);
      return;
    }
    if (await getUserByEmail(email)) {
      sendError(res, 409, "Email is already registered", req);
      return;
    }

    const role = requestedRole === "tenant" ? "tenant" : "landlord";
    const user = await createUser(email, fullName, role, password);
    const token = await createSession(user.id);
    sendSessionCookie(res, token);
    sendJson(res, 201, { user: sanitizeUser(user) }, req);
    return;
  }

  if (req.method === "POST" && pathname === "/api/login") {
    const body = await readRequestBody(req);
    const email = String(body.email || "").trim().toLowerCase();
    const password = String(body.password || "");

    if (!email || !password) {
      sendError(res, 400, "Email and password are required", req);
      return;
    }

    const user = await getUserByEmail(email);
    if (!user || !verifyPassword(password, user.password_hash)) {
      sendError(res, 401, "Invalid email or password", req);
      return;
    }

    const token = await createSession(user.id);
    sendSessionCookie(res, token);
    sendJson(res, 200, { user: sanitizeUser(user) }, req);
    return;
  }

  if (req.method === "POST" && pathname === "/api/logout") {
    const cookies = parseCookies(req.headers.cookie || "");
    if (cookies.session_token) {
      await deleteSession(cookies.session_token);
    }
    clearSessionCookie(res);
    sendJson(res, 200, { ok: true }, req);
    return;
  }

  if (req.method === "POST" && pathname === "/api/houses") {
    const user = await requireRole(res, req, ["admin", "landlord"]);
    if (!user) return;
    const body = await readRequestBody(req);
    const roomType = String(body.roomType || body.houseNumber || body.room_type || "").trim();
    const location = String(body.location || "").trim();
    const description = String(body.description || "").trim();
    const price = Number(body.price ?? body.rentAmount ?? body.rent_amount);

    if (!roomType || Number.isNaN(price) || price <= 0) {
      sendError(res, 400, "Room type and price are required", req);
      return;
    }

    const existing = (await getHouses()).find((house) => (house.roomType || house.houseNumber).toLowerCase() === roomType.toLowerCase() && (house.location || "").toLowerCase() === location.toLowerCase());
    if (existing) {
      sendError(res, 409, "A house with this number already exists", req);
      return;
    }

    const house = await createHouse({ houseNumber: roomType, rentAmount: price, roomType, location, description, price });
    sendJson(res, 201, { house }, req);
    return;
  }

  if (req.method === "GET" && pathname === "/api/houses") {
    const user = await requireAuth(res, req);
    if (!user) return;
    sendJson(res, 200, { houses: await getHouses() }, req);
    return;
  }

  if (req.method === "GET" && pathname === "/api/dashboard") {
    const user = await requireAuth(res, req);
    if (!user) return;

    if (user.role === "tenant") {
      const applications = await getApplications();
      const myApplications = applications.filter((application) => String(application.contact).toLowerCase() === user.email.toLowerCase());
      sendJson(res, 200, {
        role: user.role,
        stats: {
          availableHouses: (await getHouses()).filter((house) => house.status === "vacant").length,
          myApplications: myApplications.length,
          approvedApplications: myApplications.filter((application) => application.status === "approved").length
        },
        recentApplications: myApplications.slice(0, 5)
      }, req);
      return;
    }

    const [tenants, applications, payments, houses] = await Promise.all([
      getTenants(), getApplications(), getPayments(), getHouses()
    ]);

    const stats = {
      totalTenants: tenants.filter((tenant) => tenant.status === "active").length,
      occupiedHouses: houses.filter((h) => h.status === "occupied").length,
      pendingApplications: applications.filter((a) => a.status === "pending").length,
      rentCollected: payments.reduce((sum, p) => sum + p.amount, 0),
      unpaidRent: tenants.filter((t) => t.rentStatus !== "paid").reduce((sum, t) => {
        const house = houses.find((h) => h.id === t.houseId);
        return sum + (house ? house.rentAmount : 0);
      }, 0)
    };

    sendJson(res, 200, { stats, recentApplications: applications.slice(0, 5) }, req);
    return;
  }

  if (req.method === "GET" && pathname === "/api/tenants") {
    const user = await requireRole(res, req, ["admin", "landlord"]);
    if (!user) return;
    sendJson(res, 200, { tenants: await getTenants() }, req);
    return;
  }

  if (req.method === "GET" && pathname === "/api/users") {
    const user = await requireRole(res, req, ["admin"]);
    if (!user) return;
    sendJson(res, 200, { users: await getUsers() }, req);
    return;
  }

  if (req.method === "POST" && pathname === "/api/tenants") {
    const user = await requireRole(res, req, ["admin", "landlord"]);
    if (!user) return;
    const body = await readRequestBody(req);
    if (!body.name || !body.phone || !body.houseId) {
      sendError(res, 400, "Name, phone, and house are required", req);
      return;
    }
    const assignedTenant = (await getTenants()).find((tenant) => tenant.houseId === body.houseId && tenant.status === "active");
    if (assignedTenant) {
      sendError(res, 409, "This house already has an active tenant", req);
      return;
    }
    const tenant = await createTenant(body);
    sendJson(res, 201, tenant, req);
    return;
  }

  if (req.method === "PUT" && matchTenant) {
    const user = await requireRole(res, req, ["admin", "landlord"]);
    if (!user) return;
    const body = await readRequestBody(req);
    const assignedTenant = (await getTenants()).find((tenant) => tenant.houseId === body.houseId && tenant.status === "active" && String(tenant.id) !== matchTenant[1]);
    if (assignedTenant) {
      sendError(res, 409, "This house already has an active tenant", req);
      return;
    }
    const ok = await updateTenant(matchTenant[1], body);
    if (!ok) {
      sendError(res, 404, "Tenant not found", req);
      return;
    }
    sendJson(res, 200, { ok: true }, req);
    return;
  }

  if (req.method === "DELETE" && matchTenant) {
    const user = await requireRole(res, req, ["admin", "landlord"]);
    if (!user) return;
    const ok = await deleteTenant(matchTenant[1]);
    if (!ok) {
      sendError(res, 404, "Tenant not found", req);
      return;
    }
    sendJson(res, 200, { ok: true }, req);
    return;
  }

  if (req.method === "GET" && pathname === "/api/applications") {
    const user = await requireRole(res, req, ["admin", "landlord"]);
    if (!user) return;
    sendJson(res, 200, { applications: await getApplications() }, req);
    return;
  }

  if (req.method === "POST" && pathname === "/api/applications") {
    const user = await requireAuth(res, req);
    if (!user) return;
    const body = await readRequestBody(req);
    const applicantName = user.role === "tenant" ? user.fullName : body.applicantName;
    const contact = user.role === "tenant" ? user.email : body.contact;
    if (!applicantName || !contact || !body.houseId) {
      sendError(res, 400, "Applicant name, contact, and house are required", req);
      return;
    }
    const house = (await getHouses()).find((item) => item.id === body.houseId);
    if (!house || house.status !== "vacant") {
      sendError(res, 409, "This house is no longer available", req);
      return;
    }
    const duplicate = (await getApplications()).find((application) =>
      application.contact.toLowerCase() === contact.toLowerCase() &&
      application.houseId === body.houseId &&
      application.status === "pending"
    );
    if (duplicate) {
      sendError(res, 409, "You already have a pending application for this house", req);
      return;
    }
    const application = await createApplication({
      applicantName,
      contact,
      houseId: body.houseId,
      message: body.message,
      dateApplied: body.dateApplied || new Date().toISOString().slice(0, 10)
    });
    sendJson(res, 201, application, req);
    return;
  }

  if (req.method === "POST" && matchApprove) {
    const user = await requireRole(res, req, ["admin", "landlord"]);
    if (!user) return;
    const tenant = await approveApplication(matchApprove[1]);
    if (!tenant) {
      sendError(res, 404, "Application not found", req);
      return;
    }
    sendJson(res, 200, { ok: true, tenant }, req);
    return;
  }

  if (req.method === "POST" && matchReject) {
    const user = await requireRole(res, req, ["admin", "landlord"]);
    if (!user) return;
    const ok = await rejectApplication(matchReject[1]);
    if (!ok) {
      sendError(res, 404, "Application not found", req);
      return;
    }
    sendJson(res, 200, { ok: true }, req);
    return;
  }

  if (req.method === "GET" && pathname === "/api/payments") {
    const user = await requireRole(res, req, ["admin", "landlord"]);
    if (!user) return;
    sendJson(res, 200, { payments: await getPayments() }, req);
    return;
  }

  if (req.method === "POST" && pathname === "/api/payments") {
    const user = await requireRole(res, req, ["admin", "landlord"]);
    if (!user) return;
    const body = await readRequestBody(req);
    if (!body.tenantId || !body.amount || !body.paymentDate) {
      sendError(res, 400, "Tenant, amount, and payment date are required", req);
      return;
    }
    const payment = await createPayment(body);
    sendJson(res, 201, payment, req);
    return;
  }

  if (req.method === "GET" && pathname === "/api/reports") {
    const user = await requireRole(res, req, ["admin", "landlord"]);
    if (!user) return;

    const url = new URL(req.url, `http://${req.headers.host}`);
    const type = url.searchParams.get("type") || "rent-collection";
    const from = url.searchParams.get("from") || "";
    const to = url.searchParams.get("to") || "";

    const inRange = (dateStr) => {
      if (!dateStr) return true;
      if (from && dateStr < from) return false;
      if (to && dateStr > to) return false;
      return true;
    };

    let rows = [];

    if (type === "rent-collection") {
      const payments = await getPayments();
      rows = payments
        .filter((p) => inRange(p.paymentDate))
        .map((p) => ({ Tenant: p.tenantName, "Amount paid": p.amount, Date: p.paymentDate, Balance: p.balance }));
    } else if (type === "unpaid-rent") {
      const tenants = await getTenants();
      const houses = await getHouses();
      rows = tenants
        .filter((t) => t.rentStatus !== "paid")
        .map((t) => {
          const house = houses.find((h) => h.id === t.houseId);
          return { Tenant: t.name, House: t.houseNumber, "Balance due": house ? house.rentAmount : 0 };
        });
    } else if (type === "tenant-summary") {
      const tenants = await getTenants();
      rows = tenants.map((t) => ({
        Tenant: t.name, House: t.houseNumber, "Rent status": t.rentStatus, "Move-in date": t.moveInDate
      }));
    }

    sendJson(res, 200, { rows }, req);
    return;
  }

  sendError(res, 404, "API route not found", req);
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const pathname = decodeURIComponent(url.pathname);

    if (pathname.startsWith("/api/")) {
      await handleApi(req, res, pathname);
      return;
    }

    serveStaticFile(req, res, pathname);
  } catch (error) {
    console.error(error);
    sendError(res, 500, error.message || "Internal server error", req);
  }
});

async function startServer() {
  await initDb();
  server.listen(PORT, () => {
    console.log(`Rental Management System backend running at http://localhost:${PORT}`);
  });
}

if (require.main === module) {
  startServer().catch((error) => {
    console.error("Failed to initialize database:", error);
    process.exit(1);
  });
}

module.exports = { initDb };