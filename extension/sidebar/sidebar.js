/**
 * Sidebar JS — main interaction logic.
 * Communicates with background service worker via chrome.runtime.sendMessage.
 * Communicates with content script via window.parent.postMessage.
 */

// ─── State ────────────────────────────────────────────────────────────────────

let pageContext = null;       // { job_title, company, description, fields, url, platform }
let currentField = null;      // field being suggested for
let currentSuggestion = "";   // last suggestion text
let detectedJobType = "";     // job type extracted on modal open
let logResumeAttachment = null; // attachment selected in log modal resume dropdown
let historyDebounce = null;
let chatHistory = [];    // [{role: "user"|"assistant", content: "..."}]
let chatModelId = "";
let chatIsSending = false;

// ─── Utility ──────────────────────────────────────────────────────────────────

function isExtensionValid() {
  try { return !!chrome.runtime?.id; } catch { return false; }
}

function sendMsg(type, payload = {}) {
  return new Promise((resolve, reject) => {
    if (!isExtensionValid()) {
      reject(new Error("Extension context invalidated — please refresh this page."));
      return;
    }
    try {
      chrome.runtime.sendMessage({ type, payload }, (resp) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
        } else if (!resp || !resp.ok) {
          reject(new Error(resp?.error || "Unknown error"));
        } else {
          resolve(resp);
        }
      });
    } catch (e) {
      reject(e);
    }
  });
}

function showToast(msg, type = "default") {
  const t = document.getElementById("toast");
  t.textContent = msg;
  t.className = `toast show ${type}`;
  setTimeout(() => { t.className = "toast"; }, 3000);
}

function setStatus(state) {
  const dot = document.getElementById("statusDot");
  dot.className = `status-dot ${state}`;
  dot.title = state === "connected" ? "Server connected" :
              state === "error"     ? "Server offline"  : "Checking...";
}

function readFileAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result); // data URL: "data:application/pdf;base64,..."
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

// ─── Server health check ──────────────────────────────────────────────────────

let _serverWasOffline = false;

async function checkServer() {
  try {
    const resp = await sendMsg("CHECK_SERVER");
    const ok = resp.status === "ok";
    setStatus(ok ? "connected" : "error");
    // If server just came back online, reload chat models
    if (ok && _serverWasOffline) {
      _serverWasOffline = false;
      initChatTab();
    }
    if (!ok) _serverWasOffline = true;
  } catch {
    setStatus("error");
    _serverWasOffline = true;
  }
}

// ─── Load page context ────────────────────────────────────────────────────────

function requestPageContext() {
  window.parent.postMessage({ type: "GET_PAGE_CONTEXT" }, "*");
}

window.addEventListener("message", (event) => {
  if (event.data?.type === "PAGE_CONTEXT") {
    pageContext = event.data.context;
    updateHeader();
    renderFields();
  }
});

async function loadPageContext() {
  // Try stored context first
  try {
    const resp = await sendMsg("GET_JOB_CONTEXT");
    if (resp.jobContext) {
      pageContext = resp.jobContext;
      updateHeader();
      renderFields();
      return;
    }
  } catch { /* fallback to postMessage */ }
  requestPageContext();
}

function updateHeader() {
  if (!pageContext) return;
  document.getElementById("jobCompany").textContent = pageContext.company || "Unknown Company";
  document.getElementById("jobTitle").textContent   = pageContext.job_title || "";
}

async function loadActiveResume() {
  try {
    const resp = await sendMsg("GET_ACTIVE_RESUME");
    const text = document.getElementById("resumeBadgeText");
    if (text) text.textContent = resp.active_resume || "No resume set";
  } catch { /* ignore */ }
}

// ─── Field rendering ──────────────────────────────────────────────────────────

function renderFields() {
  const list = document.getElementById("fieldsList");
  const fields = pageContext?.fields || [];

  if (!fields.length) {
    list.innerHTML = `<div class="empty-state"><div class="icon">📭</div><div class="text">No form fields detected on this page.</div></div>`;
    return;
  }

  const questions = fields.filter(f => f.isQuestion);
  const basics    = fields.filter(f => !f.isQuestion);
  let html = "";

  if (questions.length) {
    html += `<div class="section-label">Questions (${questions.length})</div>`;
    html += questions.map((f, i) => fieldHTML(f, `q-${i}`, true)).join("");
  }
  if (basics.length) {
    html += `<div class="section-label">Basic Fields (${basics.length})</div>`;
    html += basics.map((f, i) => fieldHTML(f, `b-${i}`, false)).join("");
  }

  list.innerHTML = html;

  // Bind suggest buttons
  list.querySelectorAll("[data-suggest]").forEach(btn => {
    btn.addEventListener("click", () => {
      const idx = parseInt(btn.dataset.suggest);
      const isQ = btn.dataset.type === "q";
      const field = isQ ? questions[idx] : basics[idx];
      openSuggestionPanel(field);
    });
  });
}

