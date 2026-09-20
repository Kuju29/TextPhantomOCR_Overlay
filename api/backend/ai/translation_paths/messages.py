"""History serialization only; provider controls/transport remain in adapters."""
from __future__ import annotations


def history_parts(history):
    return [str(message.get("text", "")) for message in (history or ())]


def native_history(history, protocol="openai"):
    result = []
    for message in history or ():
        role, text = message["role"], str(message.get("text", ""))
        if role not in ("user", "assistant"):
            raise ValueError("History contains an invalid role")
        image = str(message.get("image_b64") or "")
        mime = str(message.get("image_mime") or "image/jpeg")
        if protocol == "gemini":
            parts = ([{"inline_data": {"mime_type": mime, "data": image}}] if image else []) + [{"text": text}]
            result.append({"role": "model" if role == "assistant" else "user", "parts": parts})
        elif protocol == "ollama":
            result.append({"role": role, "content": text, **({"images": [image]} if image else {})})
        elif protocol == "anthropic":
            content = ([{"type": "image", "source": {"type": "base64", "media_type": mime, "data": image}},
                        {"type": "text", "text": text}] if image else text)
            result.append({"role": role, "content": content})
        elif protocol == "openai_image_first":
            content = ([{"type":"image_url","image_url":{"url":f"data:{mime};base64,{image}"}},
                        {"type":"text","text":text}] if image else text)
            result.append({"role":role,"content":content})
        else:
            content = ([{"type": "text", "text": text}, {"type": "image_url", "image_url": {"url": f"data:{mime};base64,{image}"}}] if image else text)
            result.append({"role": role, "content": content})
    return result


def insert_history(messages, history, protocol="openai"):
    if not history:
        return messages
    first = 1 if messages and messages[0].get("role") in ("system", "developer") else 0
    return messages[:first] + native_history(history, protocol) + messages[first:]
