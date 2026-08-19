const FALLBACK_API_BASE_URL = "https://rental-management-system-vnn1.onrender.com";
const API_BASE_URL = (() => {
  const configured = window.APP_CONFIG && window.APP_CONFIG.apiBaseUrl !== undefined ? window.APP_CONFIG.apiBaseUrl : "";
  const base = String(configured || FALLBACK_API_BASE_URL || "").replace(/\/$/, "");
  return base || FALLBACK_API_BASE_URL;
})();
const els = {
  authForm: document.querySelector("#authForm"),
  emailInput: document.querySelector("#emailInput"),
  fullNameInput: document.querySelector("#fullNameInput"),
  roleInput: document.querySelector("#roleInput"),
  passwordInput: document.querySelector("#passwordInput"),
  authSubmitButton: document.querySelector("#authSubmitButton"),
  togglePasswordButton: document.querySelector("#togglePasswordButton"),
  toast: document.querySelector("#toast")
};

function showToast(message) {
  if (!els.toast) return;
  els.toast.textContent = message;
  els.toast.classList.add("show");
  window.setTimeout(() => els.toast.classList.remove("show"), 2600);
}

async function api(path, options = {}) {
  const targets = [`${API_BASE_URL}${path}`, `${FALLBACK_API_BASE_URL}${path}`, `${window.location.origin}${path}`];
  let lastErr;
  for (const url of targets) {
    try {
      const response = await fetch(url, {
        credentials: "include",
        headers: { "Content-Type": "application/json", ...options.headers },
        ...options
      });

      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload.error || "Request failed");
      }

      return payload;
    } catch (err) {
      lastErr = err;
      const isNetworkError = err instanceof TypeError || /failed to fetch/i.test(String(err.message)) || /network error/i.test(String(err.message));
      if (!isNetworkError) {
        throw err;
      }
      // try next
    }
  }

  throw lastErr;
}

function updateToggleButton() {
  if (!els.passwordInput || !els.togglePasswordButton) return;
  const isPassword = els.passwordInput.type === "password";
  const icon = els.togglePasswordButton.querySelector("span");
  if (icon) {
    icon.textContent = isPassword ? "👁" : "🙈";
  }
  els.togglePasswordButton.setAttribute("aria-label", `${isPassword ? "Show" : "Hide"} password`);
  els.togglePasswordButton.setAttribute("title", `${isPassword ? "Show" : "Hide"} password`);
  els.togglePasswordButton.classList.toggle("active", !isPassword);
}

function initPasswordToggle() {
  if (!els.passwordInput || !els.togglePasswordButton) return;

  els.togglePasswordButton.addEventListener("click", () => {
    els.passwordInput.type = els.passwordInput.type === "password" ? "text" : "password";
    updateToggleButton();
    els.passwordInput.focus();
  });

  updateToggleButton();
}

function getMode() {
  const mode = els.authForm?.dataset?.mode;
  return mode === "register" ? "register" : "login";
}

async function handleSubmit(event) {
  if (event) {
    event.preventDefault();
    event.stopPropagation();
  }

  const mode = getMode();
  const email = els.emailInput.value.trim();
  const password = els.passwordInput.value;
  const payload = { email, password };

  if (mode === "register") {
    payload.fullName = els.fullNameInput.value.trim();
    payload.role = els.roleInput ? els.roleInput.value : "landlord";
  }

  if (!email || !password || (mode === "register" && !payload.fullName)) {
    showToast("Please complete all required fields.");
    return;
  }

  if (els.authSubmitButton) {
    if (els.authSubmitButton.disabled) return; // already submitting, ignore extra clicks
    els.authSubmitButton.disabled = true;
    els.authSubmitButton.textContent = mode === "register" ? "Registering..." : "Logging in...";
  }

  try {
    await api(`/api/${mode}`, {
      method: "POST",
      body: JSON.stringify(payload)
    });

    const message = mode === "register"
      ? "Registration successful! Welcome to Rental Management System."
      : "Login successful! Welcome back.";

    window.location.href = `index.html?message=${encodeURIComponent(message)}&status=success`;
  } catch (error) {
    showToast(error.message);
    if (els.authSubmitButton) {
      els.authSubmitButton.disabled = false;
      els.authSubmitButton.textContent = mode === "register" ? "Register" : "Login";
    }
  }
}

if (els.authForm) {
  initPasswordToggle();
  els.authForm.addEventListener("submit", handleSubmit);
}