const FALLBACK_API_BASE_URL = "https://rental-management-system-vnn1.onrender.com";
const API_BASE_URL = (() => {
  const configured = window.APP_CONFIG && window.APP_CONFIG.apiBaseUrl !== undefined ? window.APP_CONFIG.apiBaseUrl : "";
  const base = String(configured || FALLBACK_API_BASE_URL || "").replace(/\/$/, "");
  return base || FALLBACK_API_BASE_URL;
})();

const state = {
  user: null,
  tenants: [],
  applications: [],
  payments: [],
  houses: [],
  waterBills: [],
  applicationStatusFilter: "",
  tenantSearch: ""
};

const els = {
  navLinks: document.querySelectorAll(".nav-list a[data-panel]"),
  panels: document.querySelectorAll(".view-panel"),
  pageTitle: document.querySelector("#pageTitle"),
  workspaceLabel: document.querySelector("#workspaceLabel"),
  userGreeting: document.querySelector("#userGreeting"),
  logoutButton: document.querySelector("#logoutButton"),
  tenantHouseList: document.querySelector("#tenantHouseList"),
  tenantApplicationForm: document.querySelector("#tenantApplicationForm"),
  tenantApplicationHouseInput: document.querySelector("#tenantApplicationHouseInput"),
  tenantApplicationMessageInput: document.querySelector("#tenantApplicationMessageInput"),
  myApplicationsTable: document.querySelector("#myApplicationsTable"),
  browseHousesButton: document.querySelector("#browseHousesButton"),
  userTable: document.querySelector("#userTable"),
  houseNameInput: document.querySelector("#houseNameInput"),
  houseCaretakerNameInput: document.querySelector("#houseCaretakerNameInput"),
  houseCaretakerPhoneInput: document.querySelector("#houseCaretakerPhoneInput"),
  newWaterBillButton: document.querySelector("#newWaterBillButton"),
  waterBillTable: document.querySelector("#waterBillTable"),
  waterBillDialog: document.querySelector("#waterBillDialog"),
  waterBillForm: document.querySelector("#waterBillForm"),
  waterBillHouseInput: document.querySelector("#waterBillHouseInput"),
  waterBillMonthInput: document.querySelector("#waterBillMonthInput"),
  waterBillYearInput: document.querySelector("#waterBillYearInput"),
  waterBillReadingDateInput: document.querySelector("#waterBillReadingDateInput"),
  waterBillPreviousInput: document.querySelector("#waterBillPreviousInput"),
  waterBillCurrentInput: document.querySelector("#waterBillCurrentInput"),
  waterBillAmountInput: document.querySelector("#waterBillAmountInput"),
  waterBillNotesInput: document.querySelector("#waterBillNotesInput"),
  closeWaterBillDialogButton: document.querySelector("#closeWaterBillDialogButton"),

  stats: document.querySelector("#stats"),
  recentApplicationsTable: document.querySelector("#recentApplicationsTable"),
  landlordHousePanel: document.querySelector("#landlordHousePanel"),
  newHouseButton: document.querySelector("#newHouseButton"),
  landlordHouseTable: document.querySelector("#landlordHouseTable"),
  houseDialog: document.querySelector("#houseDialog"),
  houseForm: document.querySelector("#houseForm"),
  houseNumberInput: document.querySelector("#houseNumberInput"),
  houseRoomTypeInput: document.querySelector("#houseRoomTypeInput"),
  houseLocationInput: document.querySelector("#houseLocationInput"),
  housePriceInput: document.querySelector("#housePriceInput"),
  houseDescriptionInput: document.querySelector("#houseDescriptionInput"),
  closeHouseDialogButton: document.querySelector("#closeHouseDialogButton"),

  tenantSearchInput: document.querySelector("#tenantSearchInput"),
  tenantTable: document.querySelector("#tenantTable"),
  newTenantButton: document.querySelector("#newTenantButton"),
  tenantDialog: document.querySelector("#tenantDialog"),
  tenantForm: document.querySelector("#tenantForm"),
  tenantDialogTitle: document.querySelector("#tenantDialogTitle"),
  tenantId: document.querySelector("#tenantId"),
  tenantNameInput: document.querySelector("#tenantNameInput"),
  tenantPhoneInput: document.querySelector("#tenantPhoneInput"),
  tenantMoveInDateInput: document.querySelector("#tenantMoveInDateInput"),
  tenantMoveOutDateInput: document.querySelector("#tenantMoveOutDateInput"),
  tenantHouseNumberInput: document.querySelector("#tenantHouseNumberInput"),
  tenantHouseTypeInput: document.querySelector("#tenantHouseTypeInput"),
  deleteTenantButton: document.querySelector("#deleteTenantButton"),
  closeTenantDialogButton: document.querySelector("#closeTenantDialogButton"),

  applicationStatusFilter: document.querySelector("#applicationStatusFilter"),
  applicationTable: document.querySelector("#applicationTable"),

  paymentTable: document.querySelector("#paymentTable"),
  newPaymentButton: document.querySelector("#newPaymentButton"),
  paymentDialog: document.querySelector("#paymentDialog"),
  paymentForm: document.querySelector("#paymentForm"),
  paymentTenantInput: document.querySelector("#paymentTenantInput"),
  paymentAmountInput: document.querySelector("#paymentAmountInput"),
  paymentDateInput: document.querySelector("#paymentDateInput"),
  closePaymentDialogButton: document.querySelector("#closePaymentDialogButton"),

  reportForm: document.querySelector("#reportForm"),
  reportTypeInput: document.querySelector("#reportTypeInput"),
  reportFromInput: document.querySelector("#reportFromInput"),
  reportToInput: document.querySelector("#reportToInput"),
  reportTableHead: document.querySelector("#reportTableHead"),
  reportTable: document.querySelector("#reportTable"),

  toast: document.querySelector("#toast")
};

