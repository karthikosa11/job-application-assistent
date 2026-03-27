/**
 * Background service worker.
 * Routes messages from content scripts / sidebar / popup / options to the Flask backend.
 * Auth: JWT token stored in chrome.storage.local under "jwt_token".
 */

const SERVER_BASE = "http://127.0.0.1:8765"; // Change to your production URL when deploying
const DEFAULT_TIMEOUT = 30000;
const QUICK_TIMEOUT   = 10000;

// ─── Auth helpers ─────────────────────────────────────────────────────────────

async function getStoredToken() {
  const { jwt_token } = await chrome.storage.local.get("jwt_token");
  return jwt_token || null;
}

async function storeToken(token) {
  await chrome.storage.local.set({ jwt_token: token });
}

async function clearToken() {
  await chrome.storage.local.remove("jwt_token");
}

async function doLogin() {
  const redirectUri = chrome.identity.getRedirectURL();
  const authUrl = `${SERVER_BASE}/auth/google?ext_redirect=${encodeURIComponent(redirectUri)}`;

  let resultUrl;
  try {
    resultUrl = await chrome.identity.launchWebAuthFlow({
      url: authUrl,
      interactive: true,
    });
  } catch (e) {
    throw new Error("Login cancelled or failed: " + e.message);
  }

  if (!resultUrl) throw new Error("Login failed — no redirect received");

  const url = new URL(resultUrl);
  const token = url.searchParams.get("token");
  const error = url.searchParams.get("error");

  if (error) throw new Error("Login error: " + error);
  if (!token) throw new Error("Login failed — no token in redirect");

  await storeToken(token);
  return token;
}

// ─── HTTP helper ──────────────────────────────────────────────────────────────

async function fetchJSON(path, options = {}, timeoutMs = QUICK_TIMEOUT) {
  const token = await getStoredToken();
  const authHeader = token ? { "Authorization": `Bearer ${token}` } : {};

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(`${SERVER_BASE}${path}`, {
      ...options,
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        ...authHeader,
        ...(options.headers || {}),
      },
    });
    clearTimeout(timer);

    if (resp.status === 401) {
      await clearToken();
      const authErr = new Error("Not authenticated — please sign in");
      authErr.code = 401;
      throw authErr;
    }

    if (!resp.ok) {
      const err = await resp.json().catch(() => ({ error: resp.statusText }));
      throw new Error(err.error || `HTTP ${resp.status}`);
    }
    return await resp.json();
  } catch (e) {
    clearTimeout(timer);
    throw e;
  }
}

function reply(sendResponse, data) {
  sendResponse({ ok: true, ...data });
}

function replyError(sendResponse, error) {
  sendResponse({ ok: false, error: error.message || String(error), code: error.code });
}

// ─── Message handler ─────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  handleMessage(msg, sendResponse);
  return true; // keep channel open for async
});

