"""Minimal markdown -> Notion block converter.

This is a deliberately small, stdlib-only converter built for phase-two
doc/runbook sync. Notion API limits we honor here:

- Each `rich_text` block in a single block has a 2000-char cap; we truncate
  to a configurable `max_block_chars` (default 1900) with a clear marker.
- A single `PATCH /v1/blocks/{id}/children` request accepts at most 100
  children; `chunk_blocks` slices a long block list into multiple requests.

Supported markdown constructs:

- Paragraphs (`paragraph`)
- ATX-style headings 1-3 (`heading_1`, `heading_2`, `heading_3`)
- Unordered list items (`-`, `*`, `+`) -> `bulleted_list_item`
- Ordered list items (`1.`, `2.` ...) -> `numbered_list_item`
- Blockquotes (`>`) -> `quote`
- Fenced code blocks (```lang ... ```) -> `code`
- Thematic breaks (`---`, `***`, `___`) -> `divider`

Inline markdown (bold, italic, inline code) is passed through as plain text
for the MVP; the goal is fidelity for whole-block structure, not inline span
parsing. No external dependency is introduced.
"""

from __future__ import annotations

import re
from typing import Optional


DEFAULT_MAX_BLOCK_CHARS = 1900
DEFAULT_CHUNK_SIZE = 100
TRUNCATION_MARKER = "... [truncated]"

# Notion's documented set of code-block languages we map to. Anything outside
# the whitelist falls back to "plain text" so the API does not 400.
_NOTION_CODE_LANGUAGES = frozenset(
    {
        "abap", "arduino", "bash", "basic", "c", "clojure", "coffeescript",
        "c++", "c#", "css", "dart", "diff", "docker", "elixir", "elm",
        "erlang", "flow", "fortran", "f#", "gherkin", "glsl", "go",
        "graphql", "groovy", "haskell", "html", "java", "javascript",
        "json", "julia", "kotlin", "latex", "less", "lisp", "livescript",
        "lua", "makefile", "markdown", "markup", "matlab", "mermaid", "nix",
        "objective-c", "ocaml", "pascal", "perl", "php", "plain text",
        "powershell", "prolog", "protobuf", "python", "r", "reason", "ruby",
        "rust", "sass", "scala", "scheme", "scss", "shell", "sql", "swift",
        "typescript", "vb.net", "verilog", "vhdl", "visual basic",
        "webassembly", "xml", "yaml",
    }
)

# Aliases the user might write into a fence info string that map to a
# recognized Notion language.
_LANGUAGE_ALIASES = {
    "sh": "shell",
    "zsh": "shell",
    "py": "python",
    "js": "javascript",
    "ts": "typescript",
    "rb": "ruby",
    "rs": "rust",
    "cpp": "c++",
    "cxx": "c++",
    "cs": "c#",
    "fs": "f#",
    "md": "markdown",
    "tex": "latex",
    "yml": "yaml",
    "dockerfile": "docker",
    "objc": "objective-c",
    "text": "plain text",
    "txt": "plain text",
    "": "plain text",
}

_HEADING_RE = re.compile(r"^(#{1,6})\s+(.*)$")
_UL_RE = re.compile(r"^\s*[-*+]\s+(.*)$")
_OL_RE = re.compile(r"^\s*\d+\.\s+(.*)$")
_BQ_RE = re.compile(r"^\s*>\s?(.*)$")
_FENCE_RE = re.compile(r"^\s*(```|~~~)\s*([^\s`~]*)\s*$")
_THEMATIC_RE = re.compile(r"^\s*([-*_])(?:\s*\1){2,}\s*$")


def _truncate(text: str, limit: int) -> str:
    """Truncate a single block's text to `limit` chars (incl. marker).

    Notion rejects rich_text blocks longer than ~2000 chars, so callers
    typically pass 1900 to leave headroom. We always preserve a visible
    marker so consumers know the page was clipped.
    """
    if limit <= 0:
        return ""
    if len(text) <= limit:
        return text
    marker = TRUNCATION_MARKER
    if limit <= len(marker):
        return text[:limit]
    head = text[: limit - len(marker)]
    return head + marker


def _rich_text(text: str) -> list[dict]:
    if not text:
        return []
    return [{"type": "text", "text": {"content": text}}]


def _normalize_language(lang: str) -> str:
    raw = (lang or "").strip().lower()
    if raw in _LANGUAGE_ALIASES:
        return _LANGUAGE_ALIASES[raw]
    if raw in _NOTION_CODE_LANGUAGES:
        return raw
    return "plain text"


def _make_paragraph(text: str, limit: int) -> dict:
    safe = _truncate(text, limit)
    return {
        "object": "block",
        "type": "paragraph",
        "paragraph": {"rich_text": _rich_text(safe)},
    }