async function api(path, options = {}) {
  const targets = [`${API_BASE_URL}${path}`, `${FALLBACK_API_BASE_URL}${path}`, `${window.location.origin}${path}`];
  let lastErr;
  for (const url of targets) {
    try {
      const response = await fetch(url, {
        credentials: "include",
        headers: {
          "Content-Type": "application/json",
          ...options.headers
        },
        ...options
      });

      const payload = await response.json();

      if (!response.ok) {
        // If the server responded with an error status, surface it immediately
        throw new Error(payload.error || "Request failed");
      }

      return payload;
    } catch (err) {
      lastErr = err;
      // Only fallback on network-type failures (fetch throws TypeError on network errors).
      const isNetworkError = err instanceof TypeError || /failed to fetch/i.test(String(err.message)) || /network error/i.test(String(err.message));
      if (!isNetworkError) {
        throw err;
      }
      // otherwise try next target
    }
  }

  throw lastErr;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function formatDate(value) {
  if (!value) return "No date";
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" }).format(
    new Date(`${value}T00:00:00`)
  );
}

function formatMoney(value) {
  const n = Number(value || 0);
  return `KSh ${n.toLocaleString()}`;
}

function showToast(message) {
  els.toast.textContent = message;
  els.toast.classList.add("show");
  window.setTimeout(() => els.toast.classList.remove("show"), 2400);
}

function showPanel(name) {
  els.panels.forEach((panel) => {
    panel.hidden = panel.id !== `panel-${name}`;
  });
  els.navLinks.forEach((link) => {
    link.classList.toggle("active", link.dataset.panel === name);
  });
  const titles = {
    dashboard: "Dashboard",
    houses: "Available Houses",
    "my-applications": "My Applications",
    tenants: "Tenant Records",
    applications: "Applications",
    payments: "Payments",
    "water-bills": "Water bills",
    reports: "Reports",
    users: "User Access"
  };
  els.pageTitle.textContent = titles[name] || "Dashboard";

  if (name === "tenants") loadTenants();
  if (name === "applications") loadApplications();
  if (name === "payments") loadPayments();
  if (name === "water-bills") loadWaterBills();
  if (name === "houses") renderTenantHouses();
  if (name === "my-applications") loadMyApplications();
  if (name === "users") loadUsers();
}