async function handleMessage(msg, sendResponse) {
  const { type, payload = {} } = msg;

  try {
    switch (type) {

      // ── Auth ─────────────────────────────────────────────────────────────
      case "LOGIN": {
        const token = await doLogin();
        const user = await fetchJSON("/auth/me");
        reply(sendResponse, { token, user });
        break;
      }

      case "LOGOUT": {
        await clearToken();
        reply(sendResponse, {});
        break;
      }

      case "GET_USER": {
        const data = await fetchJSON("/auth/me");
        reply(sendResponse, { user: data });
        break;
      }

      case "GET_TOKEN": {
        const token = await getStoredToken();
        reply(sendResponse, { token });
        break;
      }

      // ── Server ────────────────────────────────────────────────────────────
      case "CHECK_SERVER": {
        const data = await fetchJSON("/health");
        reply(sendResponse, data);
        break;
      }

      case "GET_CONFIG": {
        const data = await fetchJSON("/config");
        reply(sendResponse, { config: data });
        break;
      }

      case "SAVE_CONFIG": {
        await fetchJSON("/config", { method: "POST", body: JSON.stringify(payload) });
        reply(sendResponse, {});
        break;
      }

      // ── Job context (stored locally in chrome.storage) ────────────────────
      case "STORE_JOB_CONTEXT": {
        await chrome.storage.local.set({ jobContext: payload });
        reply(sendResponse, {});
        break;
      }

      case "GET_JOB_CONTEXT": {
        const { jobContext } = await chrome.storage.local.get("jobContext");
        reply(sendResponse, { jobContext: jobContext || null });
        break;
      }

      // ── AI Suggestion ──────────────────────────────────────────────────────
      case "GET_SUGGESTION": {
        const data = await fetchJSON("/suggest", {
          method: "POST",
          body: JSON.stringify(payload),
        }, DEFAULT_TIMEOUT);
        reply(sendResponse, { suggestion: data.suggestion });
        break;
      }

      // ── Memory ────────────────────────────────────────────────────────────
      case "SAVE_MEMORY": {
        const data = await fetchJSON("/memory", {
          method: "POST",
          body: JSON.stringify(payload),
        });
        reply(sendResponse, { entry: data });
        break;
      }

      case "SEARCH_MEMORY": {
        const q = encodeURIComponent(payload.query || "");
        const data = await fetchJSON(`/memory/search?q=${q}&top_k=${payload.top_k || 5}`);
        reply(sendResponse, { results: data });
        break;
      }

      case "GET_MEMORY": {
        const data = await fetchJSON("/memory");
        reply(sendResponse, { entries: data });
        break;
      }

      case "DELETE_MEMORY": {
        await fetchJSON(`/memory/${payload.id}`, { method: "DELETE" });
        reply(sendResponse, {});
        break;
      }

      // ── Resumes ───────────────────────────────────────────────────────────
      case "GET_RESUMES": {
        const data = await fetchJSON("/resumes");
        reply(sendResponse, { resumes: data });
        break;
      }

      case "GET_ACTIVE_RESUME": {
        const data = await fetchJSON("/resumes/active");
        reply(sendResponse, { active_resume: data.active_resume, attachment: data.attachment });
        break;
      }

      case "SET_ACTIVE_RESUME": {
        await fetchJSON("/resumes/active", {
          method: "POST",
          body: JSON.stringify({ name: payload.name }),
        });
        reply(sendResponse, {});
        break;
      }

      case "UPLOAD_RESUME_PDF": {
        // payload: { name, file_data (base64), filename }
        const data = await fetchJSON("/resumes/upload-pdf", {
          method: "POST",
          body: JSON.stringify({ name: payload.name, file_data: payload.file_data }),
        }, DEFAULT_TIMEOUT);
        reply(sendResponse, { attachment: data });
        break;
      }

      case "UPLOAD_RESUME_URL": {
        const data = await fetchJSON("/resumes/from-url", {
          method: "POST",
          body: JSON.stringify({ name: payload.name, url: payload.url }),
        }, DEFAULT_TIMEOUT);
        reply(sendResponse, { attachment: data });
        break;
      }

      case "UPLOAD_RESUME_TEXT": {
        const data = await fetchJSON("/resumes/from-text", {
          method: "POST",
          body: JSON.stringify({ name: payload.name, content: payload.content }),
        });
        reply(sendResponse, { attachment: data });
        break;
      }

      case "DELETE_RESUME": {
        await fetchJSON(`/resumes/${encodeURIComponent(payload.name)}`, { method: "DELETE" });
        reply(sendResponse, {});
        break;
      }

      // ── Applications ──────────────────────────────────────────────────────
      case "LOG_APPLICATION": {
        const data = await fetchJSON("/log_application", {
          method: "POST",
          body: JSON.stringify(payload),
        }, DEFAULT_TIMEOUT);
        reply(sendResponse, { result: data });
        break;
      }

      case "GET_APPLICATIONS": {
        const data = await fetchJSON("/applications");
        reply(sendResponse, { applications: data });
        break;
      }

      // ── Chat ──────────────────────────────────────────────────────────────
      case "GET_CHAT_MODELS": {
        const data = await fetchJSON("/chat/models", {}, QUICK_TIMEOUT);
        reply(sendResponse, { models: data });
        break;
      }

      case "CHAT_MESSAGE": {
        // payload: { model, messages, system }
        const data = await fetchJSON("/chat", {
          method: "POST",
          body: JSON.stringify(payload),
        }, DEFAULT_TIMEOUT);
        reply(sendResponse, { reply: data.reply });
        break;
      }

      case "PATCH_NOTES": {
        // payload: { application_id, append }
        await fetchJSON(`/applications/${payload.application_id}/notes`, {
          method: "PATCH",
          body: JSON.stringify({ append: payload.append }),
        });
        reply(sendResponse, {});
        break;
      }

      case "EXTRACT_PDF_TEXT": {
        // payload: { file_data (base64 PDF) }
        const data = await fetchJSON("/extract-pdf-text", {
          method: "POST",
          body: JSON.stringify(payload),
        }, DEFAULT_TIMEOUT);
        reply(sendResponse, { text: data.text });
        break;
      }

      case "AI_EXTRACT_CONTEXT": {
        // AI fallback: extract company/role from page text when selectors failed
        const data = await fetchJSON("/extract_context", {
          method: "POST",
          body: JSON.stringify({ page_text: payload.page_text }),
        }, DEFAULT_TIMEOUT);
        // Merge result with stored context — only fill empty fields
        const stored = await chrome.storage.local.get("jobContext");
        const existing = stored.jobContext || {};
        const enhanced = {
          ...existing,
          company:   existing.company   || data.company || "",
          job_title: existing.job_title || data.role    || "",
        };
        await chrome.storage.local.set({ jobContext: enhanced });
        reply(sendResponse, { company: enhanced.company, job_title: enhanced.job_title });
        break;
      }

      case "GENERATE_COVER_LETTER": {
        // payload: { company, role, job_description }
        const data = await fetchJSON("/cover_letter", {
          method: "POST",
          body: JSON.stringify(payload),
        }, DEFAULT_TIMEOUT);
        reply(sendResponse, { cover_letter: data.cover_letter });
        break;
      }

      // ── WhatsApp ──────────────────────────────────────────────────────────
      case "TRIGGER_DAILY_SUMMARY": {
        await fetchJSON("/notify/daily-summary", { method: "POST", body: "{}" });
        reply(sendResponse, {});
        break;
      }

      case "SEND_TEST_WHATSAPP": {
        await fetchJSON("/notify/whatsapp", {
          method: "POST",
          body: JSON.stringify({ message: "✅ Test message from Job Application Assistant" }),
        });
        reply(sendResponse, {});
        break;
      }

      default:
        replyError(sendResponse, new Error(`Unknown message type: ${type}`));
    }
  } catch (e) {
    replyError(sendResponse, e);
  }
}

// ─── Install defaults ─────────────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.set({
    jobContext: null,
  });
});
