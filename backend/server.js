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
    tenant.initial_payment_date = tenant.initial_payment_date || tenant.initialPaymentDate || null;
    tenant.water_amount = Number(tenant.water_amount ?? tenant.waterAmount ?? 0);
    tenant.garbage_amount = Number(tenant.garbage_amount ?? tenant.garbageAmount ?? 0);
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
        room_type text, house_name text, location text, description text, price numeric,
        caretaker_name text, caretaker_phone text, status text NOT NULL DEFAULT 'vacant'
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
        payment_date date NOT NULL, balance numeric NOT NULL DEFAULT 0,
        rent_amount numeric NOT NULL DEFAULT 0, water_amount numeric NOT NULL DEFAULT 0,
        garbage_amount numeric NOT NULL DEFAULT 0, total_due numeric NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS water_bills (
        id text PRIMARY KEY, house_id text REFERENCES houses(id), bill_month text NOT NULL,
        bill_year integer NOT NULL, reading_date date NOT NULL, previous_reading numeric NOT NULL,
        current_reading numeric NOT NULL, units_used numeric NOT NULL,
        water_amount numeric NOT NULL DEFAULT 0, notes text, created_at timestamptz NOT NULL DEFAULT now()
      );
      ALTER TABLE tenants ADD COLUMN IF NOT EXISTS move_out_date date;
      ALTER TABLE tenants ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'active';
      ALTER TABLE tenants ADD COLUMN IF NOT EXISTS deposit_amount numeric NOT NULL DEFAULT 0;
      ALTER TABLE tenants ADD COLUMN IF NOT EXISTS rent_paid numeric NOT NULL DEFAULT 0;
      ALTER TABLE tenants ADD COLUMN IF NOT EXISTS water_deposit numeric NOT NULL DEFAULT 0;
      ALTER TABLE tenants ADD COLUMN IF NOT EXISTS rent_status text NOT NULL DEFAULT 'unpaid';
      ALTER TABLE applications ADD COLUMN IF NOT EXISTS message text;
      ALTER TABLE houses ADD COLUMN IF NOT EXISTS room_type text;
      ALTER TABLE houses ADD COLUMN IF NOT EXISTS house_name text;
      ALTER TABLE houses ADD COLUMN IF NOT EXISTS location text;
      ALTER TABLE houses ADD COLUMN IF NOT EXISTS description text;
      ALTER TABLE houses ADD COLUMN IF NOT EXISTS price numeric;
      ALTER TABLE houses ADD COLUMN IF NOT EXISTS caretaker_name text;
      ALTER TABLE houses ADD COLUMN IF NOT EXISTS caretaker_phone text;
      ALTER TABLE houses ADD COLUMN IF NOT EXISTS owner_id text;
      ALTER TABLE payments ADD COLUMN IF NOT EXISTS rent_amount numeric NOT NULL DEFAULT 0;
      ALTER TABLE payments ADD COLUMN IF NOT EXISTS water_amount numeric NOT NULL DEFAULT 0;
      ALTER TABLE payments ADD COLUMN IF NOT EXISTS garbage_amount numeric NOT NULL DEFAULT 0;
      ALTER TABLE payments ADD COLUMN IF NOT EXISTS total_due numeric NOT NULL DEFAULT 0;
      ALTER TABLE payments ADD COLUMN IF NOT EXISTS rent_month text;
      UPDATE payments
      SET rent_month = TO_CHAR(payment_date, 'YYYY-MM')
      WHERE rent_month IS NULL OR rent_month = '';
    `);
  }

  const db = usePostgres ? null : loadLocalDb();

  if (!usePostgres && db.houses.some((house) => house.houseNumber === "C-305")) {
    db.houses = db.houses.filter((house) => house.houseNumber !== "C-305");
    saveLocalDb();
  }

  await ensureSeedUsers();

  if (usePostgres) {
    const landlordResult = await pool.query("SELECT id FROM users WHERE role IN ('landlord','manager') ORDER BY created_at LIMIT 1");
    const landlordId = landlordResult.rowCount > 0 ? landlordResult.rows[0].id : null;
    if (landlordId) {
      await pool.query("UPDATE houses SET owner_id = $1 WHERE owner_id IS NULL", [landlordId]);
    }
  } else {
    const db = loadLocalDb();
    const owner = db.users.find((user) => user.role === "landlord" || user.role === "manager");
    if (owner) {
      let changed = false;
      for (const house of db.houses) {
        if (!house.ownerId && !house.owner_id) {
          house.ownerId = owner.id;
          house.owner_id = owner.id;
          changed = true;
        }
      }
      if (changed) saveLocalDb();
    }
  }

  const houseCount = usePostgres
    ? Number((await pool.query("SELECT count(*) FROM houses")).rows[0].count)
    : db.houses.length;

  if (houseCount === 0) {
    const seedHouses = [
      { id: crypto.randomUUID(), houseNumber: "A1", rentAmount: 12000, roomType: "One bedroom", location: "Along Thika Road", description: "Bright one-bedroom unit with a private bathroom and cooking area." },
      { id: crypto.randomUUID(), houseNumber: "A2", rentAmount: 10000, roomType: "Bedsitter", location: "Westlands", description: "Comfortable bedsitter with fitted kitchen and Wi-Fi ready." }
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
  const passwordMap = {
    "manager@rms.com": "Manager2026!",
    "landlord@rms.com": "Landlord2026!",
    "landlord2@rms.com": "Landlord2026!"
  };

  const presentationUsers = [
    ["manager@rms.com", "Manager Joy", "manager"],
    ["landlord@rms.com", "Mr Raphael Kinyanjui", "landlord"],
    ["landlord2@rms.com", "Second RMS Landlord", "landlord"],
    ["tenant1@rms.com", "Tenant One", "tenant"],
    ["tenant2@rms.com", "Tenant Two", "tenant"],
    ["tenant3@rms.com", "Tenant Three", "tenant"],
    ["tenant4@rms.com", "Tenant Four", "tenant"],
    ["tenant5@rms.com", "Tenant Five", "tenant"]
  ];

  for (const [email, fullName, role] of presentationUsers) {
    const password = passwordMap[email] || "RmsDemo2026!";
    try {
      if (usePostgres) {
        // Use UPSERT so deployed Postgres will always end up with the
        // presentation user and password without requiring manual SQL.
        const updatedHash = hashPassword(password);
        const id = crypto.randomUUID();
        await pool.query(
          `INSERT INTO users (id, email, full_name, role, password_hash, created_at)
           VALUES ($1,$2,$3,$4,$5,now())
           ON CONFLICT (email) DO UPDATE
           SET full_name = EXCLUDED.full_name,
               role = EXCLUDED.role,
               password_hash = EXCLUDED.password_hash`,
          [id, email, fullName, role, updatedHash]
        );
        console.log(`Seed user ensured: ${email} (${role})`);
      } else {
        const existing = await getUserByEmail(email);
        if (!existing) {
          await createUser(email, fullName, role, password);
          console.log(`Seed user created: ${email} (${role})`);
          continue;
        }

        const needsRoleUpdate = existing.role !== role;
        const needsPasswordUpdate = !verifyPassword(password, existing.password_hash);
        if (!needsRoleUpdate && !needsPasswordUpdate) {
          continue;
        }

        const updatedHash = hashPassword(password);
        const db = loadLocalDb();
        const user = db.users.find((u) => u.email === email);
        if (user) {
          user.role = role;
          user.password_hash = updatedHash;
          saveLocalDb();
          console.log(`Seed user updated: ${email} (${role})`);
        }
      }
    } catch (err) {
      console.error(`Failed to seed user ${email}:`, err && err.message ? err.message : err);
      // continue with next user even if one fails
    }
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
  const allowedRoles = roles.includes("landlord") ? [...new Set([...roles, "manager"])] : roles;
  if (!allowedRoles.includes(user.role)) {
    sendError(res, 403, "You do not have permission to perform this action", req);
    return null;
  }
  return user;
}

async function getHouses(user = null) {
  if (usePostgres) {
    const result = await pool.query("SELECT * FROM houses ORDER BY regexp_replace(house_number, '[0-9]+$', ''), NULLIF(regexp_replace(house_number, '^[^0-9]+', ''), '')::integer, house_number");
    const houses = result.rows.map((h) => ({
      id: h.id,
      houseNumber: h.house_number,
      houseName: h.house_name || h.house_number,
      roomType: h.room_type || h.house_number,
      location: h.location || "",
      description: h.description || "",
      rentAmount: Number(h.rent_amount ?? h.price ?? 0),
      price: Number(h.price ?? h.rent_amount ?? 0),
      caretakerName: h.caretaker_name || "",
      caretakerPhone: h.caretaker_phone || "",
      status: h.status,
      ownerId: h.owner_id || null
    }));
    if (user && user.role === "manager") {
      return houses;
    }
    if (user && user.role === "landlord") {
      return houses;
    }
    return houses;
  }
  const db = loadLocalDb();
  const houses = db.houses.map((h) => ({
    id: h.id,
    houseNumber: h.houseNumber,
    houseName: h.houseName || h.houseNumber,
    roomType: h.roomType || h.houseNumber,
    location: h.location || "",
    description: h.description || "",
    rentAmount: Number(h.rentAmount ?? h.price ?? 0),
    price: Number(h.price ?? h.rentAmount ?? 0),
    caretakerName: h.caretakerName || h.caretaker_name || "",
    caretakerPhone: h.caretakerPhone || h.caretaker_phone || "",
    status: h.status,
    ownerId: h.ownerId || h.owner_id || null
  }));
  if (user && user.role === "manager") {
    return houses;
  }
  if (user && user.role === "landlord") {
    return houses;
  }
  return houses;
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

async function createHouse({ houseNumber, houseName, rentAmount, roomType, location, description, price, caretakerName, caretakerPhone, ownerId }) {
  const id = crypto.randomUUID();
  const numericPrice = Number(price ?? rentAmount);
  const numericRent = Number(rentAmount ?? numericPrice);
  const number = String(houseNumber || "").trim();
  const roomTitle = String(roomType || "").trim();
  const house = {
    id,
    houseNumber: number,
    houseName: String(houseName || number).trim(),
    roomType: roomTitle,
    location: String(location || "").trim(),
    description: String(description || "").trim(),
    rentAmount: numericRent,
    price: numericPrice,
    caretakerName: String(caretakerName || "").trim(),
    caretakerPhone: String(caretakerPhone || "").trim(),
    status: "vacant",
    ownerId: ownerId || null
  };

  if (usePostgres) {
    await pool.query(
      "INSERT INTO houses (id, house_number, house_name, rent_amount, room_type, location, description, price, caretaker_name, caretaker_phone, status, owner_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'vacant',$11)",
      [id, house.houseNumber, house.houseName, house.rentAmount, house.roomType, house.location, house.description, house.price, house.caretakerName, house.caretakerPhone, house.ownerId]
    );
  } else {
    const db = loadLocalDb();
    db.houses.push(house);
    saveLocalDb();
  }

  return house;
}

async function updateHouse(id, { houseNumber, houseName, roomType, location, description, price, caretakerName, caretakerPhone }) {
  const number = String(houseNumber || "").trim();
  const type = String(roomType || "").trim();
  const numericPrice = Number(price);
  if (usePostgres) {
    const result = await pool.query(
      "UPDATE houses SET house_number=$1, house_name=$2, room_type=$3, location=$4, description=$5, price=$6, rent_amount=$6, caretaker_name=$7, caretaker_phone=$8 WHERE id=$9 RETURNING *",
      [number, String(houseName || number).trim(), type, location || "", description || "", numericPrice, caretakerName || "", caretakerPhone || "", id]
    );
    return result.rowCount > 0;
  }
  const db = loadLocalDb();
  const house = db.houses.find((item) => item.id === id);
  if (!house) return false;
  Object.assign(house, { houseNumber: number, houseName: String(houseName || number).trim(), roomType: type, location: location || "", description: description || "", price: numericPrice, rentAmount: numericPrice, caretakerName: caretakerName || "", caretakerPhone: caretakerPhone || "" });
  saveLocalDb();
  return true;
}

async function getTenants(user = null) {
  const houses = await getHouses(user);
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
    houseType: house.roomType || null,
    rentStatus: t.rent_status || t.rentStatus || "unpaid",
    moveInDate: t.move_in_date || t.moveInDate || null,
    moveOutDate: t.move_out_date || t.moveOutDate || null,
    depositAmount: Number(t.deposit_amount ?? t.depositAmount ?? 0),
    rentPaid: Number(t.rent_paid ?? t.rentPaid ?? 0),
    waterDeposit: Number(t.water_deposit ?? t.waterDeposit ?? 0),
    status: t.status || "active"
  };
}

async function createTenant({ name, phone, email, houseId, moveInDate, moveOutDate, depositAmount, rentPaid, waterDeposit }) {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const moveIn = moveInDate || now.slice(0, 10);
  const deposit = Number(depositAmount || 0);
  const rent = Number(rentPaid || 0);
  const water = Number(waterDeposit || 0);
  const tenant = { id, name, phone, email: email || "", house_id: houseId, houseId, move_in_date: moveIn, moveInDate: moveIn, move_out_date: moveOutDate || null, moveOutDate: moveOutDate || null, deposit_amount: deposit, depositAmount: deposit, rent_paid: rent, rentPaid: rent, water_deposit: water, waterDeposit: water, status: moveOutDate ? "former" : "active", rent_status: "unpaid", rentStatus: "unpaid", created_at: now, createdAt: now };

  if (usePostgres) {
    await pool.query(
      "INSERT INTO tenants (id, name, phone, email, house_id, move_in_date, move_out_date, deposit_amount, rent_paid, water_deposit, status, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,now())",
      [id, name, phone, email || null, houseId, moveIn, moveOutDate || null, deposit, rent, water, moveOutDate ? "former" : "active"]
    );
  } else {
    const db = loadLocalDb();
    db.tenants.push(tenant);
    saveLocalDb();
  }

  await setHouseStatus(houseId, "occupied");
  return tenant;
}

async function updateTenant(id, { name, phone, email, houseId, moveInDate, moveOutDate, depositAmount, rentPaid, waterDeposit }) {
  if (usePostgres) {
    const existing = await pool.query("SELECT house_id FROM tenants WHERE id=$1", [id]);
    if (existing.rowCount === 0) return null;
    const result = await pool.query(
      "UPDATE tenants SET name=$1, phone=$2, email=$3, house_id=$4, move_in_date=$5, move_out_date=$6, deposit_amount=$7, rent_paid=$8, water_deposit=$9, status=$10 WHERE id=$11 RETURNING *",
      [name, phone, email || null, houseId, moveInDate || new Date().toISOString().slice(0, 10), moveOutDate || null, Number(depositAmount || 0), Number(rentPaid || 0), Number(waterDeposit || 0), moveOutDate ? "former" : "active", id]
    );
    if (existing.rows[0].house_id && existing.rows[0].house_id !== houseId) {
      await setHouseStatus(existing.rows[0].house_id, "vacant");
    }
  } else {
    const db = loadLocalDb();
    const tenant = db.tenants.find((t) => t.id === id);
    if (!tenant) return null;
    const previousHouseId = tenant.house_id;
    Object.assign(tenant, { name, phone, email: email || "", house_id: houseId, houseId });
    tenant.move_in_date = moveInDate || tenant.move_in_date || new Date().toISOString().slice(0, 10);
    tenant.moveInDate = tenant.move_in_date;
    tenant.move_out_date = moveOutDate || null;
    tenant.moveOutDate = tenant.move_out_date;
    tenant.deposit_amount = Number(depositAmount || 0);
    tenant.depositAmount = tenant.deposit_amount;
    tenant.rent_paid = Number(rentPaid || 0);
    tenant.rentPaid = tenant.rent_paid;
    tenant.water_deposit = Number(waterDeposit || 0);
    tenant.waterDeposit = tenant.water_deposit;
    tenant.status = moveOutDate ? "former" : "active";
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

async function getApplications(user = null) {
  const houses = await getHouses(user);
  const houseMap = Object.fromEntries(houses.map((h) => [h.id, h]));
  const allowedHouseIds = new Set(Object.keys(houseMap));

  if (usePostgres) {
    const result = await pool.query("SELECT * FROM applications ORDER BY date_applied DESC");
    return result.rows
      .filter((a) => allowedHouseIds.has(a.house_id))
      .map((a) => mapApplication(a, houseMap));
  }
  const db = loadLocalDb();
  return [...db.applications]
    .sort((a, b) => new Date(b.date_applied) - new Date(a.date_applied))
    .filter((a) => allowedHouseIds.has(a.house_id))
    .map((a) => mapApplication(a, houseMap));
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

async function getPayments(user = null) {
  const tenants = await getTenants(user);
  const tenantMap = Object.fromEntries(tenants.map((t) => [t.id, t]));

  if (usePostgres) {
    const result = await pool.query("SELECT * FROM payments");
    return result.rows
      .map((p) => mapPayment(p, tenantMap))
      .sort(comparePaymentsByHouse);
  }
  const db = loadLocalDb();
  return [...db.payments]
    .map((p) => mapPayment(p, tenantMap))
    .sort(comparePaymentsByHouse);
}

function comparePaymentsByHouse(left, right) {
  const leftHouse = String(left.houseNumber || "").trim();
  const rightHouse = String(right.houseNumber || "").trim();
  const leftMissing = !leftHouse || leftHouse.toLowerCase() === "unknown";
  const rightMissing = !rightHouse || rightHouse.toLowerCase() === "unknown";
  if (leftMissing !== rightMissing) return leftMissing ? 1 : -1;
  if (!leftMissing) {
    const houseOrder = leftHouse.localeCompare(rightHouse, undefined, { numeric: true, sensitivity: "base" });
    if (houseOrder !== 0) return houseOrder;
  }
  return String(left.paymentDate || "").localeCompare(String(right.paymentDate || ""));
}

function mapPayment(p, tenantMap) {
  const tenant = tenantMap[p.tenant_id || p.tenantId] || {};
  return {
    id: p.id,
    tenantId: p.tenant_id || p.tenantId,
    amount: Number(p.amount || 0),
    tenantName: tenant.name || "Unknown tenant",
    houseNumber: tenant.houseNumber || "Unknown",
    houseType: tenant.houseType || "Unknown",
    rentMonth: p.rent_month || p.rentMonth || String(p.payment_date || p.paymentDate || "").slice(0, 7) || null,
    paymentDate: p.payment_date || p.paymentDate || null,
    balance: Number(p.balance || 0),
    rentAmount: Number(p.rent_amount ?? p.rentAmount ?? 0),
    waterAmount: Number(p.water_amount ?? p.waterAmount ?? 0),
    garbageAmount: Number(p.garbage_amount ?? p.garbageAmount ?? 0),
    totalDue: Number(p.total_due ?? p.totalDue ?? 0)
  };
}

async function syncTenantRentStatus(tenantId) {
  const targetTenantId = String(tenantId || "");
  if (!targetTenantId) return;

  const payments = await getPayments();
  const tenantPayments = payments.filter((payment) => String(payment.tenantId) === targetTenantId);
  const outstandingBalance = tenantPayments.reduce((sum, payment) => sum + Number(payment.balance || 0), 0);
  const rentStatus = outstandingBalance > 0 ? "unpaid" : "paid";

  if (usePostgres) {
    await pool.query("UPDATE tenants SET rent_status = $1 WHERE id = $2", [rentStatus, targetTenantId]);
    return;
  }

  const db = loadLocalDb();
  const tenant = db.tenants.find((item) => item.id === targetTenantId);
  if (tenant) {
    tenant.rent_status = rentStatus;
    tenant.rentStatus = rentStatus;
    saveLocalDb();
  }
}

async function createPayment({ tenantId, amount, rentMonth, paymentDate, rentAmount = 0, waterAmount = 0, garbageAmount = 0 }) {
  const tenants = await getTenants();
  const tenant = tenants.find((t) => t.id === tenantId);
  const houses = await getHouses();
  const house = houses.find((h) => h.id === (tenant && tenant.houseId));
  const effectiveRent = Number(rentAmount || (house ? house.rentAmount : 0));
  const effectiveWater = Number(waterAmount || 0);
  const effectiveGarbage = Number(garbageAmount || 0);
  const totalDue = effectiveRent + effectiveWater + effectiveGarbage;
  const paidAmount = Number(amount);
  const balance = Math.max(totalDue - paidAmount, 0);

  const id = crypto.randomUUID();
  const record = {
    id,
    tenant_id: tenantId,
    tenantId,
    amount: paidAmount,
    rent_month: rentMonth,
    rentMonth,
    payment_date: paymentDate,
    paymentDate,
    balance,
    rent_amount: effectiveRent,
    rentAmount: effectiveRent,
    water_amount: effectiveWater,
    waterAmount: effectiveWater,
    garbage_amount: effectiveGarbage,
    garbageAmount: effectiveGarbage,
    total_due: totalDue,
    totalDue
  };

  if (usePostgres) {
    await pool.query(
      "INSERT INTO payments (id, tenant_id, amount, rent_month, payment_date, balance, rent_amount, water_amount, garbage_amount, total_due) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
      [id, tenantId, paidAmount, rentMonth, paymentDate, balance, effectiveRent, effectiveWater, effectiveGarbage, totalDue]
    );
  } else {
    const db = loadLocalDb();
    db.payments.push(record);
    saveLocalDb();
  }

  await syncTenantRentStatus(tenantId);

  return record;
}

async function updatePayment(id, { tenantId, amount, rentMonth, paymentDate, waterAmount = 0, garbageAmount = 0 }) {
  let existing;
  if (usePostgres) {
    const result = await pool.query("SELECT * FROM payments WHERE id=$1", [id]);
    existing = result.rows[0];
  } else {
    existing = loadLocalDb().payments.find((payment) => payment.id === id);
  }
  if (!existing) return null;

  const tenants = await getTenants();
  const tenant = tenants.find((item) => item.id === tenantId);
  if (!tenant) return null;

  const previousTenantId = existing.tenant_id || existing.tenantId;
  let effectiveRent = Number(existing.rent_amount ?? existing.rentAmount ?? 0);
  if (previousTenantId !== tenantId) {
    const house = (await getHouses()).find((item) => item.id === tenant.houseId);
    effectiveRent = Number(house?.rentAmount || 0);
  }
  const effectiveWater = Number(waterAmount || 0);
  const effectiveGarbage = Number(garbageAmount || 0);
  const totalDue = effectiveRent + effectiveWater + effectiveGarbage;
  const paidAmount = Number(amount);
  const balance = Math.max(totalDue - paidAmount, 0);

  if (usePostgres) {
    await pool.query(
      "UPDATE payments SET tenant_id=$2, amount=$3, rent_month=$4, payment_date=$5, balance=$6, rent_amount=$7, water_amount=$8, garbage_amount=$9, total_due=$10 WHERE id=$1",
      [id, tenantId, paidAmount, rentMonth, paymentDate, balance, effectiveRent, effectiveWater, effectiveGarbage, totalDue]
    );
  } else {
    Object.assign(existing, {
      tenant_id: tenantId, tenantId, amount: paidAmount, rent_month: rentMonth, rentMonth,
      payment_date: paymentDate, paymentDate, balance, rent_amount: effectiveRent, rentAmount: effectiveRent,
      water_amount: effectiveWater, waterAmount: effectiveWater, garbage_amount: effectiveGarbage,
      garbageAmount: effectiveGarbage, total_due: totalDue, totalDue
    });
    saveLocalDb();
  }

  await syncTenantRentStatus(tenantId);
  if (previousTenantId && previousTenantId !== tenantId) {
    await syncTenantRentStatus(previousTenantId);
  }

  return { id, tenantId, amount: paidAmount, rentMonth, paymentDate, balance, rentAmount: effectiveRent, waterAmount: effectiveWater, garbageAmount: effectiveGarbage, totalDue };
}

async function deletePayment(id) {
  const existingPayment = usePostgres
    ? (await pool.query("SELECT * FROM payments WHERE id=$1", [id])).rows[0]
    : loadLocalDb().payments.find((payment) => payment.id === id);

  if (!existingPayment) return false;

  const tenantId = existingPayment.tenant_id || existingPayment.tenantId;

  if (usePostgres) {
    const result = await pool.query("DELETE FROM payments WHERE id=$1", [id]);
    if (result.rowCount > 0) {
      await syncTenantRentStatus(tenantId);
      return true;
    }
    return false;
  }
  const db = loadLocalDb();
  const index = db.payments.findIndex((payment) => payment.id === id);
  if (index === -1) return false;
  db.payments.splice(index, 1);
  saveLocalDb();
  await syncTenantRentStatus(tenantId);
  return true;
}

async function deleteAllPayments() {
  if (usePostgres) {
    await pool.query("DELETE FROM payments");
    await pool.query("UPDATE tenants SET rent_status='unpaid'");
    return;
  }
  const db = loadLocalDb();
  db.payments = [];
  db.tenants.forEach((tenant) => {
    tenant.rent_status = "unpaid";
    tenant.rentStatus = "unpaid";
  });
  saveLocalDb();
}

async function getWaterBills(user = null) {
  const houses = await getHouses(user);
  const houseMap = Object.fromEntries(houses.map((h) => [h.id, h]));
  const allowedHouseIds = new Set(Object.keys(houseMap));

  if (usePostgres) {
    const result = await pool.query("SELECT * FROM water_bills ORDER BY created_at DESC");
    return result.rows
      .filter((bill) => allowedHouseIds.has(bill.house_id))
      .map((bill) => mapWaterBill(bill, houseMap));
  }

  const db = loadLocalDb();
  return [...db.water_bills || []]
    .filter((bill) => allowedHouseIds.has(bill.house_id))
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
    .map((bill) => mapWaterBill(bill, houseMap));
}

function mapWaterBill(bill, houseMap) {
  const house = houseMap[bill.house_id || bill.houseId] || {};
  return {
    id: bill.id,
    houseId: bill.house_id || bill.houseId,
    houseNumber: house.houseNumber || "Unknown",
    houseName: house.houseName || house.houseNumber || "",
    houseType: house.roomType || "Unknown",
    billMonth: bill.bill_month || bill.billMonth,
    billYear: bill.bill_year || bill.billYear,
    readingDate: bill.reading_date || bill.readingDate,
    previousReading: Number(bill.previous_reading ?? bill.previousReading ?? 0),
    currentReading: Number(bill.current_reading ?? bill.currentReading ?? 0),
    unitsUsed: Number(bill.units_used ?? bill.unitsUsed ?? 0),
    waterAmount: Number(bill.water_amount ?? bill.waterAmount ?? 0),
    notes: bill.notes || "",
    createdAt: bill.created_at || bill.createdAt
  };
}

async function createWaterBill({ houseId, billMonth, billYear, readingDate, previousReading, currentReading, waterAmount = 0, notes }) {
  const id = crypto.randomUUID();
  const unitsUsed = Number(currentReading) - Number(previousReading);
  const normalizedUnits = Number.isFinite(unitsUsed) && unitsUsed >= 0 ? unitsUsed : 0;
  const normalizedWater = Number(waterAmount) || normalizedUnits * 30;
  const record = {
    id,
    house_id: houseId,
    houseId,
    bill_month: billMonth,
    billMonth,
    bill_year: Number(billYear),
    billYear: Number(billYear),
    reading_date: readingDate,
    readingDate,
    previous_reading: Number(previousReading),
    previousReading: Number(previousReading),
    current_reading: Number(currentReading),
    currentReading: Number(currentReading),
    units_used: normalizedUnits,
    unitsUsed: normalizedUnits,
    water_amount: normalizedWater,
    waterAmount: normalizedWater,
    notes: notes || "",
    created_at: new Date().toISOString(),
    createdAt: new Date().toISOString()
  };

  if (usePostgres) {
    await pool.query(
      "INSERT INTO water_bills (id, house_id, bill_month, bill_year, reading_date, previous_reading, current_reading, units_used, water_amount, notes, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,now())",
      [id, houseId, billMonth, Number(billYear), readingDate, Number(previousReading), Number(currentReading), normalizedUnits, normalizedWater, notes || ""]
    );
  } else {
    const db = loadLocalDb();
    if (!Array.isArray(db.water_bills)) db.water_bills = [];
    db.water_bills.push(record);
    saveLocalDb();
  }

  return record;
}

function isProductionEnvironment() {
  return process.env.NODE_ENV === "production" || Boolean(process.env.RENDER) || Boolean(process.env.RENDER_SERVICE_NAME) || Boolean(process.env.VERCEL);
}

// ---------------------------------------------------------------------------
// FIX: decide Secure/SameSite from the ACTUAL request instead of guessing
// which hosting platform we're on. This is the core fix for users getting
// logged out — previously isProductionEnvironment() could return false even
// when the site was live behind HTTPS (e.g. an unset NODE_ENV, or a host
// that doesn't set RENDER/VERCEL env vars), which meant the session cookie
// was sent without SameSite=None; Secure and got silently dropped by the
// browser on cross-origin requests.
// ---------------------------------------------------------------------------
function isRequestSecure(req) {
  const forwardedProto = req.headers["x-forwarded-proto"];
  if (forwardedProto) {
    return forwardedProto.split(",")[0].trim().toLowerCase() === "https";
  }
  return Boolean(req.socket && req.socket.encrypted);
}

function getAllowedOrigin(req) {
  const requestOrigin = req && req.headers ? req.headers.origin : "";
  const configuredOrigins = (process.env.ALLOWED_ORIGINS || process.env.FRONTEND_URL || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);

  if (requestOrigin && (configuredOrigins.includes(requestOrigin) || requestOrigin.includes("vercel.app") || requestOrigin.includes("onrender.com") || requestOrigin.includes("localhost") || requestOrigin.includes("127.0.0.1"))) {
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
    const chunks = [];
    let bodyLength = 0;

    req.on("data", (chunk) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      chunks.push(buffer);
      bodyLength += buffer.length;

      if (bodyLength > 1_000_000) {
        reject(new Error("Request body is too large"));
        req.destroy();
      }
    });

    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8").trim();
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

// FIX: sendSessionCookie/clearSessionCookie now take `req` and base the
// Secure/SameSite attributes on the real request protocol via
// isRequestSecure(req), instead of the unreliable isProductionEnvironment().
function sendSessionCookie(res, token, req) {
  const secureRequest = isRequestSecure(req);
  const sameSite = secureRequest ? "None" : "Lax";
  const secure = secureRequest ? "; Secure" : "";
  const maxAge = 7 * 24 * 60 * 60;
  res.setHeader("Set-Cookie", `session_token=${token}; HttpOnly; SameSite=${sameSite}; Path=/; Max-Age=${maxAge}${secure}`);
}

function clearSessionCookie(res, req) {
  const secureRequest = isRequestSecure(req);
  const sameSite = secureRequest ? "None" : "Lax";
  const secure = secureRequest ? "; Secure" : "";
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
  const matchPayment = pathname.match(/^\/api\/payments\/([^/]+)$/);
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
    const requestedRole = String(body.role || "landlord").trim().toLowerCase();
    const password = String(body.password || "");

    if (!email || !fullName || !password) {
      sendError(res, 400, "Email, full name, and password are required", req);
      return;
    }
    if (await getUserByEmail(email)) {
      sendError(res, 409, "Email is already registered", req);
      return;
    }

    const role = requestedRole === "caretaker" ? "caretaker" : "tenant";
    const user = await createUser(email, fullName, role, password);
    const token = await createSession(user.id);
    sendSessionCookie(res, token, req);
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
    sendSessionCookie(res, token, req);
    sendJson(res, 200, { user: sanitizeUser(user) }, req);
    return;
  }

  if (req.method === "POST" && pathname === "/api/logout") {
    const cookies = parseCookies(req.headers.cookie || "");
    if (cookies.session_token) {
      await deleteSession(cookies.session_token);
    }
    clearSessionCookie(res, req);
    sendJson(res, 200, { ok: true }, req);
    return;
  }

  if (req.method === "POST" && pathname === "/api/houses") {
    const user = await requireRole(res, req, ["manager", "landlord"]);
    if (!user) return;
    const body = await readRequestBody(req);
    const houseNumber = String(body.houseNumber || body.house_number || "").trim();
    const roomType = String(body.roomType || body.room_type || "").trim();
    const location = String(body.location || "").trim();
    const description = String(body.description || "").trim();
    const price = Number(body.price ?? body.rentAmount ?? body.rent_amount);

    if (!houseNumber || !roomType || Number.isNaN(price) || price <= 0) {
      sendError(res, 400, "House number, house type, and price are required", req);
      return;
    }

    const existing = (await getHouses()).find((house) => house.houseNumber.toLowerCase() === houseNumber.toLowerCase());
    if (existing) {
      sendError(res, 409, "A house with this number already exists", req);
      return;
    }

    const house = await createHouse({
      houseNumber,
      houseName: body.houseName,
      rentAmount: price,
      roomType,
      location,
      description,
      price,
      caretakerName: body.caretakerName,
      caretakerPhone: body.caretakerPhone,
      ownerId: user.id
    });
    sendJson(res, 201, { house }, req);
    return;
  }

  const houseMatch = pathname.match(/^\/api\/houses\/([^/]+)$/);
  if (req.method === "PUT" && houseMatch) {
    const user = await requireRole(res, req, ["manager", "landlord"]);
    if (!user) return;
    const body = await readRequestBody(req);
    if (!body.houseNumber || !body.roomType || Number.isNaN(Number(body.price)) || Number(body.price) <= 0) {
      sendError(res, 400, "House number, house type, and price are required", req);
      return;
    }
    const duplicate = (await getHouses()).find((house) => house.houseNumber.toLowerCase() === String(body.houseNumber).trim().toLowerCase() && house.id !== houseMatch[1]);
    if (duplicate) {
      sendError(res, 409, "A house with this number already exists", req);
      return;
    }
    const updated = await updateHouse(houseMatch[1], body);
    if (!updated) {
      sendError(res, 404, "House not found", req);
      return;
    }
    sendJson(res, 200, { ok: true }, req);
    return;
  }

  if (req.method === "GET" && pathname === "/api/houses") {
    const user = await requireAuth(res, req);
    if (!user) return;
    sendJson(res, 200, { houses: await getHouses(user) }, req);
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
      getTenants(user), getApplications(user), getPayments(user), getHouses(user)
    ]);

    const stats = {
      totalTenants: tenants.filter((tenant) => tenant.status === "active").length,
      occupiedHouses: houses.filter((h) => h.status === "occupied").length,
      pendingApplications: applications.filter((a) => a.status === "pending").length,
      rentCollected: payments.reduce((sum, p) => sum + Number(p.amount || 0), 0),
      unpaidRent: tenants.filter((t) => t.rentStatus !== "paid").reduce((sum, t) => {
        const house = houses.find((h) => h.id === t.houseId);
        return sum + (house ? house.rentAmount : 0);
      }, 0)
    };

    sendJson(res, 200, { stats, recentApplications: applications.slice(0, 5) }, req);
    return;
  }

  if (req.method === "GET" && pathname === "/api/tenants") {
    const user = await requireRole(res, req, ["manager", "landlord"]);
    if (!user) return;
    sendJson(res, 200, { tenants: await getTenants(user) }, req);
    return;
  }

  if (req.method === "GET" && pathname === "/api/users") {
    const user = await requireRole(res, req, ["manager"]);
    if (!user) return;
    sendJson(res, 200, { users: await getUsers() }, req);
    return;
  }

  if (req.method === "POST" && pathname === "/api/tenants") {
    const user = await requireRole(res, req, ["manager", "landlord"]);
    if (!user) return;
    const body = await readRequestBody(req);
    if (!body.name || !body.phone || !body.houseId || !body.moveInDate) {
      sendError(res, 400, "Name, phone, house, and move-in date are required", req);
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
    const user = await requireRole(res, req, ["manager", "landlord"]);
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
    const user = await requireRole(res, req, ["manager", "landlord"]);
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
    const user = await requireRole(res, req, ["manager", "landlord"]);
    if (!user) return;
    sendJson(res, 200, { applications: await getApplications(user) }, req);
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
    const user = await requireRole(res, req, ["manager", "landlord"]);
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
    const user = await requireRole(res, req, ["manager", "landlord"]);
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
    const user = await requireRole(res, req, ["manager", "landlord"]);
    if (!user) return;
    sendJson(res, 200, { payments: await getPayments(user) }, req);
    return;
  }

  if (req.method === "POST" && pathname === "/api/payments") {
    const user = await requireRole(res, req, ["manager", "landlord"]);
    if (!user) return;
    const body = await readRequestBody(req);
    if (!body.tenantId || !body.amount || !body.rentMonth || !body.paymentDate) {
      sendError(res, 400, "Tenant, amount, rent month, and payment date are required", req);
      return;
    }
    const payment = await createPayment({
      tenantId: body.tenantId,
      amount: body.amount,
      rentMonth: body.rentMonth,
      paymentDate: body.paymentDate,
      waterAmount: body.waterAmount,
      garbageAmount: body.garbageAmount
    });
    sendJson(res, 201, payment, req);
    return;
  }

  if (req.method === "DELETE" && pathname === "/api/payments") {
    const user = await requireRole(res, req, ["manager", "landlord"]);
    if (!user) return;
    await deleteAllPayments();
    sendJson(res, 200, { ok: true }, req);
    return;
  }

  if (req.method === "PUT" && matchPayment) {
    const user = await requireRole(res, req, ["manager", "landlord"]);
    if (!user) return;
    const body = await readRequestBody(req);
    if (!body.tenantId || !body.amount || !body.rentMonth || !body.paymentDate) {
      sendError(res, 400, "Tenant, amount, rent month, and payment date are required", req);
      return;
    }
    const payment = await updatePayment(matchPayment[1], body);
    if (!payment) {
      sendError(res, 404, "Payment or tenant not found", req);
      return;
    }
    sendJson(res, 200, payment, req);
    return;
  }

  if (req.method === "DELETE" && matchPayment) {
    const user = await requireRole(res, req, ["manager", "landlord"]);
    if (!user) return;
    const deleted = await deletePayment(matchPayment[1]);
    if (!deleted) {
      sendError(res, 404, "Payment not found", req);
      return;
    }
    sendJson(res, 200, { ok: true }, req);
    return;
  }

  if (req.method === "GET" && pathname === "/api/water-bills") {
    const user = await requireRole(res, req, ["manager", "landlord"]);
    if (!user) return;
    sendJson(res, 200, { waterBills: await getWaterBills(user) }, req);
    return;
  }

  if (req.method === "POST" && pathname === "/api/water-bills") {
    const user = await requireRole(res, req, ["manager", "landlord"]);
    if (!user) return;
    const body = await readRequestBody(req);
    if (!body.houseId || !body.billMonth || !body.billYear || !body.readingDate || body.previousReading === undefined || body.currentReading === undefined) {
      sendError(res, 400, "House, month, year, reading date, previous reading, and current reading are required", req);
      return;
    }
    const waterBill = await createWaterBill({
      houseId: body.houseId,
      billMonth: body.billMonth,
      billYear: body.billYear,
      readingDate: body.readingDate,
      previousReading: body.previousReading,
      currentReading: body.currentReading,
      waterAmount: body.waterAmount,
      notes: body.notes
    });
    sendJson(res, 201, waterBill, req);
    return;
  }

  if (req.method === "GET" && pathname === "/api/reports") {
    const user = await requireRole(res, req, ["manager", "landlord"]);
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