els.navLinks.forEach((link) => {
  link.addEventListener("click", (event) => {
    event.preventDefault();
    showPanel(link.dataset.panel);
  });
});

async function loadUser() {
  // Keep the app hidden until auth is resolved so the flash of the guest
  // state does not appear while the backend checks the current session.
  document.body.classList.add("loading");

  let data;
  try {
    data = await api("/api/me");
  } catch (error) {
    window.location.href = "login.html";
    return;
  }

  if (!data.user) {
    window.location.href = "login.html";
    return;
  }

  state.user = data.user;
  els.userGreeting.textContent = `Hi, ${data.user.fullName}`;
  applyRoleUI(data.user.role);
  showPanel("dashboard");
  document.body.classList.remove("loading");

  // Step 2: load dashboard data. The user is already confirmed logged in,
  // so a failure here (slow backend, brief network blip, Render free-tier
  // cold start, etc.) should show a retry message — NOT kick the user
  // back to the login screen.
  try {
    await Promise.all([loadHouses(), loadDashboard()]);
  } catch (error) {
    showToast("Some data failed to load. Refreshing may help.");
  }
}

function applyRoleUI(role) {
  const labels = { manager: "Manager workspace", landlord: "Landlord workspace", caretaker: "Caretaker workspace", tenant: "Tenant workspace" };
  els.workspaceLabel.textContent = labels[role] || "Rental workspace";
  els.navLinks.forEach((link) => {
    const roles = (link.dataset.roles || "").split(",");
    link.hidden = !roles.includes(role);
  });
  if (els.landlordHousePanel) {
    els.landlordHousePanel.hidden = !(role === "landlord" || role === "manager");
  }
  if (role === "tenant") {
    document.querySelectorAll("#panel-tenants, #panel-applications, #panel-payments, #panel-reports, #panel-water-bills, #panel-users").forEach((panel) => {
      panel.hidden = true;
    });
  }
}

function renderLandlordHouses() {
  if (!els.landlordHouseTable) return;
  if (!state.houses.length) {
    els.landlordHouseTable.innerHTML = `<tr><td colspan="5"><div class="empty-state">No houses added yet.</div></td></tr>`;
    return;
  }

  els.landlordHouseTable.innerHTML = state.houses
    .map((house) => `
      <tr>
        <td><strong>${escapeHtml(house.houseNumber)}</strong><p>${escapeHtml(house.location || "Location not set")}</p></td>
        <td>${escapeHtml(house.roomType || "House type not set")}</td>
        <td>${formatMoney(house.rentAmount || house.price || 0)}</td>
        <td>${escapeHtml(house.caretakerName ? `${house.caretakerName}${house.caretakerPhone ? ` • ${house.caretakerPhone}` : ""}` : "No caretaker assigned")}</td>
        <td><span class="pill ${house.status === "vacant" ? "approved" : "blocked"}">${escapeHtml(house.status || "vacant")}</span></td>
      </tr>
    `)
    .join("");
}

async function loadUsers() {
  const data = await api("/api/users");
  els.userTable.innerHTML = (data.users || []).map((user) => `
    <tr>
      <td>${escapeHtml(user.fullName)}</td>
      <td>${escapeHtml(user.email)}</td>
      <td><span class="pill ${["manager","landlord","caretaker"].includes(user.role) ? "approved" : "in-review"}">${escapeHtml(user.role)}</span></td>
      <td>${formatDate(String(user.createdAt).slice(0, 10))}</td>
    </tr>
  `).join("");
}

