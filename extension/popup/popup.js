function sendMsg(type, payload = {}) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type, payload }, (resp) => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else if (!resp || !resp.ok) reject(new Error(resp?.error || "Error"));
      else resolve(resp);
    });
  });
}

function statusClass(s) {
  return `status-${s}`;
}

function escHtml(str) {
  return String(str || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// ─── Auth UI ──────────────────────────────────────────────────────────────────

function showLoginScreen() {
  document.getElementById("loginScreen").style.display = "block";
  document.getElementById("mainContent").classList.remove("visible");
  document.getElementById("userBar").classList.remove("visible");
}

function showMainScreen(user) {
  document.getElementById("loginScreen").style.display = "none";
  document.getElementById("mainContent").classList.add("visible");

  // Populate user bar
  const bar = document.getElementById("userBar");
  bar.classList.add("visible");
  document.getElementById("userName").textContent = user.name || user.email || "";

  const img = document.getElementById("userAvatar");
  const fallback = document.getElementById("userAvatarFallback");
  if (user.picture_url) {
    img.src = user.picture_url;
    img.style.display = "block";
    fallback.style.display = "none";
  } else {
    fallback.textContent = (user.name || user.email || "?")[0].toUpperCase();
    fallback.style.display = "flex";
    img.style.display = "none";
  }
}

async function handleLogin() {
  const btn = document.getElementById("btnSignIn");
  const errEl = document.getElementById("loginError");
  btn.disabled = true;
  btn.textContent = "Signing in…";
  errEl.textContent = "";

  try {
    const resp = await sendMsg("LOGIN");
    showMainScreen(resp.user);
    await loadMainContent();
  } catch (e) {
    errEl.textContent = e.message || "Sign in failed. Please try again.";
  } finally {
    btn.disabled = false;
    btn.innerHTML = `
      <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" style="width:16px;height:16px;flex-shrink:0">
        <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/>
        <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
        <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.84z" fill="#FBBC05"/>
        <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
      </svg>
      Sign in with Google`;
  }
}

async function handleSignOut() {
  try {
    await sendMsg("LOGOUT");
  } catch { /* ignore */ }
  showLoginScreen();
}

// ─── Main content ─────────────────────────────────────────────────────────────

async function loadMainContent() {
  // Server status
  try {
    await sendMsg("CHECK_SERVER");
    document.getElementById("statusDot").className = "status-dot connected";
    document.getElementById("statusText").textContent = "Connected";
  } catch {
    document.getElementById("statusDot").className = "status-dot error";
    document.getElementById("statusText").textContent = "Server offline";
  }

  // Active resume
  try {
    const resp = await sendMsg("GET_ACTIVE_RESUME");
    document.getElementById("resumeBadge").textContent = resp.active_resume || "None";
  } catch { /* ignore */ }

  // Applications
  try {
    const resp = await sendMsg("GET_APPLICATIONS");
    const apps = resp.applications || [];

    document.getElementById("statTotal").textContent     = apps.length;
    document.getElementById("statInterview").textContent = apps.filter(a => a.status === "Interview").length;
    document.getElementById("statOffer").textContent     = apps.filter(a => a.status === "Offer").length;

    const list = document.getElementById("appList");
    const recent = apps.slice(0, 5);
    if (!recent.length) {
      list.innerHTML = `<div class="empty">No applications yet.</div>`;
    } else {
      list.innerHTML = recent.map(app => `
        <div class="app-item" data-url="${escHtml(app.job_url || '')}">
          <div>
            <div class="app-company">${escHtml(app.company)}</div>
            <div class="app-role">${escHtml(app.role)}</div>
            <div class="app-date">${escHtml(app.date_applied || '')}</div>
          </div>
          <span class="status-pill ${statusClass(app.status)}">${escHtml(app.status)}</span>
        </div>
      `).join("");

      list.querySelectorAll(".app-item").forEach(item => {
        item.addEventListener("click", () => {
          const url = item.dataset.url;
          if (url) chrome.tabs.create({ url });
        });
      });
    }
  } catch (e) {
    // If 401, user was signed out elsewhere
    if (e.message && e.message.includes("authenticated")) {
      showLoginScreen();
      return;
    }
    document.getElementById("appList").innerHTML = `<div class="empty">Could not load applications.</div>`;
  }
}

// ─── Init ──────────────────────────────────────────────────────────────────────

async function init() {
  document.getElementById("btnSignIn").addEventListener("click", handleLogin);
  document.getElementById("btnSignOut").addEventListener("click", handleSignOut);
  document.getElementById("settingsLink").addEventListener("click", (e) => {
    e.preventDefault();
    chrome.runtime.openOptionsPage();
  });

  // Check if already logged in
  try {
    const resp = await sendMsg("GET_USER");
    showMainScreen(resp.user);
    await loadMainContent();
  } catch (e) {
    showLoginScreen();
  }
}

init();
