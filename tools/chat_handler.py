"""Chat handler — Claude, OpenAI, Gemini. Uses per-user API keys, falls back to env vars."""

import os
from dotenv import load_dotenv

load_dotenv()

_DEFAULT_SYSTEM = (
    "You are a helpful job application assistant. "
    "Answer questions clearly and concisely to help the user fill out job applications."
)


def get_available_models(api_keys: dict | None = None) -> list[dict]:
    """
    Return models whose API key is available.
    api_keys: { "anthropic": "sk-ant-...", "openai": "sk-...", "gemini": "AIza..." }
    Falls back to environment variables if api_keys is not provided.
    """
    keys = api_keys or {}
    models = []
    if keys.get("anthropic") or os.getenv("ANTHROPIC_API_KEY"):
        models.append({"id": "claude-sonnet-4-6", "name": "Claude Sonnet", "provider": "anthropic"})
    if keys.get("openai") or os.getenv("OPENAI_API_KEY"):
        models.append({"id": "gpt-4o", "name": "GPT-4o", "provider": "openai"})
    if keys.get("gemini") or os.getenv("GOOGLE_AI_API_KEY"):
        models.append({"id": "gemini-1.5-flash", "name": "Gemini 1.5 Flash", "provider": "google"})
    return models


def chat(
    model_id: str,
    messages: list[dict],
    system_prompt: str = "",
    api_keys: dict | None = None,
) -> str:
    """
    Send a multi-turn conversation to the selected model.

    api_keys: { "anthropic": str, "openai": str, "gemini": str }
    """
    keys = api_keys or {}
    if model_id.startswith("claude"):
        return _chat_claude(model_id, messages, system_prompt, keys.get("anthropic"))
    elif model_id.startswith("gpt"):
        return _chat_openai(model_id, messages, system_prompt, keys.get("openai"))
    elif model_id.startswith("gemini"):
        return _chat_gemini(model_id, messages, system_prompt, keys.get("gemini"))
    else:
        raise ValueError(f"Unknown model: {model_id}")


def _chat_claude(model_id: str, messages: list[dict], system_prompt: str, api_key: str | None) -> str:
    import anthropic
    client = anthropic.Anthropic(api_key=api_key or os.getenv("ANTHROPIC_API_KEY"))
    response = client.messages.create(
        model=model_id,
        max_tokens=1024,
        system=system_prompt or _DEFAULT_SYSTEM,
        messages=messages,
    )
    return response.content[0].text


def _chat_openai(model_id: str, messages: list[dict], system_prompt: str, api_key: str | None) -> str:
    from openai import OpenAI
    client = OpenAI(api_key=api_key or os.getenv("OPENAI_API_KEY"))
    openai_messages = [{"role": "system", "content": system_prompt or _DEFAULT_SYSTEM}]
    openai_messages.extend(messages)
    response = client.chat.completions.create(
        model=model_id, messages=openai_messages, max_tokens=1024,
    )
    return response.choices[0].message.content


def _chat_gemini(model_id: str, messages: list[dict], system_prompt: str, api_key: str | None) -> str:
    import google.generativeai as genai
    genai.configure(api_key=api_key or os.getenv("GOOGLE_AI_API_KEY"))
    model = genai.GenerativeModel(model_id, system_instruction=system_prompt or _DEFAULT_SYSTEM)
    history = []
    for m in messages[:-1]:
        gemini_role = "model" if m["role"] == "assistant" else "user"
        history.append({"role": gemini_role, "parts": [m["content"]]})
    chat_session = model.start_chat(history=history)
    response = chat_session.send_message(messages[-1]["content"])
    return response.text