els.logoutButton.addEventListener("click", async () => {
  await api("/api/logout", { method: "POST" });
  window.location.href = "login.html";
});

els.newHouseButton?.addEventListener("click", () => {
  els.houseForm.reset();
  els.houseDialog.showModal();
});

els.closeHouseDialogButton?.addEventListener("click", () => els.houseDialog.close());

els.houseForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const payload = {
    houseNumber: els.houseNumberInput.value.trim(),
    roomType: els.houseRoomTypeInput.value.trim(),
    location: els.houseLocationInput.value.trim(),
    price: Number(els.housePriceInput.value),
    description: els.houseDescriptionInput.value.trim(),
    caretakerName: els.houseCaretakerNameInput.value.trim(),
    caretakerPhone: els.houseCaretakerPhoneInput.value.trim()
  };
  await api("/api/houses", { method: "POST", body: JSON.stringify(payload) });
  els.houseDialog.close();
  showToast("House added");
  await loadHouses();
  await loadDashboard();
});

async function loadHouses() {
  const data = await api("/api/houses");
  state.houses = data.houses || [];
  const houseNumberOptions = state.houses
    .map((h) => `<option value="${h.id}">${escapeHtml(h.houseNumber)}</option>`)
    .join("");
  const houseTypes = [...new Set(state.houses.map((h) => h.roomType).filter(Boolean))];
  const houseTypeOptions = houseTypes
    .map((type) => `<option value="${escapeHtml(type)}">${escapeHtml(type)}</option>`)
    .join("");
  els.tenantHouseNumberInput.innerHTML = houseNumberOptions;
  els.tenantHouseTypeInput.innerHTML = houseTypeOptions;
  const options = state.houses
    .map((h) => `<option value="${h.id}">${escapeHtml(h.houseNumber)} • ${escapeHtml(h.roomType || "House type not set")}</option>`)
    .join("");
  els.tenantApplicationHouseInput.innerHTML = state.houses
    .filter((house) => house.status === "vacant")
    .map((house) => `<option value="${house.id}">${escapeHtml(house.houseNumber)} • ${escapeHtml(house.roomType || "House type not set")} • ${escapeHtml(house.location || "Location not set")} • ${formatMoney(house.rentAmount || house.price || 0)}</option>`)
    .join("");
  els.waterBillHouseInput.innerHTML = options;
  renderLandlordHouses();
  renderTenantHouses();
  renderWaterBills();
}

async function loadDashboard() {
  const data = await api("/api/dashboard");
  if (state.user?.role === "tenant") {
    renderStats([
      ["Available houses", data.stats?.availableHouses || 0, "houses"],
      ["My applications", data.stats?.myApplications || 0, "my-applications"],
      ["Approved applications", data.stats?.approvedApplications || 0, "my-applications"]
    ]);
    renderRecentApplications(data.recentApplications || []);
    return;
  }
  renderStats(data.stats || {});
  renderRecentApplications(data.recentApplications || []);
}

function renderStats(stats) {
  const items = Array.isArray(stats) ? stats : [
    ["Total tenants", stats.totalTenants || 0, "tenants"],
    ["Occupied houses", stats.occupiedHouses || 0, "tenants"],
    ["Pending applications", stats.pendingApplications || 0, "applications"],
    ["Rent collected", formatMoney(stats.rentCollected || 0), "payments"],
    ["Unpaid rent", formatMoney(stats.unpaidRent || 0), "payments"]
  ];
  els.stats.innerHTML = items
    .map(([label, value, action]) => `
      <article class="stat-card" data-stat-action="${action || ""}" tabindex="${action ? "0" : "-1"}" role="${action ? "button" : "presentation"}">
        <span>${label}</span>
        <strong>${value}</strong>
      </article>
    `)
    .join("");
}

