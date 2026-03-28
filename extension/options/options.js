/**
 * Options page JS.
 * Handles: account/auth, API keys, server check, resume management, WhatsApp settings.
 */

// ─── Helpers ──────────────────────────────────────────────────────────────────

function sendMsg(type, payload = {}) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type, payload }, (resp) => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else if (!resp || !resp.ok) reject(new Error(resp?.error || "Error"));
      else resolve(resp);
    });
  });
}

function showToast(msg, type = "default") {
  const t = document.getElementById("toast");
  t.textContent = msg;
  t.className = `toast show ${type}`;
  setTimeout(() => { t.className = "toast"; }, 3500);
}

function escHtml(str) {
  return String(str || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function readFileAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

// ─── Account ──────────────────────────────────────────────────────────────────

async function loadAccount() {
  try {
    const resp = await sendMsg("GET_USER");
    showAccountInfo(resp.user);
  } catch {
    showAccountSignedOut();
  }
}

function showAccountInfo(user) {
  document.getElementById("acctNotLoggedIn").style.display = "none";
  const loggedIn = document.getElementById("acctLoggedIn");
  loggedIn.style.display = "flex";

  document.getElementById("acctName").textContent  = user.name  || "";
  document.getElementById("acctEmail").textContent = user.email || "";

  const img = document.getElementById("acctAvatar");
  const fallback = document.getElementById("acctAvatarFallback");
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

function showAccountSignedOut() {
  document.getElementById("acctLoggedIn").style.display = "none";
  document.getElementById("acctNotLoggedIn").style.display = "block";
}

async function handleSignIn() {
  const btn = document.getElementById("btnSignIn");
  btn.disabled = true;
  btn.textContent = "Signing in…";
  try {
    const resp = await sendMsg("LOGIN");
    showAccountInfo(resp.user);
    showToast("✅ Signed in as " + (resp.user.email || resp.user.name), "success");
    loadResumes();
  } catch (e) {
    showToast("Sign in failed: " + e.message, "error");
  } finally {
    btn.disabled = false;
    btn.textContent = "Sign in with Google";
  }
}

async function handleSignOut() {
  if (!confirm("Sign out of Job Assistant?")) return;
  try {
    await sendMsg("LOGOUT");
    showAccountSignedOut();
    showToast("Signed out", "success");
    document.getElementById("resumeList").innerHTML =
      `<div style="font-size:13px; color:#9ca3af; padding:8px 0;">Sign in to manage resumes.</div>`;
  } catch (e) {
    showToast("Error: " + e.message, "error");
  }
}

// ─── API Keys ─────────────────────────────────────────────────────────────────

async function loadApiKeys() {
  try {
    const resp = await sendMsg("GET_CONFIG");
    const cfg = resp.config || {};
    // Server returns masked values like "sk-ant-***" when a key is set; show placeholder if set
    if (cfg.has_anthropic_key) document.getElementById("anthropicKey").placeholder = "sk-ant-••••••• (saved)";
    if (cfg.has_openai_key)    document.getElementById("openaiKey").placeholder    = "sk-••••••• (saved)";
    if (cfg.has_gemini_key)    document.getElementById("geminiKey").placeholder    = "AIza••••••• (saved)";
  } catch { /* ignore if not logged in */ }
}

async function saveApiKeys() {
  const anthropic = document.getElementById("anthropicKey").value.trim();
  const openai    = document.getElementById("openaiKey").value.trim();
  const gemini    = document.getElementById("geminiKey").value.trim();

  const payload = {};
  if (anthropic) payload.anthropic_api_key = anthropic;
  if (openai)    payload.openai_api_key    = openai;
  if (gemini)    payload.gemini_api_key    = gemini;

  if (!Object.keys(payload).length) {
    showToast("Enter at least one API key to save.", "error");
    return;
  }

  const btn = document.getElementById("btnSaveApiKeys");
  btn.disabled = true;
  btn.textContent = "Saving…";
  try {
    await sendMsg("SAVE_CONFIG", payload);
    // Clear fields after save (keys are stored server-side)
    if (anthropic) { document.getElementById("anthropicKey").value = ""; document.getElementById("anthropicKey").placeholder = "sk-ant-••••••• (saved)"; }
    if (openai)    { document.getElementById("openaiKey").value    = ""; document.getElementById("openaiKey").placeholder    = "sk-••••••• (saved)"; }
    if (gemini)    { document.getElementById("geminiKey").value    = ""; document.getElementById("geminiKey").placeholder    = "AIza••••••• (saved)"; }
    showToast("✅ API keys saved!", "success");
  } catch (e) {
    showToast("Error saving keys: " + e.message, "error");
  } finally {
    btn.disabled = false;
    btn.textContent = "Save API Keys";
  }
}

// ─── Server & Connection ─────────────────────────────────────────────────────

async function checkServer() {
  const dot  = document.getElementById("serverDot");
  const text = document.getElementById("serverStatusText");
  dot.className = "dot";
  text.textContent = "Checking...";

  try {
    const resp = await sendMsg("CHECK_SERVER");
    const ok = resp.status === "ok";
    dot.className = ok ? "dot green" : "dot red";
    text.textContent = ok ? "Connected" : "Server error";
  } catch {
    dot.className = "dot red";
    text.textContent = "Cannot connect to server";
  }
}

// ─── Resume Management ────────────────────────────────────────────────────────

async function loadResumes() {
  const list = document.getElementById("resumeList");
  try {
    const resp = await sendMsg("GET_RESUMES");
    const resumes = resp.resumes || [];

if (!resumes.length) {
      list.innerHTML = `<div style="font-size:13px; color:#9ca3af; padding: 8px 0;">No resumes saved yet. Add one below.</div>`;
      return;
    }
    list.innerHTML = resumes.map(r => `
      <div class="resume-item ${r.is_active ? 'active-resume' : ''}" data-name="${escHtml(r.name)}">
        <div style="flex:1">
          <div style="display:flex; align-items:center; gap:8px">
            <span class="resume-name">${escHtml(r.name)}</span>
            <span class="resume-type-badge type-${r.type}">${r.type}</span>
            ${r.is_active ? '<span class="active-badge">Active</span>' : ''}
          </div>
          <div class="resume-preview">${escHtml(r.preview || "")}</div>
        </div>
        <div style="display:flex; gap:6px; flex-shrink:0">
          ${!r.is_active ? `<button class="btn btn-secondary btn-sm" data-action="activate" data-name="${escHtml(r.name)}">Set Active</button>` : ''}
          <button class="btn btn-danger btn-sm" data-action="delete" data-name="${escHtml(r.name)}">Delete</button>
        </div>
      </div>
    `).join("");

    list.querySelectorAll("[data-action='activate']").forEach(btn => {
      btn.addEventListener("click", () => activateResume(btn.dataset.name));
    });
    list.querySelectorAll("[data-action='delete']").forEach(btn => {
      btn.addEventListener("click", () => deleteResume(btn.dataset.name));
    });
  } catch (e) {
    list.innerHTML = `<div style="color:#ef4444; font-size:13px">Error: ${escHtml(e.message)}</div>`;
  }
}

async function activateResume(name) {
  try {
    await sendMsg("SET_ACTIVE_RESUME", { name });
    showToast(`✅ "${name}" set as active resume`, "success");
    loadResumes();
  } catch (e) {
    showToast(`Error: ${e.message}`, "error");
  }
}

async function deleteResume(name) {
  if (!confirm(`Delete resume "${name}"?`)) return;
  try {
    await sendMsg("DELETE_RESUME", { name });
    showToast(`Deleted "${name}"`, "success");
    loadResumes();
  } catch (e) {
    showToast(`Error: ${e.message}`, "error");
  }
}

let optActiveResumeTab = "pdf";
let optPdfFile = null;

function switchResumeTab(tab) {
  optActiveResumeTab = tab;
  document.querySelectorAll(".rtab-btn").forEach(btn => {
    btn.classList.toggle("active", btn.dataset.rtab === tab);
  });
  document.querySelectorAll(".rtab-content").forEach(el => {
    el.classList.toggle("active", el.id === `rtab-${tab}`);
  });
}

async function saveResume() {
  const name = document.getElementById("newResumeName").value.trim();
  if (!name) { showToast("Enter a resume name first.", "error"); return; }

  const btn = document.getElementById("btnSaveResume");
  btn.disabled = true;
  btn.textContent = "Saving...";

  try {
    if (optActiveResumeTab === "pdf") {
      if (!optPdfFile) { showToast("Select a PDF file first.", "error"); return; }
      const b64 = await readFileAsBase64(optPdfFile);
      await sendMsg("UPLOAD_RESUME_PDF", { name, file_data: b64, filename: optPdfFile.name });
    } else if (optActiveResumeTab === "url") {
      const url = document.getElementById("optResumeUrl").value.trim();
      if (!url) { showToast("Enter a URL first.", "error"); return; }
      await sendMsg("UPLOAD_RESUME_URL", { name, url });
    } else {
      const content = document.getElementById("optResumeText").value.trim();
      if (!content) { showToast("Paste resume text first.", "error"); return; }
      await sendMsg("UPLOAD_RESUME_TEXT", { name, content });
    }
    showToast(`✅ Resume "${name}" saved!`, "success");
    document.getElementById("newResumeName").value = "";
    optPdfFile = null;
    document.getElementById("optPdfSelected").textContent = "";
    loadResumes();
  } catch (e) {
    showToast(`Error: ${e.message}`, "error");
  } finally {
    btn.disabled = false;
    btn.textContent = "Save Resume";
  }
}

// ─── WhatsApp settings ────────────────────────────────────────────────────────

async function loadWhatsAppSettings() {
  try {
    const resp = await sendMsg("GET_CONFIG");
    const cfg = resp.config || {};
    const enabledEl = document.getElementById("dailyEnabled");
    if (enabledEl) enabledEl.checked = cfg.daily_summary_enabled !== false;
    const timeEl = document.getElementById("summaryTime");
    if (timeEl && cfg.daily_summary_time) timeEl.value = cfg.daily_summary_time;
    const tzEl = document.getElementById("summaryTimezone");
    if (tzEl && cfg.daily_summary_timezone) tzEl.value = cfg.daily_summary_timezone;
  } catch { /* ignore if not logged in */ }
}

async function saveWhatsAppSettings() {
  const btn = document.getElementById("btnSaveWhatsApp");
  btn.disabled = true;
  try {
    await sendMsg("SAVE_CONFIG", {
      daily_summary_enabled: document.getElementById("dailyEnabled").checked,
      daily_summary_time: document.getElementById("summaryTime").value,
      daily_summary_timezone: document.getElementById("summaryTimezone").value,
    });
    showToast("✅ Settings saved!", "success");
  } catch (e) {
    showToast(`Error: ${e.message}`, "error");
  } finally {
    btn.disabled = false;
  }
}

async function sendTestSummary() {
  const btn = document.getElementById("btnTestSummary");
  btn.disabled = true;
  btn.textContent = "Sending...";
  try {
    await sendMsg("TRIGGER_DAILY_SUMMARY");
    showToast("✅ Daily summary triggered!", "success");
  } catch (e) {
    showToast(`Error: ${e.message}`, "error");
  } finally {
    btn.disabled = false;
    btn.textContent = "Send Test Summary";
  }
}

async function sendTestWhatsApp() {
  const btn = document.getElementById("btnTestWhatsApp");
  btn.disabled = true;
  btn.textContent = "Sending...";
  try {
    await sendMsg("SEND_TEST_WHATSAPP");
    showToast("✅ Test message sent!", "success");
  } catch (e) {
    showToast(`Error: ${e.message}`, "error");
  } finally {
    btn.disabled = false;
    btn.textContent = "Send Test Message";
  }
}

// ─── Google Sheets ────────────────────────────────────────────────────────────

async function loadSheetsId() {
  try {
    const resp = await sendMsg("GET_CONFIG");
    const cfg = resp.config || {};
    if (cfg.sheets_id) {
      document.getElementById("sheetsId").value = cfg.sheets_id;
      document.getElementById("sheetsStatus").textContent = "✅ Connected";
      document.getElementById("sheetsStatus").style.color = "#22c55e";
    }
  } catch { /* ignore if not logged in */ }
}

async function saveSheetsId() {
  const sheetsId = document.getElementById("sheetsId").value.trim();
  const statusEl = document.getElementById("sheetsStatus");
  const btn = document.getElementById("btnSaveSheets");

  if (!sheetsId) {
    statusEl.textContent = "Please enter a Sheet ID";
    statusEl.style.color = "#ef4444";
    return;
  }

  btn.disabled = true;
  btn.textContent = "Saving…";
  try {
    await sendMsg("SAVE_CONFIG", { sheets_id: sheetsId });
    statusEl.textContent = "✅ Saved!";
    statusEl.style.color = "#22c55e";
  } catch (e) {
    statusEl.textContent = "Error: " + e.message;
    statusEl.style.color = "#ef4444";
  } finally {
    btn.disabled = false;
    btn.textContent = "Save Sheet ID";
  }
}

// ─── Init ─────────────────────────────────────────────────────────────────────

document.addEventListener("DOMContentLoaded", () => {
  // Account
  document.getElementById("btnSignIn").addEventListener("click", handleSignIn);
  document.getElementById("btnSignOut").addEventListener("click", handleSignOut);

  // API Keys
  document.getElementById("btnSaveApiKeys").addEventListener("click", saveApiKeys);

  // Google Sheets
  document.getElementById("btnSaveSheets").addEventListener("click", saveSheetsId);

  // Server check
  document.getElementById("btnCheckServer").addEventListener("click", checkServer);
  checkServer();

  // Resume tabs
  document.querySelectorAll(".rtab-btn").forEach(btn => {
    btn.addEventListener("click", () => switchResumeTab(btn.dataset.rtab));
  });

  // PDF file input
  document.getElementById("optPdfInput").addEventListener("change", (e) => {
    optPdfFile = e.target.files[0] || null;
    document.getElementById("optPdfSelected").textContent = optPdfFile ? `Selected: ${optPdfFile.name}` : "";
  });

  // Save resume
  document.getElementById("btnSaveResume").addEventListener("click", saveResume);

  // WhatsApp
  document.getElementById("btnSaveWhatsApp").addEventListener("click", saveWhatsAppSettings);
  document.getElementById("btnTestSummary").addEventListener("click", sendTestSummary);
  document.getElementById("btnTestWhatsApp").addEventListener("click", sendTestWhatsApp);

  // Load data
  loadAccount();
  loadApiKeys();
  loadSheetsId();
  loadResumes();
  loadWhatsAppSettings();
});
