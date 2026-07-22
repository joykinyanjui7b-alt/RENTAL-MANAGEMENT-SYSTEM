const apiBaseUrl = "http://localhost:3000";
let cookie;

async function request(path, options = {}) {
  const headers = options.headers || {};
  if (cookie) {
    headers.Cookie = cookie;
  }
  const response = await fetch(`${apiBaseUrl}${path}`, {
    ...options,
    headers,
    redirect: "manual"
  });
  const setCookie = response.headers.get("set-cookie");
  if (setCookie) {
    cookie = setCookie.split(";")[0];
  }
  const body = await response.text();
  let json;
  try {
    json = JSON.parse(body);
  } catch {
    json = body;
  }
  return { status: response.status, body: json, headers: { setCookie } };
}

async function run() {
  console.log("Starting smoke test against local backend...");

  const registerPayload = {
    email: "testuser@example.com",
    fullName: "Test User",
    password: "Password123!"
  };

  const register = await request("/api/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(registerPayload)
  });
  console.log("Register status:", register.status, register.body);
  if (register.status !== 201 && register.status !== 409) {
    throw new Error("Register failed");
  }

  const loginPayload = {
    email: "testuser@example.com",
    password: "Password123!"
  };
  const login = await request("/api/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(loginPayload)
  });
  console.log("Login status:", login.status, login.body);
  if (login.status !== 200) {
    throw new Error("Login failed");
  }

  const me = await request("/api/me", { method: "GET" });
  console.log("Me status:", me.status, me.body);
  if (me.status !== 200 || !me.body.user) {
    throw new Error("Me endpoint failed");
  }

  const logout = await request("/api/logout", { method: "POST" });
  console.log("Logout status:", logout.status, logout.body);
  if (logout.status !== 200) {
    throw new Error("Logout failed");
  }

  console.log("Smoke test completed successfully.");
}

run().catch((error) => {
  console.error("Smoke test failed:", error);
  process.exit(1);
});