els.stats.addEventListener("click", (event) => {
  const card = event.target.closest("[data-stat-action]");
  if (card?.dataset.statAction) showPanel(card.dataset.statAction);
});

els.stats.addEventListener("keydown", (event) => {
  if (event.key !== "Enter" && event.key !== " ") return;
  const card = event.target.closest("[data-stat-action]");
  if (!card?.dataset.statAction) return;
  event.preventDefault();
  showPanel(card.dataset.statAction);
});

function renderTenantHouses() {
  if (!els.tenantHouseList || state.user?.role !== "tenant") return;
  const available = state.houses.filter((house) => house.status === "vacant");
  els.tenantHouseList.innerHTML = available.length
    ? available.map((house) => `
      <article class="house-card" data-house-id="${house.id}" tabindex="0" role="button" aria-label="Apply for ${escapeHtml(house.roomType || house.houseNumber)}">
        <div>
          <p class="eyebrow">Available rental</p>
          <h3>${escapeHtml(house.roomType || house.houseNumber)}</h3>
          <p class="house-meta">${escapeHtml(house.location || "Location not set")}</p>
        </div>
        <strong>${formatMoney(house.rentAmount || house.price || 0)} <small>per month</small></strong>
        <p class="house-description">${escapeHtml(house.description || "Comfortable rental space available now.")}</p>
        <span class="pill approved">Available</span>
      </article>
    `).join("")
    : `<div class="empty-state">No houses are available right now.</div>`;
}

els.tenantHouseList.addEventListener("click", (event) => {
  const card = event.target.closest("[data-house-id]");
  if (!card) return;
  els.tenantApplicationHouseInput.value = card.dataset.houseId;
  els.tenantApplicationMessageInput.focus();
  els.tenantApplicationForm.scrollIntoView({ behavior: "smooth", block: "center" });
});

els.tenantHouseList.addEventListener("keydown", (event) => {
  if (event.key !== "Enter" && event.key !== " ") return;
  const card = event.target.closest("[data-house-id]");
  if (!card) return;
  event.preventDefault();
  card.click();
});

async function loadMyApplications() {
  const data = await api("/api/dashboard");
  const applications = data.recentApplications || [];
  els.myApplicationsTable.innerHTML = applications.length
    ? applications.map((application) => `
      <tr>
        <td>${escapeHtml(application.houseNumber)}</td>
        <td>${formatDate(application.dateApplied)}</td>
        <td><span class="pill ${escapeHtml(application.status)}">${escapeHtml(application.status)}</span></td>
        <td>${escapeHtml(application.message || "No message")}</td>
      </tr>
    `).join("")
    : `<tr><td colspan="4"><div class="empty-state">You have not submitted an application yet.</div></td></tr>`;
}

els.browseHousesButton.addEventListener("click", () => showPanel("houses"));

function renderRecentApplications(applications) {
  if (applications.length === 0) {
    els.recentApplicationsTable.innerHTML = `<tr><td colspan="4"><div class="empty-state">No recent applications.</div></td></tr>`;
    return;
  }
  els.recentApplicationsTable.innerHTML = applications
    .map((a) => `
      <tr>
        <td>${escapeHtml(a.applicantName)}</td>
        <td>${escapeHtml(a.houseNumber)}</td>
        <td>${formatDate(a.dateApplied)}</td>
        <td><span class="pill ${escapeHtml(a.status)}">${escapeHtml(a.status)}</span></td>
      </tr>
    `)
    .join("");
}

async function loadTenants() {
  const data = await api("/api/tenants");
  state.tenants = data.tenants || [];
  renderTenants();
}


