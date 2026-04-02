Job Application Assistant

A Chrome extension that helps you apply for jobs faster using AI. It reads job postings automatically, gives you tailored advice based on your resume, generates cover letters, and logs everything to Google Sheets — all without leaving the job page.

Built with Python, Flask, PostgreSQL, AWS, and Anthropic Claude.

What it does
When you open a job posting on LinkedIn, Indeed, Greenhouse, or any major job board, a panel slides in on the right side of your browser. From there you can:

Get a Suggestion — AI reads the job description and your resume and tells you exactly how to position yourself for that role
Generate a Cover Letter — one click writes a full cover letter tailored to that specific job
Log the Application — saves the job to your history and adds a row to your Google Sheet automatically
Chat with AI — ask questions about the job, get interview tips, salary guidance, anything
Memory — remembers answers you gave on past applications and suggests them when similar questions come up again
Supported job platforms
LinkedIn, Indeed, Glassdoor, Greenhouse, Lever, Workday, ZipRecruiter, Wellfound, iCIMS, SmartRecruiters, Dice, Builtin, Workable, Taleo, Jobvite, and more.

Tech stack
Extension

Chrome Extension Manifest V3
Vanilla JavaScript
Chrome Identity API for Google OAuth
Backend

Python, Flask, Gunicorn
PostgreSQL (Amazon RDS)
SQLAlchemy + Alembic migrations
JWT authentication
Fernet encryption for sensitive data
AI

Anthropic Claude (users bring their own API key)
RAG-based memory system for reusing past application answers
Prompt engineering for suggestions, cover letters, and chat
Infrastructure

AWS App Runner (server hosting)
AWS S3 (resume file storage)
AWS ECR (Docker image registry)
Amazon SES (email notifications)
Docker for containerization
How to set it up
1. Clone the repo

git clone https://github.com/karthikosa11/job-application-assistant.git
cd job-application-assistant
2. Set up environment variables

cp .env.production.example .env
Fill in these values in your .env file:


DATABASE_URL=postgresql://user:pass@host:5432/jobassist
S3_BUCKET_NAME=your-bucket-name
S3_REGION=us-east-1
AWS_ACCESS_KEY_ID=...
AWS_SECRET_ACCESS_KEY=...
JWT_SECRET=...
ENCRYPTION_KEY=...
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
APP_URL=https://your-app-runner-url.awsapprunner.com
FEEDBACK_EMAIL=your@email.com
3. Run database migrations

pip install -r requirements.txt
alembic upgrade head
4. Start the server

python tools/server.py
Or with Docker:


docker build -t job-assistant .
docker run -p 8080:8080 --env-file .env job-assistant
5. Load the extension in Chrome
Open Chrome and go to chrome://extensions
Turn on Developer mode (top right toggle)
Click Load unpacked
Select the extension/ folder
How to use it
Sign in with Google in the extension popup
Go to Settings and enter your Anthropic API key
Upload your resume in the Settings page
Open any job posting — the sidebar will appear automatically
Click Get Suggestion to get AI feedback, or Generate Cover Letter to write one
For Google Sheets tracking:

Create a new Google Sheet
Copy the Sheet ID from the URL (the long string in the middle)
Paste it in Settings under Google Sheets ID and save
