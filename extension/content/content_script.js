/**
 * Content script — injected into all pages.
 * Detects job application pages, extracts form fields + job context,
 * injects the sidebar iframe, and handles field auto-fill requests.
 */

(function () {
  "use strict";

  if (window.__jobAssistantLoaded) return;
  window.__jobAssistantLoaded = true;

  // Domains that are definitively NOT job pages — block immediately to prevent false positives
  const NON_JOB_DOMAINS = /\b(gmail|mail\.google|outlook\.live|outlook\.office|yahoo\.mail|mail\.yahoo|hotmail|protonmail|fastmail|drive\.google|docs\.google|sheets\.google|slides\.google|onedrive\.live|dropbox|box\.com|icloud\.com|notion\.so|confluence|jira|trello|asana|monday\.com|clickup|slack|discord|teams\.microsoft|zoom\.us|meet\.google|calendar\.google|facebook|instagram|twitter\.com|x\.com|tiktok|reddit|youtube|netflix|spotify|twitch|wikipedia|github\.com|gitlab\.com|bitbucket|stackoverflow|medium\.com|substack|hashnode|dev\.to)\b/i;

  // ─── Platform detection ───────────────────────────────────────────────────

  const PLATFORM_SELECTORS = {
    linkedin: {
      host: /linkedin\.com/,
      path: /\/jobs\//,   // any LinkedIn jobs page (search, view, apply, collections)
      titleSel: [
        ".job-details-jobs-unified-top-card__job-title h1",
        ".jobs-unified-top-card__job-title h1",
        "[class*='job-details-jobs-unified-top-card__job-title' i] h1",
        "[class*='jobs-unified-top-card__job-title' i] h1",
        "h1.t-24",
        "h1[class*='job-title' i]",
        "[class*='topcard__title' i]",
        // 2024-2025 layout additions
        ".job-details-top-card__job-title",
        "[class*='job-details-top-card__job-title' i]",
      ].join(", "),
      companySel: [
        ".job-details-jobs-unified-top-card__company-name a",
        ".jobs-unified-top-card__company-name a",
        ".job-details-jobs-unified-top-card__primary-description-without-tagline a",
        "[class*='company-name' i] a",
        "[class*='topcard__org-name' i] a",
        // Newer LinkedIn layouts (2024–2026)
        ".artdeco-entity-lockup__subtitle a",
        "[class*='job-details-top-card__company' i] a",
        "[class*='hirer-card__hirer-information' i] a",
        "[class*='jobs-poster__name' i]",
        "[class*='job-details-jobs-unified-top-card__company-name' i]",
        "[class*='topcard__flavor' i] a",
        "[class*='jobs-unified-top-card__subtitle-primary' i] a",
        ".job-details-jobs-unified-top-card__company-name",
      ].join(", "),
      descSel: [
        // 2025–2026 LinkedIn redesign
        "#job-details",
        ".jobs-description--reformatted",
        "[class*='jobs-description--reformatted' i]",
        // Previous selectors
        ".jobs-description-content__text",
        ".jobs-description__content",
        ".jobs-description-content",
        ".jobs-description .jobs-box__html-content",
        ".jobs-description",
        "[class*='jobs-description' i]",
        "[class*='jobs-box__html-content' i]",
      ].join(", "),
      labelSel: ".fb-dash-form-element__label, .artdeco-text-input--label, label",
    },
    greenhouse: {
      host: /greenhouse\.io|boards\.greenhouse\.io/,
      path: /\/jobs?\//,
      titleSel: "h1.app-title, h1",
      companySel: ".company-name, [class*='company-name' i]",
      descSel: "#content .description, #content",
      labelSel: "label",
    },
    lever: {
      host: /lever\.co/,
      // companySel intentionally blank — company comes from URL subdomain/path via _urlCompany
      // (.posting-headline .sort-by-time was WRONG — that class is a timestamp, not a company name)
      titleSel: ".posting-headline h2, h2[class*='posting-title' i]",
      companySel: "[class*='company-name' i], [class*='posting-company' i]",
      descSel: ".posting-description, [class*='posting-description' i]",
      labelSel: "label",
    },
    workday: {
      host: /myworkdayjobs\.com|workday\.com/,
      titleSel: "[data-automation-id='jobPostingHeader'], h1",
      companySel: "[data-automation-id='company'], [class*='gwt-Label' i]",
      descSel: "[data-automation-id='jobPostingDescription'], [class*='job-description' i]",
      labelSel: "[data-automation-id='formLabel'], label",
    },
    icims: {
      host: /icims\.com/,
      titleSel: ".iCIMS_JobHeaderTitle h1, .iCIMS_Header h1, h1",
      companySel: ".iCIMS_JobHeaderCompany, [class*='company' i]",
      descSel: ".iCIMS_JobContent, [class*='job-content' i]",
      labelSel: "label",
    },
    smartrecruiters: {
      host: /smartrecruiters\.com/,
      titleSel: "h1[data-ui='job-title'], h1",
      companySel: "[data-ui='company-name'] a, [data-ui='company-name']",
      descSel: ".job-sections, [class*='job-section' i]",
      labelSel: "label",
    },
    indeed: {
      host: /indeed\.com/,
      titleSel: "[data-testid='jobsearch-JobInfoHeader-title'], h1[class*='jobTitle' i]",
      companySel: "[data-testid='inlineHeader-companyName'] a, [data-testid='inlineHeader-companyName'], [class*='companyName' i]",
      descSel: "#jobDescriptionText, [class*='jobDescriptionText' i]",
      labelSel: "[data-testid='FormLabel'], label",
    },
    taleo: {
      host: /taleo\.net/,
      titleSel: ".jobTitle, h1",
      companySel: ".company, [class*='company' i]",
      descSel: ".jobDescription, [class*='jobDescription' i]",
      labelSel: "label",
    },
    jobvite: {
      host: /jobvite\.com/,
      titleSel: "h1.jv-header, h1",
      companySel: ".jv-company, [class*='company' i]",
      descSel: ".jv-job-detail-description, [class*='job-detail' i]",
      labelSel: "label",
    },
    dice: {
      host: /dice\.com/,
      path: /\/(job-detail|jobs)\//,   // only job pages, not homepage or search
      titleSel: "h1[data-cy='jobTitle'], h1[class*='jobTitle' i]",
      companySel: "[data-cy='companyName'], [data-cy='employerProfile-link'], a[href*='/employer/']",
      descSel: "[data-cy='jobDescription'], [class*='jobDescription' i], [class*='job-description' i]",
      labelSel: "label",
    },
    glassdoor: {
      host: /glassdoor\.com/,
      path: /\/(job-listing|Jobs|partner\/jobListing|overview\/working-at)\//i,
      titleSel: "[data-test='job-title'], h1[class*='job-title' i], h1",
      companySel: "[data-test='employer-name'], [class*='employer-name' i], [class*='employer' i]",
      descSel: "[class*='jobDescriptionContent' i], [data-test='job-description'], [class*='JobDesc' i]",
      labelSel: "label",
    },
    ziprecruiter: {
      host: /ziprecruiter\.com/,
      path: /\/(jobs?|c|job)\//,
      titleSel: "h1[class*='job_title' i], h1[class*='jobTitle' i], h1",
      companySel: "[class*='hiring_company' i], [class*='hiringCompany' i], [class*='company_name' i], [class*='companyName' i]",
      descSel: "[class*='job_description' i], [class*='jobDescription' i], .jobDescriptionSection",
      labelSel: "label",
    },
    wellfound: {
      host: /wellfound\.com|angel\.co/,
      path: /\/jobs?\//,
      titleSel: "h1[class*='title' i], [class*='job-title' i], h1",
      companySel: "[class*='startup-link' i], [class*='company-name' i], [class*='company_name' i]",
      descSel: "[class*='jobDescription' i], [class*='job-description' i], [class*='description' i]",
      labelSel: "label",
    },
    builtin: {
      host: /builtin(boston|chicago|nyc|colorado|austin|seattle|la|sf)?\.com/,
      path: /\/jobs?\//,
      titleSel: "h1[class*='job-title' i], h1[class*='title' i], h1",
      companySel: "[class*='company-title' i], [class*='company-name' i], [class*='employer' i]",
      descSel: "[class*='job-description' i], [class*='description' i]",
      labelSel: "label",
    },
    workable: {
      host: /workable\.com/,
      path: /\/(j|jobs?)\//,
      titleSel: "h1[class*='title' i], h1",
      companySel: "[class*='company-name' i], [class*='companyName' i]",
      descSel: "[class*='job-description' i], [class*='description' i]",
      labelSel: "label",
    },
    airtable: {
      host: /airtable\.com/,
      // Company is usually in the form heading or page title, not the domain
      titleSel: "[class*='formFieldLabel' i]:first-of-type, h1",
      companySel: "[class*='formTitle' i], [class*='brandingName' i], h1",
      descSel: "[class*='formDescription' i], [class*='description' i]",
      labelSel: "[class*='formFieldLabel' i], label",
    },
    ashby: {
      host: /ashbyhq\.com/,
      titleSel: "h1",
      companySel: "[class*='company' i], [class*='org' i]",
      descSel: "[class*='description' i], [class*='job-post' i]",
      labelSel: "label",
    },
    bamboohr: {
      host: /bamboohr\.com/,
      titleSel: "h2.BambooHR-ATS-board__header-title, h1",
      companySel: ".BambooHR-ATS-board__header-company, [class*='company' i]",
      descSel: "#job-description, [class*='description' i]",
      labelSel: "label",
    },
  };

  // Known job-board domains — don't use as company name fallback
  const JOB_BOARD_HOSTS = /^(www\.)?(linkedin|indeed|dice|ziprecruiter|glassdoor|monster|careerbuilder|simplyhired|snagajob|flexjobs|wellfound|angellist|builtin|hired|handshake|zippia)\.com$/;

  // Keywords indicating this is a job application page
  const JOB_URL_PATTERNS = [
    "/apply", "/application", "/jobs/", "/careers/", "/job-apply", "/apply-job",
    "/career", "/job/", "/opening", "/position", "/hiring", "/recruit",
    "/join-us", "/join", "/work-with-us", "/we-are-hiring", "/vacancies",
    "/opportunities", "/openings", "/current-openings", "/roles",
    "jobs.", "careers.", "apply.", "talent.", "join.",
  ];
  const FORM_KEYWORDS = [
    "cover letter", "years of experience", "authorized to work", "work authorization",
    "salary", "linkedin", "github", "portfolio", "visa", "sponsorship", "relocate",
    "remote", "start date", "notice period", "willing to", "eligible to work",
    "expected salary", "current salary", "why do you want", "tell us about yourself",
    "describe yourself", "c2c", "w2", "contract", "full time", "part time",
  ];

  function detectPlatform() {
    const host = window.location.hostname.toLowerCase();
    const path = window.location.pathname;
    for (const [name, p] of Object.entries(PLATFORM_SELECTORS)) {
      if (!p.host.test(host)) continue;
      if (p.path && !p.path.test(path)) continue;
      return { name, ...p };
    }
    return null;
  }

  function heuristicScore() {
    const url = window.location.href.toLowerCase();
    const title = document.title.toLowerCase();
    let score = 0;
    let hasUrlSignal = false;

    for (const pattern of JOB_URL_PATTERNS) {
      if (url.includes(pattern)) { score += 3; hasUrlSignal = true; break; }
    }
    for (const kw of ["apply", "application", "job", "career"]) {
      if (title.includes(kw)) { score += 1; }
    }
    // Only scan body text if URL already has a job signal — prevents false positives on email/cloud pages
    if (hasUrlSignal) {
      const bodyText = (document.body?.innerText || "").toLowerCase();
      for (const kw of FORM_KEYWORDS) {
        if (bodyText.includes(kw)) score += 1;
      }
    }
    // Resume upload input — strong signal regardless of URL
    if (document.querySelector("input[accept*='pdf'], input[name*='resume' i], input[id*='resume' i], input[name*='cv' i]")) {
      score += 4;
    }
    return score;
  }

  function isJobApplicationPage() {
    if (NON_JOB_DOMAINS.test(window.location.hostname)) return false;
    if (detectPlatform()) return true;
    return heuristicScore() >= 3;
  }

  // ─── Field extraction ─────────────────────────────────────────────────────

  function extractText(sel) {
    if (!sel) return "";
    const el = document.querySelector(sel);
    return el ? el.innerText.trim() : "";
  }

  // Labels to skip — UI filters, navigation, not real form fields
  const SKIP_LABEL_PATTERNS = [
    /^filter by /i, /^past (month|week|24)/i, /^any time/i,
    /^\$[\d,]+\+?$/, /^r\d{4,}$/, /^\d+$/, /^on$/i, /^off$/i,
    /^(internship|entry level|associate|mid-senior|director|executive)$/i,
    /^(on-site|hybrid|remote)$/i, /^(epic|lensa|actalent)$/i,
    /^set job alert/i, /^search by/i, /^city, state/i,
  ];

  function isJunkLabel(text) {
    if (text.length > 300) return true;  // too long — likely a paragraph, not a field label
    return SKIP_LABEL_PATTERNS.some(p => p.test(text.trim()));
  }

  function extractFields(labelSel) {
    const labels = document.querySelectorAll(labelSel || "label");
    const questions = [];
    const basic = [];

    labels.forEach((label) => {
      const labelText = label.innerText.trim();
      if (!labelText || labelText.length < 3) return;
      if (isJunkLabel(labelText)) return;

      // Find associated input/textarea/select
      let input = null;
      const forAttr = label.getAttribute("for");
      if (forAttr) input = document.getElementById(forAttr);
      if (!input) {
        input = label.nextElementSibling;
        if (input && !["INPUT", "TEXTAREA", "SELECT"].includes(input.tagName)) {
          input = input.querySelector("input, textarea, select");
        }
      }
      if (!input) input = label.querySelector("input, textarea, select");
      if (!input) return;

      const tag = input.tagName.toLowerCase();
      const type = input.type || tag;
      if (type === "hidden" || type === "file" || type === "submit" || type === "button" || type === "radio" || type === "checkbox") return;

      const isQuestion = isQuestionField(labelText);
      const field = {
        label: labelText,
        type: tag === "textarea" ? "textarea" : "text",
        inputType: type,
        currentValue: input.value || "",
        isQuestion,
        element: input,
      };

      if (isQuestion) questions.push(field);
      else basic.push(field);
    });

    // Questions first, then basic fields — cap at 15 total
    return [...questions, ...basic].slice(0, 15);
  }

  function isQuestionField(label) {
    const l = label.toLowerCase();
    return FORM_KEYWORDS.some(kw => l.includes(kw)) ||
      l.endsWith("?") ||
      l.startsWith("why") ||
      l.startsWith("how") ||
      l.startsWith("describe") ||
      l.startsWith("please describe") ||
      l.startsWith("please explain") ||
      l.startsWith("please tell") ||
      l.startsWith("please share") ||
      l.startsWith("please provide") ||
      l.startsWith("tell us") ||
      l.startsWith("explain") ||
      l.startsWith("share");
  }

  // ── Schema.org JobPosting extraction (most reliable on career sites) ──────

  // Strip HTML tags from a string (used for JSON-LD descriptions that embed HTML markup)
  function _stripHtml(html) {
    if (!html || !html.includes("<")) return html;
    try {
      const doc = new DOMParser().parseFromString(html, "text/html");
      return (doc.body.innerText || doc.body.textContent || "").trim();
    } catch (_) {
      return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    }
  }

  function extractFromSchema() {
    const result = { job_title: "", company: "", description: "" };
    const scripts = document.querySelectorAll('script[type="application/ld+json"]');
    for (const s of scripts) {
      try {
        const data = JSON.parse(s.textContent);
        const entries = Array.isArray(data) ? data : [data];
        for (const entry of entries) {
          const type = entry["@type"] || "";
          if (type === "JobPosting" || type.includes("Job")) {
            result.job_title   = entry.title || entry.name || result.job_title;
            result.company     = (entry.hiringOrganization?.name) || result.company;
            // JSON-LD descriptions are often stored as raw HTML — strip tags
            const rawDesc = entry.description || "";
            result.description = rawDesc ? _stripHtml(rawDesc) : result.description;
          }
        }
      } catch (_) {}
    }
    return result;
  }

  // ── Meta tag extraction ────────────────────────────────────────────────────
  function metaContent(name) {
    return document.querySelector(`meta[property='${name}'], meta[name='${name}']`)?.content?.trim() || "";
  }

  function extractPageContext(platform) {
    const sel = platform || {};

    // 1. Try schema.org structured data first (most accurate)
    const schema = extractFromSchema();

    // 2. Meta tags
    const ogTitle = metaContent("og:title") || metaContent("title");
    const ogSite  = metaContent("og:site_name");

    // ── Job title ──────────────────────────────────────────────────────────

    // Generic careers-page headings that are NOT actual job titles
    const _CAREER_HEADINGS = /^(join\s+us|join|careers?|work\s+with\s+us|work\s+here|jobs|openings?|opportunities|we.?re\s+hiring|come\s+work\s+with\s+us|life\s+at\s+\w+|working\s+at\s+\w+|our\s+team|open\s+roles?|open\s+positions?|current\s+openings?|see\s+all\s+jobs?|all\s+jobs?|explore\s+roles?)$/i;
    function _isCareerHeading(t) { return !t || _CAREER_HEADINGS.test(t.trim()); }

    // Extract job title from URL slug after a careers-section segment
    // e.g. /join-us/ai-research-engineer  → "AI Research Engineer"
    //      /careers/senior-software-engineer-c4b3ec7e-... → "Senior Software Engineer"
    const _urlJobTitle = (() => {
      const parts = window.location.pathname.split("/").filter(Boolean);
      // Also skip navigational segments that look like sections, not job slugs
      const CAREER_SECS = /^(join-?us|careers?|jobs?|openings?|opportunities|positions?|roles?|work-?with-?us|join|postings?|search|view|collections?|recommended|discover|search-results|similar-jobs?)$/i;
      for (let i = 0; i < parts.length - 1; i++) {
        if (!CAREER_SECS.test(parts[i])) continue;
        let slug = parts[i + 1];
        if (!slug || /^\d+$/.test(slug) || /^[0-9a-f]{8}-/i.test(slug)) continue;
        // Also skip if the slug itself is a navigational segment (e.g. /jobs/search/...)
        if (CAREER_SECS.test(slug)) continue;
        // Strip trailing UUID
        slug = slug.replace(/-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, "");
        // Strip "-at-companyname" suffix so title doesn't include the company
        slug = slug.replace(/-at-[a-z][a-z0-9-]*$/, "");
        if (slug && !CAREER_SECS.test(slug)) {
          return slug.replace(/-/g, " ").replace(/\b\w/g, c => c.toUpperCase()).trim();
        }
      }
      return "";
    })();

    // Single-word department/team names that look like role words but aren't job titles
    const _DEPT_HEADINGS = /^(engineering|design|marketing|sales|finance|legal|operations|product|research|data|analytics|infrastructure|security|support|hr|recruiting|growth|content|communications|partnerships|strategy|science|technology|business|management|administration)$/i;

    // Strip common "Apply for / Apply to / Apply as" prefixes from a title string
    function _stripApplyPrefix(t) {
      return t.replace(/^apply\s+(for|to|as)\s+/i, "").trim();
    }

    // Scan headings deeper in the DOM for a job-specific title
    const _deepJobTitle = (() => {
      const candidates = [
        ...document.querySelectorAll("h1, h2, h3, [class*='job-title' i], [class*='position-title' i], [class*='role-title' i], [class*='posting-title' i], [class*='jobtitle' i]")
      ];
      for (const el of candidates) {
        const t = _stripApplyPrefix(el.innerText?.trim() || "");
        if (!t || t.length < 4 || t.length > 100) continue;
        if (_isCareerHeading(t)) continue;
        if (_DEPT_HEADINGS.test(t)) continue;           // reject bare department names
        // Must contain a role-indicative word as a whole word (not substring)
        if (/\b(engineer|developer|designer|manager|analyst|scientist|researcher|fellow|lead|director|specialist|coordinator|architect|devops|recruiter|writer|consultant|intern|associate|officer|advisor|executive|head|vp|principal|staff|product\s+manager|research\s+\w+)\b/i.test(t)) {
          return t;
        }
      }
      return "";
    })();

    // h1 text, cleaned of "Apply for/to/as" prefix and career-page headings
    const _rawH1 = _stripApplyPrefix(document.querySelector("h1")?.innerText.trim() || "");

    const job_title =
      schema.job_title ||
      extractText(sel.titleSel) ||
      _urlJobTitle ||                                               // URL slug after /careers/, /join-us/ etc.
      (!_isCareerHeading(_rawH1) && !_DEPT_HEADINGS.test(_rawH1) ? _rawH1 : "") || // h1 first (most prominent)
      _deepJobTitle ||                                              // DOM scan for role-indicative heading
      document.querySelector("[class*='job-title' i],[class*='jobtitle' i],[id*='job-title' i]")?.innerText.trim() ||
      document.querySelector("[class*='position-title' i],[class*='role-title' i],[class*='posting-title' i]")?.innerText.trim() ||
      (ogTitle ? ogTitle.replace(/\s*[@|–-]\s*.+$/, "").trim() : "") ||
      "";

    // ── Company ────────────────────────────────────────────────────────────
    // Try to extract "Company" from "Role at Company" or "Role | Company" in og:title
    let companyFromTitle = "";
    if (ogTitle && ogTitle.match(/\s+(?:at|@)\s+(.+)/i)) {
      companyFromTitle = ogTitle.match(/\s+(?:at|@)\s+(.+)/i)[1].trim();
    }

    // ── Company extraction helpers ─────────────────────────────────────────

    // Words that are never a company name (used across all patterns below)
    const _GENERIC = /^(www|jobs|careers|apply|boards|hire|talent|work|app|portal|ats|recruiting|recruitment|join|team|us|uk|eu|global|na|about|home|login|board|position|opening|role|listing|postings?|positions?|openings?|applications?|applicants?|new|edit|view|show|index)$/i;
    // Common job-title words — help strip role from "company-role-uuid" slugs
    const _ROLE_WORDS = /^(engineer|developer|manager|director|senior|junior|lead|principal|staff|software|full|stack|front|back|end|data|machine|learning|ml|ai|product|design|designer|qa|devops|sre|backend|frontend|web|mobile|android|ios|cloud|security|platform|infrastructure|analyst|architect|head|vp|president|specialist|coordinator|associate|intern|consultant|scientist|researcher|writer|marketing|sales|finance|hr|legal|support|operations|ops|program|project|business|technical|tech)$/i;
    // Known job-board domains — skip entirely
    const _JOB_BOARDS = /\b(linkedin|indeed|dice|ziprecruiter|glassdoor|monster|careerbuilder|simplyhired|snagajob|flexjobs|wellfound|angellist|builtin|hired|zippia|handshake|themuse|getwork|jooble)\.com\b/;
    // Brand names of job boards — reject as company name candidates
    const _JOB_BOARD_BRANDS = /^(linkedin|indeed|glassdoor|monster|ziprecruiter|dice|careerbuilder|simplyhired|snagajob|flexjobs|wellfound|angellist|builtin|hired|handshake|zippia|themuse|getwork|jooble|lensa|gusto)$/i;

    function _toTitle(slug) {
      return slug.replace(/-/g, " ").replace(/\b\w/g, c => c.toUpperCase()).trim();
    }

    // SLD (second-level domain) of the current host — the platform's own brand name.
    // e.g. "docs.google.com" → "google", "stripe.greenhouse.io" → "greenhouse"
    // Used to reject logo alt text / body text that matches the hosting platform, not the employer.
    const _hostSLD = (() => {
      const parts = window.location.hostname.replace(/^www\./, "").split(".");
      return (parts.length >= 2 ? parts[parts.length - 2] : parts[0]).toLowerCase();
    })();

    // Extract company prefix from a slug that may contain "company-role-uuid"
    // e.g. "mapistry-full-stack-software-engineer-c4b3ec7e-..." → "Mapistry"
    // e.g. "happy-briefcase-frontend-engineer-uuid"            → "Happy Briefcase"
    function _extractCompanyFromSlug(slug) {
      // Strip full UUID suffix first
      const withoutUuid = slug.replace(/-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, "");
      const words = withoutUuid.split("-").filter(Boolean);
      // Walk words until we hit a known job-title word — everything before is the company
      const companyWords = [];
      for (const w of words) {
        if (_ROLE_WORDS.test(w)) break;
        companyWords.push(w);
      }
      if (!companyWords.length) return "";
      return _toTitle(companyWords.join("-"));
    }

    // 1. URL-based: subdomain, path slug, or company-uuid pattern
    const _urlCompany = (() => {
      const host = window.location.hostname.toLowerCase();
      if (_JOB_BOARDS.test(host)) return "";
      const parts = window.location.pathname.split("/").filter(Boolean);

      // Pattern 0: explicit /company/{name}/ segment — used by SmartRecruiters oneclick-ui
      // e.g. jobs.smartrecruiters.com/oneclick-ui/company/Visa/publication/uuid → "Visa"
      const companySegIdx = parts.findIndex(p => p.toLowerCase() === "company");
      if (companySegIdx >= 0 && companySegIdx + 1 < parts.length) {
        const name = parts[companySegIdx + 1];
        if (name && !_GENERIC.test(name) && !/^[0-9a-f]{8}-/i.test(name)) {
          return _toTitle(name);
        }
      }

      // Pattern A: company IS the subdomain (stripe.greenhouse.io → Stripe)
      const ATS_SUBDOMAIN = /\.(greenhouse\.io|lever\.co|workable\.com|bamboohr\.com|icims\.com|recruitee\.com|applytojob\.com|jobvite\.com|breezy\.hr|pinpointhq\.com|teamtailor\.com|personio\.(de|com)|comeet\.co|jazz\.co|jobscore\.com|hirehive\.com|ashbyhq\.com|smartrecruiters\.com|myworkdayjobs\.com|taleo\.net|dover\.com|rippling\.com)$/;
      if (ATS_SUBDOMAIN.test(host)) {
        const sub = host.split(".")[0];
        if (!_GENERIC.test(sub) && sub.length > 2) return _toTitle(sub);
      }

      // UI path segments that are never a company name — skip them in Pattern B
      const _UI_PATH_SEG = /^(oneclick[-_]?ui|oneclick|publication|widget|portal|embed|iframe|v\d|api|app|ext|redirect|oauth|auth|sso|saml|apply-now|quick-apply|easy-apply)$/i;

      // Pattern B: scan ALL path segments for a company-uuid or company-role-uuid pattern
      const ATS_PATH = /(ashbyhq|greenhouse|lever|jobvite|bamboohr|workable|recruitee|teamtailor|breezy|pinpointhq|comeet|smartrecruiters|gusto|rippling|dover)\.(io|co|com)/;
      for (const seg of parts) {
        if (_GENERIC.test(seg) || /^\d+$/.test(seg) || /^[0-9a-f]{8}-/i.test(seg)) continue;
        if (_UI_PATH_SEG.test(seg)) continue;  // skip UI section names
        // Segment contains a UUID → extract company prefix (strips role words too)
        if (/-[0-9a-f]{8}-[0-9a-f]{4}-/i.test(seg)) {
          const c = _extractCompanyFromSlug(seg);
          if (c && !_GENERIC.test(c)) return c;
        }
        // Plain slug on known ATS host — use it only if it looks like a company (short, no role words)
        if (ATS_PATH.test(host) && !_ROLE_WORDS.test(seg.split("-")[0])) {
          return _toTitle(seg);
        }
      }

      // Pattern C: careers.company.com → "Company"
      const hostParts = host.replace(/^www\./, "").split(".");
      if (hostParts.length >= 3) {
        const sub = hostParts[0];
        const domain = hostParts[1];
        if (/^(careers|jobs|apply|work|talent|hire|hiring|join)$/i.test(sub) && domain.length > 2) {
          return _toTitle(domain);
        }
      }

      return "";
    })();

    // 2. Page title: "Role at Mapistry – Gusto" or "Mapistry | Software Engineer"
    const _titleCompany = (() => {
      const title = document.title || "";
      // Reject titles that look like search results: start with "(N)" notification badge
      // or contain job-search phrasing like "X Jobs", "X Job Search"
      if (/^\(\d+\)/.test(title)) return "";          // "(2) ai engineer Jobs | LinkedIn"
      if (/\bjobs?\s*(search|results?|listing)?\s*[|\-–—]/i.test(title)) return "";
      if (/[|\-–—]\s*(linkedin|indeed|dice|glassdoor|ziprecruiter|monster|gusto)\s*$/i.test(title)) return "";

      // "X at Company" pattern
      const atMatch = title.match(/\bat\s+([A-Z][^|\-–—\n]{2,40}?)(?:\s*[|\-–—]|\s*$)/);
      if (atMatch) {
        const c = atMatch[1].trim();
        if (!_JOB_BOARDS.test(c.toLowerCase()) && !_GENERIC.test(c)) return c;
      }
      // "Company | Role" or "Company - Role" — first segment before separator
      // Only use if it doesn't look like a search query (no spaces before "Jobs")
      const firstSeg = title.split(/[|\-–—]/)[0].trim();
      if (firstSeg && firstSeg.length > 2 && firstSeg.length < 50 && /[A-Z]/.test(firstSeg)) {
        if (/\bjobs?\b/i.test(firstSeg)) return "";   // "Software Engineer Jobs" is a search query
        if (!_JOB_BOARDS.test(firstSeg.toLowerCase()) && !_GENERIC.test(firstSeg)) return firstSeg;
      }
      return "";
    })();

    // 3. Logo image alt text (most reliable visual indicator of company name)
    const _logoCompany = (() => {
      const candidates = document.querySelectorAll(
        "header img[alt], nav img[alt], " +
        "img[class*='logo' i][alt], img[id*='logo' i][alt], " +
        "[class*='brand' i] img[alt], [class*='navbar' i] img[alt], " +
        "[class*='header' i] img[alt]"
      );
      for (const img of candidates) {
        const alt = (img.alt || "").trim();
        if (alt.length > 1 && alt.length < 60 && !/logo|icon|img|image|banner/i.test(alt)) {
          const altNorm = alt.toLowerCase().replace(/[\s.-]/g, "");
          // Skip if it's a job-board brand OR if it matches the hosting platform's own name
          if (!_JOB_BOARDS.test(alt.toLowerCase()) && !_JOB_BOARD_BRANDS.test(alt) && altNorm !== _hostSLD) return alt;
        }
      }
      return "";
    })();

    // Returns true if a string looks like a person's full name (e.g. "Karthik Osaka")
    // Two words, each 2-20 chars, Title Case — used to reject user profile data
    function _looksLikePersonName(s) {
      const words = s.trim().split(/\s+/);
      if (words.length < 2 || words.length > 3) return false;
      return words.every(w => w.length >= 2 && w.length <= 20 && /^[A-Z][a-z]+$/.test(w));
    }

    // Returns true if the string matches any visible form input value on the page
    // (means it's user-entered data, not a company name)
    function _isFormValue(s) {
      const lower = s.toLowerCase();
      for (const el of document.querySelectorAll('input[type="text"], input:not([type]), textarea')) {
        if (el.value && el.value.trim().toLowerCase() === lower) return true;
      }
      return false;
    }

    // LinkedIn job URL: /jobs/view/senior-software-engineer-at-wilson-brown-4161234567/
    // The slug always ends with a large numeric ID. Everything before it is "role-at-company".
    const _linkedInUrlCompany = (() => {
      if (!/linkedin\.com/.test(window.location.hostname)) return "";
      const slug = window.location.pathname.replace(/\/$/, "").split("/").pop() || "";
      // Must end with 7+ digit job ID
      const m = slug.match(/^(.+?)-(\d{7,})$/);
      if (!m) return "";
      const atIdx = m[1].lastIndexOf("-at-");
      if (atIdx === -1) return "";
      const companySlug = m[1].slice(atIdx + 4);
      return companySlug ? _toTitle(companySlug) : "";
    })();

    // Body-text company extraction helper (runs once, reused below)
    const _bodyCompany = (() => {
      const bodyText = document.body?.innerText || "";
      // Pattern 1: "Role at/@ Company" on same line
      const m1 = bodyText.match(/(?:^|\n)(?:[\w\s,()/-]+)\s+(?:at|@)\s+([A-Z][^\n]{2,60}?)(?:\n|$)/m);
      if (m1) {
        const c = m1[1].replace(/\s+in\s+[A-Z][^\n]+$/, "").trim();
        const cNorm = c.toLowerCase().replace(/\s/g, "");
        if (!_looksLikePersonName(c) && !_isFormValue(c) && cNorm !== _hostSLD) return c;
      }
      // Pattern 2: line that starts with "@" — e.g. "@ Company Name in City, ST"
      const m2 = bodyText.match(/(?:^|\n)\s*@\s+([A-Z][^\n]{2,60}?)(?:\n|$)/m);
      if (m2) {
        const c = m2[1].replace(/\s+in\s+[A-Z][^\n]+$/, "").trim();
        const cNorm = c.toLowerCase().replace(/\s/g, "");
        if (!_looksLikePersonName(c) && !_isFormValue(c) && cNorm !== _hostSLD) return c;
      }
      return "";
    })();

    // Strings that look like UI buttons / CTAs, never a company name
    const _CTA_STRINGS = /^(easy\s*apply|apply\s*now|quick\s*apply|one.?click\s*apply|apply|submit|sign\s*in|log\s*in|login|sign\s*up|register|continue|next|back|cancel|close|save|done|confirm|upload|browse|attach|remove|edit|delete|view|show|hide|expand|collapse|see\s*more|load\s*more|get\s*started|learn\s*more|find\s*out\s*more|not\s*now|skip|dismiss)$/i;

    // Validate a candidate company string — reject person names, form values, and CTA strings
    function _validCompany(s) {
      if (!s) return "";
      const t = s.trim();
      if (!t || t.length < 2) return "";
      if (_looksLikePersonName(t)) return "";
      if (_isFormValue(t)) return "";
      if (_JOB_BOARD_BRANDS.test(t)) return "";
      if (_CTA_STRINGS.test(t)) return "";
      return t;
    }

    const company =
      _validCompany(schema.company) ||            // schema.org (most accurate)
      _validCompany(extractText(sel.companySel)) || // platform-specific CSS selector
      _validCompany(_linkedInUrlCompany) ||        // LinkedIn URL slug: "…-at-wilson-brown-123456"
      _validCompany(companyFromTitle) ||           // og:title "Role at Company"
      _validCompany(_urlCompany) ||                // subdomain / path slug / company-uuid
      _validCompany(_logoCompany) ||               // logo <img alt="Company">
      _validCompany(_titleCompany) ||              // document.title parsing
      _validCompany(_bodyCompany) ||               // body text "@ Company" / "at Company"
      _validCompany(document.querySelector("[class*='company' i],[class*='org-name' i],[class*='hiring-company' i]")?.innerText) ||
      _validCompany(document.querySelector("[itemprop='hiringOrganization'] [itemprop='name'], [itemprop='hiringOrganization']")?.innerText) ||
      _validCompany(document.querySelector("[class*='brand' i] h1, [class*='brand' i] h2")?.innerText) ||
      (!JOB_BOARD_HOSTS.test(window.location.hostname) ? _validCompany(ogSite) : "") ||
      (!JOB_BOARD_HOSTS.test(window.location.hostname)
        ? _validCompany(window.location.hostname.replace(/^www\./, "").replace(/\.(com|io|co|net|org|careers).*$/, "").replace(/-/g, " "))
        : "") || "";

    // ── Description ────────────────────────────────────────────────────────
    const _JD_SIGNAL = /\b(responsibilities|qualifications?|requirements?|what you.ll|you will|we.?re looking|about the role|about this role|about the job|job description|skills|experience|who you are|what we.?re looking|minimum qualifications?|preferred qualifications?|nice to have|what you.ll do|what you will do|key responsibilities|basic qualifications?|you.ll bring|what you bring)\b/i;

    // Strip LinkedIn-style metadata lines from the TOP of an extracted description.
    // These lines contain location · time · applicants, employment type, etc.
    // Strategy: drop all lines before the first line that contains a JD signal word.
    function _trimJDNoise(text) {
      if (!text) return "";
      const lines = text.split("\n");
      // Find the first line index that has a JD signal word
      const firstSignalIdx = lines.findIndex(l => _JD_SIGNAL.test(l));
      if (firstSignalIdx <= 0) return text; // nothing to trim, or signal on first line
      // Only trim if the leading lines look like metadata (short + contain noise markers)
      const _NOISE_LINE = /[·•]|\b(ago|applicants?|promoted|insights?|on.?site|hybrid|remote|full.?time|part.?time|contract|entry.?level|mid.?senior|associate|executive|director|no\s+response|available\s+yet)\b/i;
      const prefix = lines.slice(0, firstSignalIdx);
      const allNoise = prefix.every(l => !l.trim() || l.trim().length < 120 && _NOISE_LINE.test(l));
      return allNoise ? lines.slice(firstSignalIdx).join("\n").trim() : text;
    }

    // Generic article/main fallback — non-job-board only, must contain JD signal
    const _articleMain = (() => {
      if (_JOB_BOARDS.test(window.location.hostname)) return "";
      const el = document.querySelector("article, main, [role='main']");
      if (!el) return "";
      const text = el.innerText.trim();
      return _JD_SIGNAL.test(text) ? text : "";
    })();

    // Scan all description-like elements; pick first with real JD content
    const _descFallback = (() => {
      const els = document.querySelectorAll("[class*='job-desc' i],[class*='jobdesc' i],[id*='job-desc' i],[class*='description' i],[id*='description' i]");
      for (const el of els) {
        const t = el.innerText?.trim() || "";
        if (t.length > 150 && _JD_SIGNAL.test(t)) return t;
      }
      return "";
    })();

    const _rawDescription =
      schema.description ||
      extractText(sel.descSel) ||
      _descFallback ||
      _articleMain ||
      "";

    const description = _trimJDNoise(_rawDescription);

    const fields = extractFields(sel.labelSel);

    return {
      job_title,
      company,
      description: description.slice(0, 10000),
      fields: fields.map(({ label, type, currentValue, isQuestion }) =>
        ({ label, type, currentValue, isQuestion })
      ),
      url: window.location.href,
      platform: platform?.name || "unknown",
    };
  }

  // ─── Field auto-fill ──────────────────────────────────────────────────────

  /**
   * Fill a form field by label text.
   * Dispatches native events so React/Vue controlled inputs update their state.
   */
  function _normalizeLabel(t) {
    return (t || "").toLowerCase().replace(/[*\s]+/g, " ").trim();
  }

  window.__fillField = function (labelText, value) {
    const needle = _normalizeLabel(labelText);
    const labels = document.querySelectorAll("label, [data-automation-id='formLabel']");
    for (const label of labels) {
      const hay = _normalizeLabel(label.innerText);
      if (hay === needle || hay.startsWith(needle) || needle.startsWith(hay)) {
        let input = null;
        const forAttr = label.getAttribute("for");
        if (forAttr) input = document.getElementById(forAttr);
        if (!input) input = label.nextElementSibling;
        if (input && !["INPUT", "TEXTAREA", "SELECT"].includes(input.tagName)) {
          // Check for contenteditable rich text editor first
          const ce = input.querySelector("[contenteditable='true']");
          if (ce) { _fillContentEditable(ce, value); return true; }
          input = input.querySelector("input, textarea, select");
        }
        if (!input) input = label.querySelector("input, textarea, select");

        if (input) {
          _fillInput(input, value);
          return true;
        }

        // Check if label's parent contains a contenteditable editor
        const parentCe = label.closest("div, section, fieldset")?.querySelector("[contenteditable='true']");
        if (parentCe) { _fillContentEditable(parentCe, value); return true; }
      }
    }
    // Fallback: find any textarea whose placeholder/aria-label loosely matches
    const all = document.querySelectorAll("input, textarea");
    for (const el of all) {
      const hint = _normalizeLabel(el.placeholder || el.getAttribute("aria-label") || "");
      if (hint && hint.includes(needle.slice(0, 20))) {
        _fillInput(el, value);
        return true;
      }
    }
    // Last fallback: find the contenteditable that appears AFTER a "cover letter" label in DOM order
    if (needle.includes("cover letter") || needle.includes("cover_letter")) {
      // Get all elements with "cover letter" text and all contenteditable elements
      const allEls = Array.from(document.querySelectorAll("*"));
      const allCe = allEls.filter(el => el.getAttribute("contenteditable") === "true");

      // Find the index of the first element whose text contains "cover letter"
      let coverLabelIndex = -1;
      for (let i = 0; i < allEls.length; i++) {
        const el = allEls[i];
        // Only look at leaf-ish elements (labels, spans, p, legend) to avoid matching huge sections
        const tag = el.tagName.toLowerCase();
        if (!["label", "span", "p", "legend", "div", "h1", "h2", "h3", "h4"].includes(tag)) continue;
        // Skip elements that have many children (they are containers not labels)
        if (el.children.length > 3) continue;
        const t = _normalizeLabel(el.innerText);
        if (t === "cover letter" || t.startsWith("cover letter")) {
          coverLabelIndex = i;
          break;
        }
      }

      if (coverLabelIndex >= 0 && allCe.length > 0) {
        // Find the first contenteditable that comes AFTER the cover letter label in DOM order
        for (const ce of allCe) {
          const ceIndex = allEls.indexOf(ce);
          if (ceIndex > coverLabelIndex) {
            _fillContentEditable(ce, value);
            return true;
          }
        }
      }

      // If nothing found after the label, try the last contenteditable on the page
      // (cover letter is usually the last rich text field)
      if (allCe.length > 0) {
        _fillContentEditable(allCe[allCe.length - 1], value);
        return true;
      }
    }
    return false;
  };

  function _fillContentEditable(el, value) {
    el.focus();

    // Method 1: execCommand (works on most sites)
    try {
      document.execCommand("selectAll", false, null);
      const inserted = document.execCommand("insertText", false, value);
      if (inserted && el.innerText.trim()) return;
    } catch (_) {}

    // Method 2: set innerText directly and fire all events
    el.innerText = value;
    ["input", "change", "keyup", "blur"].forEach(evtName => {
      el.dispatchEvent(new Event(evtName, { bubbles: true }));
    });
    // React uses a special __reactFiber / __reactEventHandlers approach
    // Try triggering via InputEvent as well
    try {
      el.dispatchEvent(new InputEvent("input", { bubbles: true, data: value, inputType: "insertText" }));
    } catch (_) {}
  }

  function _fillInput(input, value) {
    const tag = input.tagName;
    // Handle React-controlled inputs — use native setter so React detects the change
    const proto = tag === "TEXTAREA"
      ? window.HTMLTextAreaElement.prototype
      : window.HTMLInputElement.prototype;
    const nativeSetter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
    if (nativeSetter) {
      nativeSetter.call(input, value);
    } else {
      input.value = value;
    }
    ["input", "change", "blur", "keyup"].forEach(evtName => {
      input.dispatchEvent(new Event(evtName, { bubbles: true }));
    });
    // Also dispatch a React-style InputEvent for sites using synthetic events
    try {
      input.dispatchEvent(new InputEvent("input", { bubbles: true, data: value }));
    } catch (_) {}
  }

  // ─── Sidebar injection ────────────────────────────────────────────────────

  const SIDEBAR_WIDTH = 380;

  function injectSidebar() {
    if (document.getElementById("__job-assistant-container")) return;

    const container = document.createElement("div");
    container.id = "__job-assistant-container";
    Object.assign(container.style, {
      position: "fixed",
      top: "0",
      right: "0",
      width: `${SIDEBAR_WIDTH}px`,
      height: "100vh",
      zIndex: "2147483647",
      boxShadow: "-2px 0 12px rgba(0,0,0,0.15)",
      transition: "transform 0.25s ease",
    });

    const iframe = document.createElement("iframe");
    iframe.src = chrome.runtime.getURL("sidebar/sidebar.html");
    Object.assign(iframe.style, {
      width: "100%",
      height: "100%",
      border: "none",
      background: "transparent",
    });
    container.appendChild(iframe);
    document.body.appendChild(container);

    // Toggle button
    const toggle = document.createElement("button");
    toggle.id = "__job-assistant-toggle";
    toggle.title = "Job Assistant";
    toggle.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
      <rect x="3" y="8" width="18" height="13" rx="3"/>
      <path d="M12 2v6"/>
      <circle cx="12" cy="2" r="1.2" fill="white" stroke="none"/>
      <rect x="1" y="12" width="2" height="5" rx="1" fill="white" stroke="none"/>
      <rect x="21" y="12" width="2" height="5" rx="1" fill="white" stroke="none"/>
      <circle cx="9" cy="14.5" r="1.8" fill="white" stroke="none"/>
      <circle cx="15" cy="14.5" r="1.8" fill="white" stroke="none"/>
      <path d="M8.5 18.5h7" stroke-width="1.6"/>
    </svg>`;
    Object.assign(toggle.style, {
      position: "fixed",
      top: "50%",
      right: `${SIDEBAR_WIDTH}px`,
      transform: "translateY(-50%)",
      zIndex: "2147483647",
      background: "#4752C4",
      color: "white",
      border: "none",
      borderRadius: "8px 0 0 8px",
      padding: "12px 7px",
      cursor: "pointer",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      boxShadow: "-2px 0 10px rgba(71,82,196,0.35)",
      transition: "right 0.25s ease, background 0.15s",
    });

    let sidebarOpen = true;
    toggle.addEventListener("click", () => {
      sidebarOpen = !sidebarOpen;
      container.style.transform = sidebarOpen ? "" : `translateX(${SIDEBAR_WIDTH}px)`;
      toggle.style.right = sidebarOpen ? `${SIDEBAR_WIDTH}px` : "0";
    });

    document.body.appendChild(toggle);
  }

  // ─── Communication with sidebar ───────────────────────────────────────────

  // Guard: returns false if the extension was reloaded/updated while this tab was open.
  // Calling chrome APIs after context invalidation throws "Extension context invalidated".
  function isContextValid() {
    try { return !!chrome.runtime?.id; } catch { return false; }
  }

  function safeSendMessage(msg) {
    if (!isContextValid()) return;
    try { chrome.runtime.sendMessage(msg); } catch (_) {}
  }

  // Merge freshly-extracted context with whatever was stored on previous pages,
  // so navigating job-listing → job-detail → /application never loses company/title.
  // Only merges if the stored context came from the same hostname — prevents
  // data from a previous site (e.g. LinkedIn) bleeding into a new site (e.g. Dice).
  function mergeWithStored(fresh, cb) {
    if (!isContextValid()) { cb(fresh); return; }
    try {
      chrome.storage.local.get("jobContext", (result) => {
        if (chrome.runtime.lastError) { cb(fresh); return; }
        const stored = result.jobContext || {};
        // Only reuse stored fields if the stored URL is from the same hostname
        const storedHost = (() => { try { return new URL(stored.url || "").hostname; } catch { return ""; } })();
        const sameHost = storedHost && storedHost === window.location.hostname;
        cb({
          ...fresh,
          company:     fresh.company     || (sameHost ? stored.company     : "") || "",
          job_title:   fresh.job_title   || (sameHost ? stored.job_title   : "") || "",
          description: fresh.description || (sameHost ? stored.description : "") || "",
        });
      });
    } catch (_) { cb(fresh); }
  }

  // ─── Pick-to-fill mode ───────────────────────────────────────────────────────
  let _pickMode = null; // { value, resolve }

  function _enterPickMode(value) {
    // Show banner
    const banner = document.createElement("div");
    banner.id = "__ja-pick-banner";
    Object.assign(banner.style, {
      position: "fixed", top: "0", left: "0", right: "380px",
      zIndex: "2147483646", background: "#5b5fe8", color: "#fff",
      padding: "10px 16px", fontSize: "14px", fontFamily: "sans-serif",
      display: "flex", alignItems: "center", justifyContent: "space-between",
      boxShadow: "0 2px 8px rgba(0,0,0,0.3)",
    });
    banner.innerHTML = `<span>👆 Click the field you want to fill</span><button id="__ja-pick-cancel" style="background:rgba(255,255,255,0.2);border:none;color:#fff;padding:4px 10px;border-radius:4px;cursor:pointer;font-size:13px">Cancel</button>`;
    document.body.appendChild(banner);

    // Highlight all fillable fields
    const fields = document.querySelectorAll("input:not([type=hidden]):not([type=submit]):not([type=button]):not([type=file]), textarea, [contenteditable='true']");
    fields.forEach(el => {
      el.dataset.__jaOrigOutline = el.style.outline || "";
      el.style.outline = "3px solid #5b5fe8";
      el.style.outlineOffset = "2px";
    });

    _pickMode = { value };

    document.getElementById("__ja-pick-cancel").addEventListener("click", _exitPickMode);

    // Listen for click on any field
    document._jaPick = function(e) {
      const el = e.target.closest("input, textarea, [contenteditable='true']");
      if (!el) return;
      e.preventDefault();
      e.stopPropagation();
      _exitPickMode();
      if (el.getAttribute("contenteditable") === "true") {
        _fillContentEditable(el, _pickMode?.value || value);
      } else {
        _fillInput(el, _pickMode?.value || value);
      }
      // Notify sidebar
      const iframe = document.querySelector("#__job-assistant-container iframe");
      if (iframe?.contentWindow) {
        iframe.contentWindow.postMessage({ type: "PICK_FILL_DONE" }, "*");
      }
    };
    document.addEventListener("click", document._jaPick, true);
  }

  function _exitPickMode() {
    _pickMode = null;
    document.getElementById("__ja-pick-banner")?.remove();
    document.querySelectorAll("input, textarea, [contenteditable='true']").forEach(el => {
      el.style.outline = el.dataset.__jaOrigOutline || "";
      el.style.outlineOffset = "";
    });
    document.removeEventListener("click", document._jaPick, true);
  }

  window.addEventListener("message", (event) => {
    if (event.data?.type === "FILL_FIELD") {
      const filled = window.__fillField(event.data.label, event.data.value);
      // If auto-fill failed, enter pick mode so user can click the field
      if (!filled) {
        _enterPickMode(event.data.value);
        const iframe = document.querySelector("#__job-assistant-container iframe");
        if (iframe?.contentWindow) {
          iframe.contentWindow.postMessage({ type: "PICK_MODE_STARTED" }, "*");
        }
      }
    }
    if (event.data?.type === "GET_PAGE_CONTEXT") {
      const platform = detectPlatform();
      const fresh = extractPageContext(platform);
      mergeWithStored(fresh, (context) => {
        safeSendMessage({ type: "STORE_JOB_CONTEXT", payload: context });
        event.source?.postMessage({ type: "PAGE_CONTEXT", context }, "*");
      });
    }
  });

  // ─── Init ─────────────────────────────────────────────────────────────────

  function _pushToSidebar(context) {
    const iframe = document.querySelector("#__job-assistant-container iframe");
    if (iframe?.contentWindow) {
      iframe.contentWindow.postMessage({ type: "PAGE_CONTEXT", context }, "*");
    }
  }

  function init() {
    if (!isContextValid()) return;
    if (!isJobApplicationPage()) return;

    const platform = detectPlatform();
    const fresh = extractPageContext(platform);
    mergeWithStored(fresh, (context) => {
      safeSendMessage({ type: "STORE_JOB_CONTEXT", payload: context });
      _pushToSidebar(context);

      // AI fallback: if company or role is still empty after all heuristics,
      // send page text to Claude (Haiku) to extract them
      if ((!context.company || !context.job_title) && isContextValid()) {
        const pageText = (document.body?.innerText || "").slice(0, 3000);
        if (pageText.length > 50) {
          chrome.runtime.sendMessage(
            { type: "AI_EXTRACT_CONTEXT", payload: { page_text: pageText } },
            (resp) => {
              if (chrome.runtime.lastError || !resp?.ok) return;
              if (resp.company || resp.job_title) {
                const updated = {
                  ...context,
                  company:   context.company   || resp.company   || "",
                  job_title: context.job_title || resp.job_title || "",
                };
                _pushToSidebar(updated);
              }
            }
          );
        }
      }
    });
    injectSidebar();
  }

  // Run on load, and again after a short delay for SPAs that render async
  if (document.readyState === "complete" || document.readyState === "interactive") {
    init();
  } else {
    document.addEventListener("DOMContentLoaded", init);
  }
  setTimeout(init, 2000);
  setTimeout(init, 4000);  // second pass for slow-rendering SPAs (LinkedIn, Workday)

  // SPA navigation: re-run when URL changes without a full page reload
  // (React/Next.js router, history.pushState, etc.)
  let _lastUrl = location.href;
  new MutationObserver(() => {
    if (location.href !== _lastUrl) {
      _lastUrl = location.href;
      // Clear stored context so the new job doesn't inherit the previous job's company/title/JD
      try { chrome.storage.local.remove("jobContext"); } catch (_) {}
      // Small delay so the new page content renders before we extract
      setTimeout(init, 800);
      setTimeout(init, 2500);  // second pass in case the new job page is slow to render
    }
  }).observe(document.body || document.documentElement, { childList: true, subtree: true });

})();