function renderTenants() {
  const needle = state.tenantSearch.trim().toLowerCase();
  const rows = state.tenants.filter((t) =>
    !needle || [t.name, t.phone, t.houseNumber].join(" ").toLowerCase().includes(needle)
  );

  if (rows.length === 0) {
    els.tenantTable.innerHTML = `<tr><td colspan="8"><div class="empty-state">No tenants match.</div></td></tr>`;
    return;
  }

  els.tenantTable.innerHTML = rows
    .map((t) => `
      <tr>
        <td><strong>${escapeHtml(t.name)}</strong></td>
        <td>${escapeHtml(t.phone)}</td>
        <td>${escapeHtml(t.houseNumber)}${t.houseType ? `<p>${escapeHtml(t.houseType)}</p>` : ""}</td>
        <td>${t.moveInDate ? escapeHtml(formatDate(t.moveInDate)) : "Not set"}</td>
        <td>${t.moveOutDate ? escapeHtml(formatDate(t.moveOutDate)) : "Not set"}</td>
        <td><span class="pill ${t.status === "active" ? "approved" : "blocked"}">${escapeHtml(t.status || "active")}</span></td>
        <td><span class="pill ${t.rentStatus === "paid" ? "approved" : "blocked"}">${escapeHtml(t.rentStatus || "unknown")}</span></td>
        <td><button class="action-button" data-edit-tenant="${t.id}" type="button">Edit</button></td>
      </tr>
    `)
    .join("");
}

els.tenantSearchInput.addEventListener("input", (e) => {
  state.tenantSearch = e.target.value;
  renderTenants();
});

function resetTenantForm() {
  els.tenantForm.reset();
  els.tenantId.value = "";
  els.tenantMoveInDateInput.value = new Date().toISOString().slice(0, 10);
  els.deleteTenantButton.hidden = true;
  els.tenantDialogTitle.textContent = "Add tenant";
}

els.newTenantButton.addEventListener("click", () => {
  resetTenantForm();
  els.tenantDialog.showModal();
});

els.closeTenantDialogButton.addEventListener("click", () => els.tenantDialog.close());

els.tenantTable.addEventListener("click", (event) => {
  const btn = event.target.closest("[data-edit-tenant]");
  if (!btn) return;
  const tenant = state.tenants.find((t) => String(t.id) === btn.dataset.editTenant);
  if (!tenant) return;
  els.tenantId.value = tenant.id;
  els.tenantNameInput.value = tenant.name;
  els.tenantPhoneInput.value = tenant.phone;
  els.tenantMoveInDateInput.value = tenant.moveInDate || "";
  els.tenantMoveOutDateInput.value = tenant.moveOutDate || "";
  const tenantHouse = state.houses.find((house) => house.id === tenant.houseId);
  els.tenantHouseNumberInput.value = tenantHouse?.id || "";
  els.tenantHouseTypeInput.value = tenantHouse?.roomType || "";
  els.deleteTenantButton.hidden = false;
  els.tenantDialogTitle.textContent = "Edit tenant";
  els.tenantDialog.showModal();
});

els.tenantForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const id = els.tenantId.value;
  const selectedHouse = state.houses.find((house) =>
    house.id === els.tenantHouseNumberInput.value && house.roomType === els.tenantHouseTypeInput.value
  );
  if (!selectedHouse) {
    showToast("Choose a matching house number and house type.");
    return;
  }
  const payload = {
    name: els.tenantNameInput.value,
    phone: els.tenantPhoneInput.value,
    houseId: selectedHouse.id,
    moveInDate: els.tenantMoveInDateInput.value,
    moveOutDate: els.tenantMoveOutDateInput.value || null
  };

  if (id) {
    await api(`/api/tenants/${id}`, { method: "PUT", body: JSON.stringify(payload) });
    showToast("Tenant updated");
  } else {
    await api("/api/tenants", { method: "POST", body: JSON.stringify(payload) });
    showToast("Tenant added");
  }

  els.tenantDialog.close();
  await loadTenants();
});

els.deleteTenantButton.addEventListener("click", async () => {
  const id = els.tenantId.value;
  if (!id || !window.confirm("Delete this tenant record?")) return;
  await api(`/api/tenants/${id}`, { method: "DELETE" });
  els.tenantDialog.close();
  showToast("Tenant deleted");
  await loadTenants();
});