function fieldHTML(field, id, isQ) {
  const val = field.currentValue ? `<div class="field-value">${escHtml(field.currentValue.slice(0, 80))}</div>` : "";
  const suggestBtn = `<button class="btn btn-primary btn-sm" data-suggest="${id.split('-')[1]}" data-type="${id.split('-')[0]}">✨ Suggest</button>`;
  return `
    <div class="field-item ${isQ ? 'question' : ''}">
      <div class="field-header">
        <div class="field-label">${escHtml(field.label)}</div>
        ${isQ ? suggestBtn : ''}
      </div>
      ${val}
    </div>`;
}

function escHtml(str) {
  return String(str).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// ─── Suggestion panel ─────────────────────────────────────────────────────────

async function openSuggestionPanel(field) {
  currentField = field;
  const panel = document.getElementById("suggestionPanel");
  const qEl   = document.getElementById("suggestionQuestion");
  const tEl   = document.getElementById("suggestionText");

  panel.classList.add("visible");
  qEl.textContent = field.label;
  tEl.textContent = "Generating...";

  document.getElementById("btnAccept").disabled = true;
  document.getElementById("btnRegenerate").disabled = true;

  await fetchSuggestion(field);
}

async function fetchSuggestion(field) {
  const tEl = document.getElementById("suggestionText");
  try {
    const resp = await sendMsg("GET_SUGGESTION", {
      field_label: field.label,
      field_type: field.type,
      page_context: pageContext || {},
    });
    currentSuggestion = resp.suggestion || "";
    tEl.textContent = currentSuggestion;
    document.getElementById("btnAccept").disabled = false;
    document.getElementById("btnRegenerate").disabled = false;
  } catch (e) {
    tEl.textContent = `Error: ${e.message}`;
  }
}

let suggestionEditMode = false;

function toggleSuggestionEdit() {
  const textEl = document.getElementById("suggestionText");
  const editBtn = document.getElementById("btnEditSuggestion");

  if (!suggestionEditMode) {
    // Enter edit mode: swap div → textarea
    const ta = document.createElement("textarea");
    ta.id = "suggestionEditArea";
    ta.className = "suggestion-edit-area";
    ta.value = currentSuggestion;
    textEl.replaceWith(ta);
    ta.focus();
    editBtn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg> Done`;
    editBtn.classList.replace("btn-ghost", "btn-success");
    suggestionEditMode = true;
  } else {
    // Exit edit mode: save edited text, swap back
    const ta = document.getElementById("suggestionEditArea");
    currentSuggestion = ta.value;
    const div = document.createElement("div");
    div.id = "suggestionText";
    div.className = "suggestion-text";
    div.textContent = currentSuggestion;
    ta.replaceWith(div);
    editBtn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg> Edit`;
    editBtn.classList.replace("btn-success", "btn-ghost");
    suggestionEditMode = false;
  }
}

function acceptSuggestion() {
  // If still in edit mode, commit the edits first
  if (suggestionEditMode) {
    const ta = document.getElementById("suggestionEditArea");
    if (ta) currentSuggestion = ta.value;
  }
  if (!currentField || !currentSuggestion) return;

  window.parent.postMessage({
    type: "FILL_FIELD",
    label: currentField.label,
    value: currentSuggestion,
  }, "*");

  // Save to memory
  sendMsg("SAVE_MEMORY", {
    question: currentField.label,
    answer: currentSuggestion,
    metadata: {
      company: pageContext?.company || "",
      role: pageContext?.job_title || "",
      platform: pageContext?.platform || "",
    },
  }).catch(() => {});

  showToast("Filled and saved!", "success");
  closeSuggestionPanel();
}

function closeSuggestionPanel() {
  // If in edit mode, restore the div before hiding
  if (suggestionEditMode) {
    const ta = document.getElementById("suggestionEditArea");
    if (ta) {
      const div = document.createElement("div");
      div.id = "suggestionText";
      div.className = "suggestion-text";
      ta.replaceWith(div);
    }
    const editBtn = document.getElementById("btnEditSuggestion");
    editBtn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg> Edit`;
    editBtn.classList.replace("btn-success", "btn-ghost");
    suggestionEditMode = false;
  }
  document.getElementById("suggestionPanel").classList.remove("visible");
  currentField = null;
  currentSuggestion = "";
}

// ─── Auto-fill all ────────────────────────────────────────────────────────────

async function autoFillAll() {
  const btn = document.getElementById("btnAutoFill");
  btn.disabled = true;
  btn.innerHTML = `<span class="spinner"></span> Filling...`;

  const questions = (pageContext?.fields || []).filter(f => f.isQuestion && !f.currentValue);
  let filled = 0;

  for (const field of questions) {
    try {
      const resp = await sendMsg("GET_SUGGESTION", {
        field_label: field.label,
        field_type: field.type,
        page_context: pageContext || {},
      });
      const suggestion = resp.suggestion || "";
      if (suggestion) {
        window.parent.postMessage({ type: "FILL_FIELD", label: field.label, value: suggestion }, "*");
        await sendMsg("SAVE_MEMORY", {
          question: field.label,
          answer: suggestion,
          metadata: { company: pageContext?.company, role: pageContext?.job_title },
        }).catch(() => {});
        filled++;
      }
    } catch { /* skip field on error */ }
  }

  btn.disabled = false;
  btn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg> Fill All`;
  showToast(filled ? `Filled ${filled} fields!` : "No empty question fields found.", filled ? "success" : "default");
  loadPageContext(); // refresh values
}

// ─── History tab ──────────────────────────────────────────────────────────────

async function loadHistory(query = "") {
  const list = document.getElementById("historyList");
  try {
    let entries;
    if (query.trim()) {
      const resp = await sendMsg("SEARCH_MEMORY", { query, top_k: 20 });
      entries = resp.results;
    } else {
      const resp = await sendMsg("GET_MEMORY");
      entries = resp.entries;
    }

    if (!entries.length) {
      list.innerHTML = `<div class="empty-state"><div class="empty-icon"><svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="9" y1="13" x2="15" y2="13"/><line x1="9" y1="17" x2="12" y2="17"/></svg></div><div class="empty-title">No saved answers${query ? ' for "' + escHtml(query) + '"' : ''}</div><div class="empty-text">Answers you accept will be saved here.</div></div>`;
      return;
    }

    list.innerHTML = entries.map(e => `
      <div class="history-item" data-id="${e.id}" data-answer="${escHtml(e.answer)}">
        <div class="history-question">${escHtml(e.question)}</div>
        <div class="history-answer">${escHtml(e.answer.slice(0, 120))}${e.answer.length > 120 ? "..." : ""}</div>
        <div class="history-meta">
          <span>${e.metadata?.company || ""}</span>
          <span>Used ${e.used_count}×</span>
        </div>
      </div>
    `).join("");

    list.querySelectorAll(".history-item").forEach(item => {
      item.addEventListener("click", () => {
        navigator.clipboard.writeText(item.dataset.answer).catch(() => {});
        showToast("Copied to clipboard!", "success");
      });
    });
  } catch (e) {
    list.innerHTML = `<div class="empty-state"><div class="text">Error loading history: ${escHtml(e.message)}</div></div>`;
  }
}

// ─── Log Application Modal ────────────────────────────────────────────────────

async function openLogModal() {
  // Pre-fill company & role from page context; fall back to domain name if company undetected
  let company = pageContext?.company || "";
  if (!company && pageContext?.url) {
    try {
      const host = new URL(pageContext.url).hostname.replace(/^www\./, "");
      company = host.split(".")[0];
      company = company.charAt(0).toUpperCase() + company.slice(1);
    } catch (_) {}
  }
  document.getElementById("logCompany").value = company;
  document.getElementById("logRole").value    = pageContext?.job_title || "";
  document.getElementById("logNotes").value   = "";
  document.getElementById("logJobDesc").value = pageContext?.description || "";
  document.getElementById("logCoverLetter").value = "";
  clFile = null;
  document.getElementById("clFileName").textContent = "";
  document.getElementById("logConfidence").value = "5";
  document.getElementById("logConfidenceValue").textContent = "5 / 10";
  document.getElementById("logJobType").textContent = "Detecting...";
  logResumeAttachment = null;

  // Populate resume dropdown
  await populateResumeSelect();

  document.getElementById("logModal").classList.add("visible");

  // Detect job type in background
  detectJobType();
}

async function detectJobType() {
  const jobTypeEl = document.getElementById("logJobType");
  const desc = pageContext?.description || "";
  if (!desc) {
    jobTypeEl.textContent = "Not found in job description";
    detectedJobType = "";
    return;
  }
  try {
    // We pass job_type as empty — server will detect it via /log_application
    // For preview, we call suggest with a special internal signal
    // Instead, we show "Will be auto-detected" and let the server handle it
    jobTypeEl.textContent = "Will be detected from JD automatically";
    detectedJobType = "";
  } catch {
    jobTypeEl.textContent = "Not found";
    detectedJobType = "";
  }
}

function closeLogModal() {
  document.getElementById("logModal").classList.remove("visible");
}

async function populateResumeSelect() {
  const sel = document.getElementById("resumeSelect");
  if (!sel) return;
  sel.innerHTML = '<option value="">— No resume —</option>';
  logResumeAttachment = null;
  try {
    const res = await sendMsg("GET_RESUMES");
    const resumes = res?.resumes || [];
    resumes.forEach(r => {
      const opt = document.createElement("option");
      opt.value = r.name;
      opt.textContent = r.name + (r.is_active ? " (active)" : "");
      sel.appendChild(opt);
      if (r.is_active) {
        sel.value = r.name;
        logResumeAttachment = buildAttachment(r);
      }
    });
  } catch (_) {}
}

function buildAttachment(resume) {
  const att = { type: resume.type, name: resume.name };
  if (resume.url) att.url = resume.url;
  return att;
}

async function submitLog() {
  const company    = document.getElementById("logCompany").value.trim();
  const role       = document.getElementById("logRole").value.trim();
  const notes      = document.getElementById("logNotes").value.trim();
  const confidence = parseInt(document.getElementById("logConfidence").value, 10);

  if (!company || !role) {
    showToast("Company and role are required.", "error");
    return;
  }

  const btn = document.getElementById("btnSubmitLog");
  btn.disabled = true;
  btn.innerHTML = `<span class="spinner"></span> Logging...`;

  // Use the resume selected in the dropdown
  const resumeAttachment = logResumeAttachment || null;

  try {

    const jobDesc     = document.getElementById("logJobDesc").value.trim();
    const coverLetter = document.getElementById("logCoverLetter").value.trim();

    // Log the application
    await sendMsg("LOG_APPLICATION", {
      company,
      role,
      notes,
      confidence,
      job_description: jobDesc,
      cover_letter: coverLetter,
      resume_attachment: resumeAttachment,
      job_url: pageContext?.url || "",
      platform: pageContext?.platform || "",
      page_context: {
        description: jobDesc || pageContext?.description || "",
        job_title: pageContext?.job_title || "",
        company: pageContext?.company || "",
      },
    });

    showToast(`Logged: ${company} — ${role}`, "success");
    closeLogModal();
  } catch (e) {
    showToast(`Error: ${e.message}`, "error");
  } finally {
    btn.disabled = false;
    btn.textContent = "Log It";
  }
}

// ─── Resume Manager ───────────────────────────────────────────────────────────

let clFile = null;   // cover letter PDF file

let mgPdfFile = null;
let mgActiveTab = "pdf";

async function openResumeModal() {
  mgPdfFile = null;
  document.getElementById("mgPdfFileName").textContent = "";
  document.getElementById("mgPdfName").value = "";
  document.getElementById("mgResumeUrl").value = "";
  document.getElementById("mgUrlName").value = "";
  document.getElementById("mgResumeText").value = "";
  document.getElementById("mgTextName").value = "";
  switchMgTab("pdf");
  document.getElementById("resumeModal").classList.add("visible");
  await loadResumeList();
}

function closeResumeModal() {
  document.getElementById("resumeModal").classList.remove("visible");
}

function switchMgTab(tab) {
  mgActiveTab = tab;
  document.querySelectorAll("[data-mgtab]").forEach(btn => {
    btn.classList.toggle("active", btn.dataset.mgtab === tab);
  });
  document.querySelectorAll("[id^='mgtab-']").forEach(el => {
    el.classList.toggle("active", el.id === `mgtab-${tab}`);
  });
}

async function loadResumeList() {
  const listEl = document.getElementById("resumeList");
  listEl.innerHTML = `<div style="font-size:11px;color:#9ca3af;padding:4px 0">Loading...</div>`;
  try {
    const resp = await sendMsg("GET_RESUMES");
    const resumes = resp.resumes || [];
    if (!resumes.length) {
      listEl.innerHTML = `<div class="empty-state" style="padding:12px 0"><div class="text">No resumes saved yet</div></div>`;
      return;
    }
    listEl.innerHTML = resumes.map(r => `
      <div class="resume-item ${r.is_active ? 'active-resume' : ''}">
        <div class="resume-item-name">${escHtml(r.name)}</div>
        <span class="resume-item-type">${escHtml(r.type)}</span>
        ${r.is_active ? '<span class="active-tag">Active</span>' : `<button class="btn btn-secondary btn-sm" data-set-resume="${escHtml(r.name)}">Set Active</button>`}
        <button class="btn btn-danger btn-sm" data-del-resume="${escHtml(r.name)}">✕</button>
      </div>
    `).join("");

    listEl.querySelectorAll("[data-set-resume]").forEach(btn => {
      btn.addEventListener("click", async () => {
        await sendMsg("SET_ACTIVE_RESUME", { name: btn.dataset.setResume });
        await loadActiveResume();
        await loadResumeList();
        showToast(`Active resume: ${btn.dataset.setResume}`, "success");
      });
    });
    listEl.querySelectorAll("[data-del-resume]").forEach(btn => {
      btn.addEventListener("click", async () => {
        await sendMsg("DELETE_RESUME", { name: btn.dataset.delResume });
        await loadActiveResume();
        await loadResumeList();
        showToast("Resume deleted", "default");
      });
    });
  } catch (e) {
    listEl.innerHTML = `<div style="font-size:11px;color:#ef4444">${escHtml(e.message)}</div>`;
  }
}

async function uploadAndSetResume() {
  const btn = document.getElementById("btnUploadResume");
  btn.disabled = true;
  btn.innerHTML = `<span class="spinner"></span> Uploading...`;

  try {
    let attachment = null;

    if (mgActiveTab === "pdf") {
      if (!mgPdfFile) { showToast("Please select a PDF file.", "error"); return; }
      const name = document.getElementById("mgPdfName").value.trim() || mgPdfFile.name.replace(".pdf", "");
      const b64 = await readFileAsBase64(mgPdfFile);
      const resp = await sendMsg("UPLOAD_RESUME_PDF", { name, file_data: b64, filename: mgPdfFile.name });
      attachment = { ...resp.attachment, name };
    } else if (mgActiveTab === "url") {
      const url  = document.getElementById("mgResumeUrl").value.trim();
      const name = document.getElementById("mgUrlName").value.trim() || "resume";
      if (!url) { showToast("Please enter a URL.", "error"); return; }
      const resp = await sendMsg("UPLOAD_RESUME_URL", { name, url });
      attachment = { ...resp.attachment, name };
    } else {
      const content = document.getElementById("mgResumeText").value.trim();
      const name    = document.getElementById("mgTextName").value.trim() || "resume";
      if (!content) { showToast("Please paste resume text.", "error"); return; }
      const resp = await sendMsg("UPLOAD_RESUME_TEXT", { name, content });
      attachment = { ...resp.attachment, name };
    }

    if (attachment?.name) {
      await sendMsg("SET_ACTIVE_RESUME", { name: attachment.name });
      await loadActiveResume();
      await loadResumeList();
      showToast(`Resume "${attachment.name}" uploaded & set active!`, "success");
    }
  } catch (e) {
    if (e.message.includes("context invalidated") || e.message.includes("Extension context")) {
      showToast("Extension reloaded — please close and reopen the sidebar.", "error");
    } else {
      showToast(`Upload failed: ${e.message}`, "error");
    }
  } finally {
    btn.disabled = false;
    btn.textContent = "Upload & Set Active";
  }
}

// ─── Chat tab ─────────────────────────────────────────────────────────────────

async function initChatTab() {
  const select = document.getElementById("chatModelSelect");
  try {
    const resp = await sendMsg("GET_CHAT_MODELS");
    const models = resp.models || [];
    if (!models.length) {
      select.innerHTML = `<option value="">No models configured</option>`;
      return;
    }
    select.innerHTML = models.map(m =>
      `<option value="${escHtml(m.id)}">${escHtml(m.name)}</option>`
    ).join("");
    chatModelId = models[0].id;
    select.value = chatModelId;
  } catch {
    select.innerHTML = `<option value="">Server offline — start server</option>`;
    // Show retry button in chat messages area
    const msgs = document.getElementById("chatMessages");
    msgs.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
        </div>
        <div class="empty-title">Server offline</div>
        <div class="empty-text">Run <code style="background:#eee;padding:1px 5px;border-radius:4px;font-size:11px">start.bat</code> to start the backend, then retry.</div>
        <button class="btn btn-primary btn-sm" style="margin-top:8px" id="btnRetryModels">Retry</button>
      </div>`;
    document.getElementById("btnRetryModels")?.addEventListener("click", initChatTab);
  }

  // Update context bar
  updateChatContext();
}

function updateChatContext() {
  const el = document.getElementById("chatContext");
  if (pageContext?.company || pageContext?.job_title) {
    el.textContent = `${pageContext.company || ""}${pageContext.company && pageContext.job_title ? " · " : ""}${pageContext.job_title || ""}`;
  } else {
    el.textContent = "No job detected on current page";
  }
}

function renderChatBubble(role, text) {
  const msgs = document.getElementById("chatMessages");

  // Remove empty-state if present
  const empty = msgs.querySelector(".empty-state");
  if (empty) empty.remove();

  const wrap = document.createElement("div");
  wrap.className = `chat-bubble-wrap ${role}`;

  const bubble = document.createElement("div");
  bubble.className = `chat-bubble ${role}`;
  bubble.textContent = text;
  wrap.appendChild(bubble);

  if (role === "assistant") {
    const actions = document.createElement("div");
    actions.className = "bubble-actions";

    const copyBtn = document.createElement("button");
    copyBtn.className = "btn btn-secondary btn-sm";
    copyBtn.textContent = "Copy";
    copyBtn.addEventListener("click", () => {
      navigator.clipboard.writeText(text).catch(() => {});
      showToast("Copied!", "success");
    });

    const useBtn = document.createElement("button");
    useBtn.className = "btn btn-primary btn-sm";
    useBtn.textContent = "Use as Answer";
    useBtn.addEventListener("click", () => {
      // Open suggestion panel pre-filled with this text
      document.getElementById("suggestionQuestion").textContent = "From Chat";
      document.getElementById("suggestionText").textContent = text;
      currentSuggestion = text;
      document.getElementById("btnAccept").disabled = false;
      document.getElementById("btnRegenerate").disabled = true;
      document.getElementById("suggestionPanel").classList.add("visible");
      // Switch to Fields tab so the panel is visible
      document.querySelectorAll(".tab-btn").forEach(b => b.classList.remove("active"));
      document.querySelectorAll(".tab-content").forEach(c => c.classList.remove("active"));
      document.querySelector('[data-tab="fields"]').classList.add("active");
      document.getElementById("tab-fields").classList.add("active");
    });

    actions.appendChild(copyBtn);
    actions.appendChild(useBtn);
    wrap.appendChild(actions);
  }

  msgs.appendChild(wrap);
  msgs.scrollTop = msgs.scrollHeight;
}

async function sendChatMessage() {
  if (chatIsSending) return;
  const input = document.getElementById("chatInput");
  const text = input.value.trim();
  if (!text) return;

  const model = document.getElementById("chatModelSelect").value;
  if (!model) {
    showToast("Please select a model first", "error");
    return;
  }

  input.value = "";
  chatIsSending = true;
  document.getElementById("btnSendChat").disabled = true;

  chatHistory.push({ role: "user", content: text });
  renderChatBubble("user", text);

  // Thinking indicator
  const msgs = document.getElementById("chatMessages");
  const thinking = document.createElement("div");
  thinking.className = "chat-thinking";
  thinking.innerHTML = `<span>Thinking</span><div class="thinking-dots"><span></span><span></span><span></span></div>`;
  msgs.appendChild(thinking);
  msgs.scrollTop = msgs.scrollHeight;

  try {
    const company = pageContext?.company || "";
    const role    = pageContext?.job_title || "";
    const system  = company || role
      ? `You are a helpful job application assistant. The user is applying for: ${role}${role && company ? " at " : ""}${company}. Help them answer application questions clearly and professionally.`
      : "You are a helpful job application assistant.";

    const resp = await sendMsg("CHAT_MESSAGE", {
      model,
      messages: chatHistory,
      system,
    });
    const reply = resp.reply || "";
    chatHistory.push({ role: "assistant", content: reply });
    thinking.remove();
    renderChatBubble("assistant", reply);
  } catch (e) {
    thinking.remove();
    renderChatBubble("assistant", `Error: ${e.message}`);
    // Remove the failed user message from history
    chatHistory.pop();
  } finally {
    chatIsSending = false;
    document.getElementById("btnSendChat").disabled = false;
  }
}

async function saveChatToHistory() {
  if (!chatHistory.length) {
    showToast("Nothing to save — chat is empty.", "error");
    return;
  }
  const company = pageContext?.company || "Unknown";
  const role    = pageContext?.job_title || "Unknown";

  // Format as readable transcript
  const transcript = chatHistory.map(m =>
    `${m.role === "user" ? "You" : "AI"}: ${m.content}`
  ).join("\n\n");

  const btn = document.getElementById("btnSaveChat");
  btn.disabled = true;

  try {
    // Save to memory / history tab
    await sendMsg("SAVE_MEMORY", {
      question: `[Chat] ${company} — ${role}`,
      answer: transcript,
      metadata: {
        company,
        role,
        platform: pageContext?.platform || "",
        type: "chat",
      },
    });

    // Append full transcript to Sheets Notes — fuzzy match so minor name differences don't break it
    const appsResp = await sendMsg("GET_APPLICATIONS");
    const apps = appsResp.applications || [];
    const norm = s => (s || "").toLowerCase().trim().replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ");
    const fuzzy = (a, b) => { const na = norm(a), nb = norm(b); return na === nb || na.includes(nb) || nb.includes(na); };
    const match = apps.find(a => fuzzy(a.company, company) && fuzzy(a.role, role))
                || apps.find(a => fuzzy(a.company, company)); // fallback: company-only match

    if (match?.application_id) {
      const date = new Date().toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
      await sendMsg("PATCH_NOTES", {
        application_id: match.application_id,
        append: `--- Chat Session (${date}) ---\n${transcript}`,
      });
      showToast("Chat saved to History & Sheets!", "success");
    } else {
      showToast("Saved to History. Log this application first to save to Sheets.", "default");
    }
  } catch (e) {
    showToast(`Save failed: ${e.message}`, "error");
  } finally {
    btn.disabled = false;
  }
}

function clearChat() {
  chatHistory = [];
  const msgs = document.getElementById("chatMessages");
  msgs.innerHTML = `<div class="empty-state"><div class="empty-icon"><svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg></div><div class="empty-title">Ask anything</div><div class="empty-text">Paste a job question and get a tailored answer based on your resume.</div></div>`;
}

// ─── Event listeners ──────────────────────────────────────────────────────────

document.addEventListener("DOMContentLoaded", async () => {
  // Tabs
  document.querySelectorAll(".tab-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".tab-btn").forEach(b => b.classList.remove("active"));
      document.querySelectorAll(".tab-content").forEach(c => c.classList.remove("active"));
      btn.classList.add("active");
      document.getElementById(`tab-${btn.dataset.tab}`).classList.add("active");
      if (btn.dataset.tab === "history") loadHistory();
      if (btn.dataset.tab === "chat") updateChatContext();
    });
  });

  // Fields actions
  document.getElementById("btnRefresh").addEventListener("click", () => {
    requestPageContext();
  });
  document.getElementById("btnAutoFill").addEventListener("click", autoFillAll);

  // Suggestion panel
  document.getElementById("btnAccept").addEventListener("click", acceptSuggestion);
  document.getElementById("btnEditSuggestion").addEventListener("click", toggleSuggestionEdit);
  document.getElementById("btnRegenerate").addEventListener("click", () => {
    if (suggestionEditMode) toggleSuggestionEdit(); // exit edit mode first
    if (currentField) fetchSuggestion(currentField);
  });
  document.getElementById("btnClosePanel").addEventListener("click", closeSuggestionPanel);

  // Resume modal
  document.getElementById("resumeBadge").addEventListener("click", openResumeModal);
  document.getElementById("btnCancelResume").addEventListener("click", closeResumeModal);
  document.getElementById("resumeModal").addEventListener("click", (e) => {
    if (e.target === document.getElementById("resumeModal")) closeResumeModal();
  });
  document.getElementById("btnUploadResume").addEventListener("click", uploadAndSetResume);
  document.querySelectorAll("[data-mgtab]").forEach(btn => {
    btn.addEventListener("click", () => switchMgTab(btn.dataset.mgtab));
  });
  document.getElementById("mgPdfFileInput").addEventListener("change", (e) => {
    mgPdfFile = e.target.files[0] || null;
    document.getElementById("mgPdfFileName").textContent = mgPdfFile ? `Selected: ${mgPdfFile.name}` : "";
  });

  // Log modal
  document.getElementById("btnLog").addEventListener("click", openLogModal);
  document.getElementById("btnCancelLog").addEventListener("click", closeLogModal);

  // Cover letter PDF upload
  document.getElementById("btnUploadCoverLetter").addEventListener("click", () => {
    document.getElementById("clFileInput").click();
  });
  document.getElementById("clFileInput").addEventListener("change", async (e) => {
    clFile = e.target.files[0] || null;
    if (!clFile) return;
    const nameEl = document.getElementById("clFileName");
    const btn = document.getElementById("btnUploadCoverLetter");
    nameEl.textContent = `Extracting text from ${clFile.name}…`;
    btn.disabled = true;
    try {
      const b64 = await readFileAsBase64(clFile);
      const resp = await sendMsg("EXTRACT_PDF_TEXT", { file_data: b64 });
      document.getElementById("logCoverLetter").value = resp.text || "";
      nameEl.textContent = `Loaded: ${clFile.name}`;
      showToast("Cover letter loaded from PDF!", "success");
    } catch (err) {
      nameEl.textContent = "";
      showToast(`PDF extraction failed: ${err.message}`, "error");
    } finally {
      btn.disabled = false;
      // Reset file input so the same file can be selected again
      e.target.value = "";
    }
  });

  document.getElementById("btnGenCoverLetter").addEventListener("click", async () => {
    const btn = document.getElementById("btnGenCoverLetter");
    const company = document.getElementById("logCompany").value.trim() || pageContext?.company || "";
    const role    = document.getElementById("logRole").value.trim() || pageContext?.job_title || "";
    const jd      = document.getElementById("logJobDesc").value.trim();
    if (!jd) {
      showToast("Add a job description first.", "error");
      return;
    }
    btn.disabled = true;
    btn.innerHTML = `<span class="spinner" style="border-color:rgba(71,82,196,.3);border-top-color:var(--brand)"></span> Generating...`;
    try {
      const resp = await sendMsg("GENERATE_COVER_LETTER", { company, role, job_description: jd });
      document.getElementById("logCoverLetter").value = resp.cover_letter || "";
      showToast("Cover letter generated!", "success");
    } catch (e) {
      showToast(`Error: ${e.message}`, "error");
    } finally {
      btn.disabled = false;
      btn.textContent = "Generate with AI";
    }
  });

  document.getElementById("btnSubmitLog").addEventListener("click", submitLog);

  // Confidence slider live label
  document.getElementById("logConfidence").addEventListener("input", (e) => {
    document.getElementById("logConfidenceValue").textContent = `${e.target.value} / 10`;
  });

  // Resume dropdown in log modal
  document.getElementById("resumeSelect").addEventListener("change", async (e) => {
    const name = e.target.value;
    if (!name) { logResumeAttachment = null; return; }
    try {
      const res = await sendMsg("GET_RESUMES");
      const resume = (res?.resumes || []).find(r => r.name === name);
      logResumeAttachment = resume ? buildAttachment(resume) : null;
    } catch (_) { logResumeAttachment = null; }
  });

  // History search
  document.getElementById("historySearch").addEventListener("input", (e) => {
    clearTimeout(historyDebounce);
    historyDebounce = setTimeout(() => loadHistory(e.target.value), 300);
  });

  // Close modal on overlay click
  document.getElementById("logModal").addEventListener("click", (e) => {
    if (e.target === document.getElementById("logModal")) closeLogModal();
  });

  // Chat
  document.getElementById("chatModelSelect").addEventListener("change", (e) => {
    chatModelId = e.target.value;
  });
  document.getElementById("btnSendChat").addEventListener("click", sendChatMessage);
  document.getElementById("btnClearChat").addEventListener("click", clearChat);
  document.getElementById("btnSaveChat").addEventListener("click", saveChatToHistory);
  document.getElementById("chatInput").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendChatMessage();
    }
  });

  // Init
  checkServer();
  setInterval(checkServer, 30000);
  await loadPageContext();
  await loadActiveResume();
  await initChatTab();
});
