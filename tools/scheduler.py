"""
APScheduler wrapper for the daily WhatsApp summary.
Uses BackgroundScheduler (daemon thread) with a CronTrigger so it fires
at a specific wall-clock time in the user's timezone.
"""

import logging

import pytz
from apscheduler.schedulers.background import BackgroundScheduler
from apscheduler.triggers.cron import CronTrigger

logger = logging.getLogger(__name__)

_scheduler = BackgroundScheduler()
JOB_ID = "daily_summary"


def _run_daily_summary():
    """Called by APScheduler at the configured time each day."""
    try:
        from sheets_logger import get_all_applications
        from whatsapp_notify import send_daily_summary
        apps = get_all_applications()
        send_daily_summary(apps)
        logger.info("[Scheduler] Daily summary sent (%d apps)", len(apps))
    except Exception as e:
        logger.error("[Scheduler] Daily summary failed: %s", e)


def start(summary_time: str = "09:00", timezone_str: str = "UTC", enabled: bool = True):
    """
    Start the scheduler with a daily summary job.

    summary_time: "HH:MM" in 24-hour format
    timezone_str: IANA timezone string, e.g. "Asia/Kolkata", "America/New_York"
    enabled:      if False, scheduler starts but no job is scheduled
    """
    if _scheduler.running:
        return

    _scheduler.start()
    logger.info("[Scheduler] Started.")

    if enabled:
        _schedule_job(summary_time, timezone_str)


def _schedule_job(summary_time: str, timezone_str: str):
    try:
        hour, minute = map(int, summary_time.split(":"))
        tz = pytz.timezone(timezone_str)
    except Exception as e:
        logger.error("[Scheduler] Invalid time/timezone (%s %s): %s", summary_time, timezone_str, e)
        return

    _scheduler.add_job(
        _run_daily_summary,
        trigger=CronTrigger(hour=hour, minute=minute, timezone=tz),
        id=JOB_ID,
        replace_existing=True,
        name="Daily WhatsApp Summary",
    )
    logger.info("[Scheduler] Daily summary scheduled at %s %s", summary_time, timezone_str)


def update_schedule(summary_time: str, timezone_str: str, enabled: bool = True):
    """
    Hot-reload the daily summary schedule. Called when user changes settings
    in the Options page via POST /config.
    """
    if not _scheduler.running:
        start(summary_time, timezone_str, enabled)
        return

    # Remove existing job
    try:
        _scheduler.remove_job(JOB_ID)
    except Exception:
        pass

    if enabled:
        _schedule_job(summary_time, timezone_str)
    else:
        logger.info("[Scheduler] Daily summary disabled.")


def trigger_now():
    """Immediately run the daily summary (used by /notify/daily-summary endpoint)."""
    _run_daily_summary()


def shutdown():
    if _scheduler.running:
        _scheduler.shutdown(wait=False)