async function loadApplications() {
  const data = await api("/api/applications");
  state.applications = data.applications || [];
  renderApplications();
}

function renderApplications() {
  const filter = state.applicationStatusFilter;
  const rows = state.applications.filter((a) => !filter || a.status === filter);

  if (rows.length === 0) {
    els.applicationTable.innerHTML = `<tr><td colspan="6"><div class="empty-state">No applications match.</div></td></tr>`;
    return;
  }

  els.applicationTable.innerHTML = rows
    .map((a) => `
      <tr>
        <td>${escapeHtml(a.applicantName)}</td>
        <td>${escapeHtml(a.contact)}</td>
        <td>${escapeHtml(a.houseNumber)}</td>
        <td>${formatDate(a.dateApplied)}</td>
        <td><span class="pill ${escapeHtml(a.status)}">${escapeHtml(a.status)}</span></td>
        <td>
          ${a.status === "pending" ? `
            <button class="action-button" data-approve="${a.id}" type="button">Approve</button>
            <button class="action-button" data-reject="${a.id}" type="button">Reject</button>
          ` : ""}
        </td>
      </tr>
    `)
    .join("");
}

els.applicationStatusFilter.addEventListener("change", (e) => {
  state.applicationStatusFilter = e.target.value;
  renderApplications();
});

els.applicationTable.addEventListener("click", async (event) => {
  const approveBtn = event.target.closest("[data-approve]");
  const rejectBtn = event.target.closest("[data-reject]");

  if (approveBtn) {
    await api(`/api/applications/${approveBtn.dataset.approve}/approve`, { method: "POST" });
    showToast("Application approved — tenant record created");
    await Promise.all([loadApplications(), loadTenants(), loadHouses(), loadDashboard()]);
  }

  if (rejectBtn) {
    await api(`/api/applications/${rejectBtn.dataset.reject}/reject`, { method: "POST" });
    showToast("Application rejected");
    await loadApplications();
  }
});

els.tenantApplicationForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  await api("/api/applications", {
    method: "POST",
    body: JSON.stringify({
      houseId: els.tenantApplicationHouseInput.value,
      message: els.tenantApplicationMessageInput.value
    })
  });
  els.tenantApplicationForm.reset();
  showToast("Application submitted");
  await loadDashboard();
  showPanel("my-applications");
});

async function loadPayments() {
  const data = await api("/api/payments");
  state.payments = data.payments || [];
  renderPayments();

  const options = state.tenants.length
    ? state.tenants.map((t) => `<option value="${t.id}">${escapeHtml(t.name)} • ${escapeHtml(t.houseNumber)}</option>`).join("")
    : (await (async () => {
        const tData = await api("/api/tenants");
        state.tenants = tData.tenants || [];
        return state.tenants.map((t) => `<option value="${t.id}">${escapeHtml(t.name)} • ${escapeHtml(t.houseNumber)}</option>`).join("");
      })());
  els.paymentTenantInput.innerHTML = options;
}

function renderPayments() {
  if (state.payments.length === 0) {
    els.paymentTable.innerHTML = `<tr><td colspan="8"><div class="empty-state">No payments recorded yet.</div></td></tr>`;
    return;
  }

  els.paymentTable.innerHTML = state.payments
    .map((p) => `
      <tr>
        <td>${escapeHtml(p.tenantName)}</td>
        <td>${escapeHtml(p.houseNumber)}</td>
        <td>${formatMoney(p.amount)}</td>
        <td>${formatMoney(p.rentAmount)}</td>
        <td>${formatMoney(p.waterAmount)}</td>
        <td>${formatMoney(p.garbageAmount)}</td>
        <td>${formatMoney(p.totalDue)}</td>
        <td>${formatMoney(p.balance)}</td>
      </tr>
    `)
    .join("");
}

