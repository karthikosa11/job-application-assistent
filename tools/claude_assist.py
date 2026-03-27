"""
Claude API wrapper.
Four functions:
  - get_suggestion()       Generate an answer for a job application field
  - classify_email()       Classify a reply email (interview/rejection/etc.)
  - extract_company()      Extract company name from email (beats domain heuristics)
  - extract_job_type()     Extract employment type from job description (no guessing)
"""

import os
from anthropic import Anthropic
from dotenv import load_dotenv

load_dotenv()

MODEL = "claude-sonnet-4-6"


def _client(api_key: str | None = None) -> Anthropic:
    """Return an Anthropic client using the provided key or fall back to env."""
    return Anthropic(api_key=api_key or os.getenv("ANTHROPIC_API_KEY"))


def get_suggestion(
    field_label: str,
    field_type: str,
    page_context: dict,
    resume_text: str,
    memory_context: str = "",
    api_key: str | None = None,
) -> str:
    """
    Generate an answer for a job application form field.

    page_context: { job_title, company, description }
    resume_text:  full text of the active resume
    memory_context: past similar answers (pre-formatted string)
    """
    job_title = page_context.get("job_title", "")
    company = page_context.get("company", "")
    job_desc = page_context.get("description", "")[:3000]  # cap to save tokens

    length_hint = "Keep your answer under 3 sentences." if field_type == "text" else \
                  "Keep your answer concise and professional (under 300 words)." if field_type == "textarea" else \
                  "Keep your answer brief."

    memory_block = f"\n\nRelevant past answers you've given:\n{memory_context}" if memory_context else ""

    user_msg = f"""You are helping fill in a job application form field.

Job: {job_title} at {company}
Job Description:
{job_desc}

Resume:
{resume_text[:4000]}
{memory_block}

Field label: "{field_label}"
Field type: {field_type}

Write an authentic, specific answer for this field based ONLY on information in the resume and job description above.
Do NOT fabricate skills, experiences, or facts that are not in the resume.
{length_hint}
Reply with only the answer text, nothing else."""

    response = _client(api_key).messages.create(
        model=MODEL,
        max_tokens=400,
        system="You are a job application assistant. Write honest, authentic answers using only provided information. Never fabricate or embellish.",
        messages=[{"role": "user", "content": user_msg}],
    )
    return response.content[0].text.strip()


def classify_email_status(subject: str, body: str, api_key: str | None = None) -> str:
    """
    Classify a job-related email into one of:
      Rejection | Interview Request | Offer | Screening | General Response | Not Job Related

    Returns the exact label string.
    """
    response = _client(api_key).messages.create(
        model=MODEL,
        max_tokens=10,
        system=(
            "Classify the following email into exactly one of these categories: "
            "Rejection, Interview Request, Offer, Screening, General Response, Not Job Related. "
            "Reply with only the category name, nothing else."
        ),
        messages=[{
            "role": "user",
            "content": f"Subject: {subject}\n\nBody:\n{body[:1500]}"
        }],
    )
    result = response.content[0].text.strip()
    valid = {"Rejection", "Interview Request", "Offer", "Screening", "General Response", "Not Job Related"}
    return result if result in valid else "General Response"


def extract_company_from_email(subject: str, body: str, sender: str, api_key: str | None = None) -> str:
    """
    Extract the hiring company name from an email.
    Returns the company name, or "UNKNOWN" if it cannot be determined.

    This replaces the fragile domain-based heuristic that breaks for
    ATS senders like noreply@greenhouse-mail.io or jobs@lever.co.
    """
    response = _client(api_key).messages.create(
        model=MODEL,
        max_tokens=30,
        system=(
            "Extract the name of the company that sent this job-related email. "
            "Reply with only the company name. "
            "If you cannot determine the company from the content, reply with exactly: UNKNOWN"
        ),
        messages=[{
            "role": "user",
            "content": f"From: {sender}\nSubject: {subject}\n\nBody:\n{body[:1000]}"
        }],
    )
    return response.content[0].text.strip()


def extract_job_type(job_description: str, api_key: str | None = None) -> str | None:
    """
    Extract the employment type from a job description.
    Only returns a value if the JD explicitly states the type.
    Returns None if not found — never guesses.

    Valid return values:
      Full Time | Part Time | Contract | C2C | W2 | Contract-to-Hire
    """
    if not job_description or len(job_description.strip()) < 20:
        return None

    response = _client(api_key).messages.create(
        model=MODEL,
        max_tokens=15,
        system=(
            "Read the job description and return ONLY the employment type if it is explicitly stated. "
            "Valid values are: Full Time, Part Time, Contract, C2C, W2, Contract-to-Hire. "
            "If the employment type is NOT explicitly written in the job description, reply with exactly: NONE. "
            "Do not guess or infer. Reply with nothing else."
        ),
        messages=[{
            "role": "user",
            "content": job_description[:3000]
        }],
    )
    result = response.content[0].text.strip()
    valid = {"Full Time", "Part Time", "Contract", "C2C", "W2", "Contract-to-Hire"}
    return result if result in valid else None


def extract_job_context(page_text: str, api_key: str | None = None) -> dict:
    """
    AI fallback: extract job title and company name from raw visible page text.
    Used when CSS selectors and heuristics both fail to find one or both values.
    Uses Haiku for speed and low cost.
    Returns { "role": str, "company": str } — empty string if not found.
    """
    if not page_text or len(page_text.strip()) < 30:
        return {"role": "", "company": ""}

    response = _client(api_key).messages.create(
        model="claude-haiku-4-5-20251001",
        max_tokens=60,
        system=(
            "Extract the job title and company name from this job posting page. "
            "Reply with ONLY a JSON object: {\"role\": \"...\", \"company\": \"...\"}. "
            "Use empty string if you cannot determine a value with confidence. "
            "Never guess or infer — only extract what is explicitly stated."
        ),
        messages=[{"role": "user", "content": page_text[:3000]}],
    )
    import json as _json, re as _re
    text = response.content[0].text.strip()
    m = _re.search(r'\{[^}]+\}', text)
    if m:
        try:
            return _json.loads(m.group())
        except Exception:
            pass
    return {"role": "", "company": ""}


def generate_cover_letter(
    resume_text: str,
    job_description: str,
    company: str,
    role: str,
    api_key: str | None = None,
) -> str:
    """
    Generate a professional cover letter tailored to the job and resume.
    Returns plain text (no markdown headers).
    """
    prompt = f"""Write a professional cover letter for the following job application.

Company: {company}
Role: {role}

Job Description:
{job_description[:3000]}

Resume:
{resume_text[:4000]}

Guidelines:
- 3–4 paragraphs, plain text, no markdown
- Opening: express genuine interest in the role and company
- Body: highlight 2–3 specific, relevant experiences from the resume that match the JD
- Closing: call to action, professional sign-off
- Do NOT start with "Dear Hiring Manager" unless nothing better is available
- Use the company name naturally in the letter
- Keep it under 350 words
- Reply with only the cover letter text, nothing else"""

    response = _client(api_key).messages.create(
        model=MODEL,
        max_tokens=600,
        system="You are a professional career coach writing cover letters. Be specific, authentic, and avoid generic phrases.",
        messages=[{"role": "user", "content": prompt}],
    )
    return response.content[0].text.strip()
