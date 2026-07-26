const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const rootDir = path.resolve(__dirname, '..');
const dbPath = path.join(__dirname, 'dev-db.json');
const backupPath = path.join(__dirname, 'dev-db.json.bak');
const port = 3123;
const baseUrl = `http://127.0.0.1:${port}`;

function waitForServer() {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tryConnect = () => {
      fetch(`${baseUrl}/api/health`)
        .then((res) => {
          if (res.ok) resolve();
          else throw new Error(`health status ${res.status}`);
        })
        .catch((error) => {
          if (Date.now() - start > 15000) {
            reject(error);
            return;
          }
          setTimeout(tryConnect, 200);
        });
    };
    tryConnect();
  });
}

async function request(path, options = {}, cookies) {
  const headers = { ...(options.headers || {}) };
  if (cookies) headers.Cookie = cookies;
  const res = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers,
    redirect: 'manual'
  });
  const body = await res.text();
  let json;
  try {
    json = JSON.parse(body);
  } catch {
    json = body;
  }
  const setCookie = res.headers.get('set-cookie');
  return { status: res.status, body: json, setCookie };
}

async function main() {
  const original = fs.existsSync(dbPath) ? fs.readFileSync(dbPath, 'utf8') : null;
  if (original) fs.writeFileSync(backupPath, original);

  const server = spawn(process.execPath, ['server.js'], {
    cwd: __dirname,
    env: { ...process.env, PORT: String(port) },
    stdio: 'pipe'
  });

  let output = '';
  server.stdout.on('data', (chunk) => { output += chunk.toString(); });
  server.stderr.on('data', (chunk) => { output += chunk.toString(); });

  try {
    await waitForServer();

    const landlord1Login = await request('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'landlord@rms.com', password: 'RmsDemo2026!' })
    });
    assert.strictEqual(landlord1Login.status, 200, `login 1 failed: ${JSON.stringify(landlord1Login.body)}`);
    const landlord1Cookie = landlord1Login.setCookie ? landlord1Login.setCookie.split(';')[0] : '';

    const landlord2Login = await request('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'landlord2@rms.com', password: 'RmsDemo2026!' })
    });
    assert.strictEqual(landlord2Login.status, 200, `login 2 failed: ${JSON.stringify(landlord2Login.body)}`);
    const landlord2Cookie = landlord2Login.setCookie ? landlord2Login.setCookie.split(';')[0] : '';

    const createHouse = await request('/api/houses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ roomType: 'One bedroom', location: 'Juja', price: 15000, description: 'Demo house for landlord 1' })
    }, landlord1Cookie);
    assert.strictEqual(createHouse.status, 201, `house create failed: ${JSON.stringify(createHouse.body)}`);

    const landlord2Houses = await request('/api/houses', { method: 'GET' }, landlord2Cookie);
    assert.strictEqual(landlord2Houses.status, 200, `landlord 2 houses request failed: ${JSON.stringify(landlord2Houses.body)}`);
    const houseIds = (landlord2Houses.body.houses || []).map((house) => house.id);
    assert.ok(!houseIds.includes(createHouse.body.house.id), 'Landlord 2 can see landlord 1 house');

    console.log('Per-landlord data isolation test passed.');
  } finally {
    server.kill('SIGTERM');
    if (original) fs.writeFileSync(dbPath, original);
    else fs.rmSync(dbPath, { force: true });
    if (fs.existsSync(backupPath)) fs.rmSync(backupPath, { force: true });
  }
}

main().catch((error) => {
  console.error('Per-landlord data isolation test failed:', error);
  process.exit(1);
});
