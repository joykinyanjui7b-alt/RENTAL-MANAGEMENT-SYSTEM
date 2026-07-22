const API_BASE_URL = (() => {
  const configured = window.APP_CONFIG && window.APP_CONFIG.apiBaseUrl !== undefined ? window.APP_CONFIG.apiBaseUrl : "";
  const base = String(configured || "").replace(/\/$/, "");
  return base || (window.location.origin || "");
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
  const response = await fetch(`${API_BASE_URL}${path}`, {
    credentials: "include",
    headers: { "Content-Type": "application/json", ...options.headers },
    ...options
  });

  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload.error || "Request failed");
  }

  return payload;
}

function updateToggleButton() {
  if (!els.passwordInput || !els.togglePasswordButton) return;
  const isPassword = els.passwordInput.type === "password";
  els.togglePasswordButton.textContent = isPassword ? "Show" : "Hide";
  els.togglePasswordButton.setAttribute("aria-label", `${isPassword ? "Show" : "Hide"} password`);
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
  }
}

if (els.authForm) {
  initPasswordToggle();
  els.authForm.addEventListener("submit", handleSubmit);
  els.authSubmitButton?.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    handleSubmit(event);
  });
}