def _make_heading(level: int, text: str, limit: int) -> dict:
    if level < 1:
        level = 1
    if level > 3:
        level = 3
    safe = _truncate(text, limit)
    key = f"heading_{level}"
    return {
        "object": "block",
        "type": key,
        key: {"rich_text": _rich_text(safe)},
    }


def _make_list_item(kind: str, text: str, limit: int) -> dict:
    safe = _truncate(text, limit)
    return {
        "object": "block",
        "type": kind,
        kind: {"rich_text": _rich_text(safe)},
    }


def _make_quote(text: str, limit: int) -> dict:
    safe = _truncate(text, limit)
    return {
        "object": "block",
        "type": "quote",
        "quote": {"rich_text": _rich_text(safe)},
    }


def _make_code(text: str, language: str, limit: int) -> dict:
    safe = _truncate(text, limit)
    return {
        "object": "block",
        "type": "code",
        "code": {
            "rich_text": _rich_text(safe),
            "language": _normalize_language(language),
        },
    }


def _make_divider() -> dict:
    return {"object": "block", "type": "divider", "divider": {}}


def markdown_to_blocks(
    markdown: str,
    *,
    max_block_chars: int = DEFAULT_MAX_BLOCK_CHARS,
) -> list[dict]:
    """Convert a markdown string into a list of Notion block payloads.

    Returns an empty list for empty/whitespace input. The result preserves
    the original document order: each construct produces exactly one block,
    and the rich_text content of every block is truncated to
    `max_block_chars`.
    """
    if max_block_chars is None or max_block_chars < 1:
        max_block_chars = DEFAULT_MAX_BLOCK_CHARS

    if markdown is None:
        return []
    text = markdown.replace("\r\n", "\n").replace("\r", "\n")
    if not text.strip():
        return []

    lines = text.split("\n")
    blocks: list[dict] = []

    paragraph_buf: list[str] = []

    def flush_paragraph() -> None:
        if not paragraph_buf:
            return
        joined = " ".join(s.strip() for s in paragraph_buf if s.strip())
        paragraph_buf.clear()
        if joined:
            blocks.append(_make_paragraph(joined, max_block_chars))

    i = 0
    while i < len(lines):
        line = lines[i]

        # Fenced code block — capture everything until the matching fence.
        fence = _FENCE_RE.match(line)
        if fence:
            flush_paragraph()
            language = fence.group(2) or ""
            code_lines: list[str] = []
            i += 1
            while i < len(lines):
                if _FENCE_RE.match(lines[i]):
                    i += 1
                    break
                code_lines.append(lines[i])
                i += 1
            blocks.append(
                _make_code("\n".join(code_lines), language, max_block_chars)
            )
            continue

        # Blank line ends the current paragraph run.
        if not line.strip():
            flush_paragraph()
            i += 1
            continue

        # Thematic break.
        if _THEMATIC_RE.match(line):
            flush_paragraph()
            blocks.append(_make_divider())
            i += 1
            continue

        # Heading.
        heading = _HEADING_RE.match(line)
        if heading:
            flush_paragraph()
            level = len(heading.group(1))
            blocks.append(
                _make_heading(level, heading.group(2).strip(), max_block_chars)
            )
            i += 1
            continue

        # Blockquote.
        bq = _BQ_RE.match(line)
        if bq:
            flush_paragraph()
            blocks.append(_make_quote(bq.group(1).strip(), max_block_chars))
            i += 1
            continue

        # Unordered list item.
        ul = _UL_RE.match(line)
        if ul:
            flush_paragraph()
            blocks.append(
                _make_list_item(
                    "bulleted_list_item", ul.group(1).strip(), max_block_chars
                )
            )
            i += 1
            continue

        # Ordered list item.
        ol = _OL_RE.match(line)
        if ol:
            flush_paragraph()
            blocks.append(
                _make_list_item(
                    "numbered_list_item", ol.group(1).strip(), max_block_chars
                )
            )
            i += 1
            continue

        # Otherwise: part of the current paragraph.
        paragraph_buf.append(line)
        i += 1

    flush_paragraph()
    return blocks


def chunk_blocks(
    blocks: list[dict], chunk_size: int = DEFAULT_CHUNK_SIZE
) -> list[list[dict]]:
    """Slice a block list into batches of at most `chunk_size` blocks.

    Notion's `PATCH /v1/blocks/{id}/children` endpoint accepts at most 100
    children per request. Callers iterate the returned chunks and issue one
    append per chunk.
    """
    if chunk_size < 1:
        raise ValueError("chunk_size must be >= 1")
    if not blocks:
        return []
    return [
        blocks[i : i + chunk_size] for i in range(0, len(blocks), chunk_size)
    ]


__all__ = [
    "markdown_to_blocks",
    "chunk_blocks",
    "TRUNCATION_MARKER",
    "DEFAULT_MAX_BLOCK_CHARS",
    "DEFAULT_CHUNK_SIZE",
]
