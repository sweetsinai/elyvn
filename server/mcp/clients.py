"""
Multi-client config manager.
Loads client knowledge bases from JSON files and provides lookup helpers.
"""

import json
import logging
import os
from pathlib import Path
from typing import Optional

from db import get_client as db_get_client, get_client_by_phone as db_get_by_phone, get_all_active_clients as db_all_active

logger = logging.getLogger(__name__)

KB_DIR = Path(__file__).parent / "knowledge_bases"
TEMPLATE_DIR = Path(__file__).parent / "templates"

# In-memory cache: client_id -> parsed KB dict
_kb_cache: dict[str, dict] = {}


def _load_kb(client_id: str) -> Optional[dict]:
    """Load and cache a client knowledge base JSON file."""
    kb_path = KB_DIR / f"{client_id}.json"
    if not kb_path.exists():
        logger.warning("KB file not found for client %s at %s", client_id, kb_path)
        return None
    try:
        with open(kb_path, "r") as f:
            data = json.load(f)
        _kb_cache[client_id] = data
        return data
    except (json.JSONDecodeError, IOError) as e:
        logger.error("Failed to load KB for client %s: %s", client_id, e)
        return None


def get_client_kb(client_id: str) -> Optional[dict]:
    """Return parsed knowledge base for a client, using cache if available."""
    if client_id in _kb_cache:
        return _kb_cache[client_id]
    return _load_kb(client_id)


def reload_kb(client_id: str) -> Optional[dict]:
    """Force reload a client's KB from disk."""
    _kb_cache.pop(client_id, None)
    return _load_kb(client_id)


def get_template(client_id: str, template_name: str) -> Optional[str]:
    """Load a text template file for a client. Returns None if not found."""
    path = TEMPLATE_DIR / client_id / template_name
    if not path.exists():
        logger.warning("Template not found: %s", path)
        return None
    try:
        return path.read_text()
    except IOError as e:
        logger.error("Failed to read template %s: %s", path, e)
        return None


async def get_client_by_phone(retell_phone: str) -> Optional[dict]:
    """Look up a client config by their Retell phone number."""
    return await db_get_by_phone(retell_phone)


async def get_all_active_clients() -> list[dict]:
    """Return all active client configs."""
    return await db_all_active()


async def load_all_kbs() -> int:
    """Pre-load all KB files found in the knowledge_bases directory. Returns count loaded."""
    count = 0
    if not KB_DIR.exists():
        logger.warning("Knowledge bases directory not found: %s", KB_DIR)
        return 0
    for f in KB_DIR.glob("*.json"):
        client_id = f.stem
        if _load_kb(client_id):
            count += 1
    logger.info("Loaded %d knowledge bases from %s", count, KB_DIR)
    return count
