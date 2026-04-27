# Job Application Assistant — Chrome Extension

An AI-powered Chrome extension that auto-fills job applications, generates cover letters, tracks your applications, and chats with AI — all from a sidebar that lives inside job boards.

---

## Features

| Feature | Description |
|---|---|
| **Auto-fill** | Detects every field on a job application and fills them using your resume in one click |
| **AI Cover Letter** | Generate a tailored cover letter instantly, or upload your own PDF and fill it directly into the page |
| **Application Tracker** | Log every job you apply to with company, role, status, and confidence score |
| **AI Chat** | Ask tough application questions and get answers grounded in your own resume |
| **Answer History** | Save your best answers and reuse them across applications |

## Supported Job Boards

LinkedIn · Greenhouse · Lever · Workday · Indeed · Glassdoor · Ashby · SmartRecruiters · Wellfound · Dice · ZipRecruiter · iCIMS · Taleo · Jobvite · BambooHR · Workable · Airtable

---

## Installation

> The extension is not on the Chrome Web Store. Follow the steps below to load it in 2 minutes.

### Step 1 — Clone the repo

```bash
git clone https://github.com/karthikosa11/job-application-assistent.git
```

### Step 2 — Open Chrome Extensions

In Chrome, go to:
```
chrome://extensions/
```

### Step 3 — Enable Developer Mode

Toggle **Developer mode** ON in the top-right corner.

### Step 4 — Load the extension

Click **"Load unpacked"** and select the `extension` folder inside the cloned repo:

```
job-application-assistent/
└── extension/    ← select THIS folder
```

### Step 5 — Pin it to your toolbar

Click the puzzle piece icon (🧩) in Chrome → find **Job Application Assistant** → click the pin icon.

---

## First-Time Sign In

1. Click the extension icon in your toolbar
2. Click **"Sign in with Google"**
3. You will see a screen that says **"Google hasn't verified this app"** — this is expected for open-source tools
4. Click **"Advanced"** at the bottom left → then **"Go to Job Application Assistant (unsafe)"**
5. Sign in with your Google account — you are in

> Your data is only used to power the extension features. Nothing is sold or shared.

---

## How to Use

1. Go to any supported job board (e.g. a LinkedIn job posting)
2. The sidebar opens automatically on the right side of the page
3. Upload your resume via the **Resume Manager** (click the resume badge at the top of the sidebar)
4. Click **"Fill All"** to auto-fill the entire application form
5. Use the **Chat** tab to get AI help with tricky questions
6. Click **"Log This Application"** to track it in your dashboard

---

## Tech Stack

**Extension** — Chrome Manifest V3, Vanilla JavaScript, Chrome Identity API

**Backend** — Python, FastAPI, PostgreSQL, JWT authentication, AWS App Runner

**AI** — Anthropic Claude, RAG-based memory for reusing past answers

**Infrastructure** — AWS App Runner, S3, ECR, Docker

---

## Reporting Issues

Use the **"Report Issue"** link inside the extension popup, or open a [GitHub Issue](https://github.com/karthikosa11/job-application-assistent/issues).
