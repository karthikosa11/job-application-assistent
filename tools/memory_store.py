"""
Q&A memory store using Jaccard similarity for fuzzy matching.
Now backed by PostgreSQL (memory_entries table) instead of memory.json.
All public functions accept a user_id parameter.
"""

import uuid
from datetime import datetime, timezone

from sqlalchemy.orm import Session

from tools.models import MemoryEntry

STOP_WORDS = {
    "a", "an", "the", "and", "or", "but", "in", "on", "at", "to", "for",
    "of", "with", "by", "from", "is", "are", "was", "were", "be", "been",
    "being", "have", "has", "had", "do", "does", "did", "will", "would",
    "could", "should", "may", "might", "can", "you", "your", "i", "my",
    "we", "our", "it", "its", "this", "that", "what", "how", "why", "when",
    "where", "which", "who", "please", "tell", "us", "about",
}


def _tokenize(text: str) -> set:
    tokens = set(text.lower().split())
    return tokens - STOP_WORDS


def _jaccard(a: set, b: set) -> float:
    if not a or not b:
        return 0.0
    return len(a & b) / len(a | b)


def _entry_to_dict(entry: MemoryEntry) -> dict:
    return {
        "id": entry.entry_id,
        "question": entry.question,
        "answer": entry.answer,
        "used_count": entry.used_count,
        "created_at": entry.created_at.isoformat() if entry.created_at else None,
        "last_used": entry.last_used.isoformat() if entry.last_used else None,
        "metadata": {
            "company": entry.meta_company or "",
            "role": entry.meta_role or "",
            "platform": entry.meta_platform or "",
        },
    }


def save(db: Session, user_id: str, question: str, answer: str, metadata: dict = None) -> dict:
    """
    Save a Q&A pair. If a very similar question (>0.8 Jaccard) already exists,
    update it instead of creating a duplicate.
    Returns the saved entry as a dict.
    """
    metadata = metadata or {}
    q_tokens = _tokenize(question)

    # Load all entries for this user to check duplicates
    entries = db.query(MemoryEntry).filter_by(user_id=user_id).all()

    for entry in entries:
        if _jaccard(_tokenize(entry.question), q_tokens) > 0.8:
            entry.answer = answer
            entry.used_count = (entry.used_count or 1) + 1
            entry.last_used = datetime.now(timezone.utc)
            entry.meta_company = metadata.get("company", "")
            entry.meta_role = metadata.get("role", "")
            entry.meta_platform = metadata.get("platform", "")
            db.commit()
            db.refresh(entry)
            return _entry_to_dict(entry)

    new_entry = MemoryEntry(
        user_id=user_id,
        entry_id=str(uuid.uuid4())[:8],
        question=question,
        answer=answer,
        used_count=1,
        meta_company=metadata.get("company", ""),
        meta_role=metadata.get("role", ""),
        meta_platform=metadata.get("platform", ""),
    )
    db.add(new_entry)
    db.commit()
    db.refresh(new_entry)
    return _entry_to_dict(new_entry)


def search(db: Session, user_id: str, query: str, top_k: int = 5) -> list:
    """
    Return up to top_k entries with Jaccard similarity > 0.4, sorted by score.
    """
    entries = db.query(MemoryEntry).filter_by(user_id=user_id).all()
    q_tokens = _tokenize(query)
    scored = []
    for entry in entries:
        score = _jaccard(_tokenize(entry.question), q_tokens)
        if score > 0.4:
            scored.append({**_entry_to_dict(entry), "_score": round(score, 3)})
    scored.sort(key=lambda x: x["_score"], reverse=True)
    return scored[:top_k]


def format_memory_context(matches: list) -> str:
    """Format search results into a string for the Claude prompt."""
    if not matches:
        return ""
    return "\n\n".join(f'Q: {m["question"]}\nA: {m["answer"]}' for m in matches)


def get_all(db: Session, user_id: str) -> list:
    entries = db.query(MemoryEntry).filter_by(user_id=user_id).order_by(MemoryEntry.last_used.desc()).all()
    return [_entry_to_dict(e) for e in entries]


def delete(db: Session, user_id: str, entry_id: str) -> bool:
    entry = db.query(MemoryEntry).filter_by(user_id=user_id, entry_id=entry_id).first()
    if entry:
        db.delete(entry)
        db.commit()
        return True
    return False