async function loadWaterBills() {
  const data = await api("/api/water-bills");
  state.waterBills = data.waterBills || [];
  renderWaterBills();
}

function renderWaterBills() {
  if (!els.waterBillTable) return;
  if (!state.waterBills.length) {
    els.waterBillTable.innerHTML = `<tr><td colspan="6"><div class="empty-state">No water bills logged yet.</div></td></tr>`;
    return;
  }

  els.waterBillTable.innerHTML = state.waterBills
    .map((bill) => `
      <tr>
        <td>${escapeHtml(bill.houseName || bill.houseNumber)}</td>
        <td>${escapeHtml(`${bill.billMonth || ""} ${bill.billYear || ""}`)}</td>
        <td>${formatDate(bill.readingDate)}</td>
        <td>${escapeHtml(bill.unitsUsed.toString())}</td>
        <td>${formatMoney(bill.waterAmount)}</td>
        <td>${escapeHtml(bill.notes || "")}</td>
      </tr>
    `)
    .join("");
}

els.newPaymentButton.addEventListener("click", () => {
  els.paymentForm.reset();
  els.paymentDialog.showModal();
});

els.newWaterBillButton?.addEventListener("click", () => {
  els.waterBillForm.reset();
  els.waterBillDialog.showModal();
});

els.closeWaterBillDialogButton?.addEventListener("click", () => els.waterBillDialog.close());

els.closePaymentDialogButton.addEventListener("click", () => els.paymentDialog.close());

els.paymentForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const payload = {
    tenantId: els.paymentTenantInput.value,
    amount: els.paymentAmountInput.value,
    paymentDate: els.paymentDateInput.value,
    waterAmount: Number(els.paymentWaterInput.value || 0),
    garbageAmount: Number(els.paymentGarbageInput.value || 0)
  };
  await api("/api/payments", { method: "POST", body: JSON.stringify(payload) });
  els.paymentDialog.close();
  showToast("Payment recorded");
  await loadPayments();
});

els.waterBillForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const payload = {
    houseId: els.waterBillHouseInput.value,
    billMonth: els.waterBillMonthInput.value.trim(),
    billYear: Number(els.waterBillYearInput.value),
    readingDate: els.waterBillReadingDateInput.value,
    previousReading: Number(els.waterBillPreviousInput.value),
    currentReading: Number(els.waterBillCurrentInput.value),
    waterAmount: Number(els.waterBillAmountInput.value || 0),
    notes: els.waterBillNotesInput.value.trim()
  };
  await api("/api/water-bills", { method: "POST", body: JSON.stringify(payload) });
  els.waterBillDialog.close();
  showToast("Water bill logged");
  await loadWaterBills();
});

els.reportForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const params = new URLSearchParams({
    type: els.reportTypeInput.value,
    from: els.reportFromInput.value || "",
    to: els.reportToInput.value || ""
  });

  const data = await api(`/api/reports?${params.toString()}`);
  renderReport(els.reportTypeInput.value, data.rows || []);
});

function renderReport(type, rows) {
  const headers = {
    "rent-collection": ["Tenant", "Amount paid", "Date", "Balance"],
    "unpaid-rent": ["Tenant", "House", "Balance due"],
    "tenant-summary": ["Tenant", "House", "Rent status", "Move-in date"]
  }[type] || [];

  els.reportTableHead.innerHTML = `<tr>${headers.map((h) => `<th>${h}</th>`).join("")}</tr>`;

  if (rows.length === 0) {
    els.reportTable.innerHTML = `<tr><td colspan="${headers.length}"><div class="empty-state">No data for this report.</div></td></tr>`;
    return;
  }

  els.reportTable.innerHTML = rows
    .map((row) => `<tr>${Object.values(row).map((v) => `<td>${escapeHtml(v)}</td>`).join("")}</tr>`)
    .join("");
}

loadUser();
