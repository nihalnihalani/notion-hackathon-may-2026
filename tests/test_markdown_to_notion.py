"""Unit tests for `src/markdown_to_notion.py`.

Covers the supported block constructs, truncation contract, and chunking.
No network or filesystem dependency.
"""

from __future__ import annotations

import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT))

from src.markdown_to_notion import (  # noqa: E402
    DEFAULT_CHUNK_SIZE,
    DEFAULT_MAX_BLOCK_CHARS,
    TRUNCATION_MARKER,
    chunk_blocks,
    markdown_to_blocks,
)


def _first(blocks, kind):
    matches = [b for b in blocks if b["type"] == kind]
    assert matches, f"expected at least one block of type {kind}; got {blocks}"
    return matches[0]


def _text(block):
    body = block[block["type"]]
    rt = body.get("rich_text") or []
    return "".join(part["text"]["content"] for part in rt)


# ---- Empty / whitespace ----------------------------------------------------


def test_empty_input_returns_empty_list():
    assert markdown_to_blocks("") == []
    assert markdown_to_blocks(None) == []  # type: ignore[arg-type]
    assert markdown_to_blocks("   \n\n  \t  \n") == []


# ---- Paragraphs ------------------------------------------------------------


def test_single_paragraph_becomes_paragraph_block():
    blocks = markdown_to_blocks("hello world")
    assert len(blocks) == 1
    assert blocks[0]["type"] == "paragraph"
    assert _text(blocks[0]) == "hello world"


def test_consecutive_lines_join_into_one_paragraph():
    blocks = markdown_to_blocks("line one\nline two\nline three")
    assert len(blocks) == 1
    assert blocks[0]["type"] == "paragraph"
    assert _text(blocks[0]) == "line one line two line three"


def test_blank_line_separates_paragraphs():
    blocks = markdown_to_blocks("first para\n\nsecond para")
    assert [b["type"] for b in blocks] == ["paragraph", "paragraph"]
    assert _text(blocks[0]) == "first para"
    assert _text(blocks[1]) == "second para"


# ---- Headings --------------------------------------------------------------


def test_h1_h2_h3_produce_matching_blocks():
    md = "# H1 Title\n\n## H2 Title\n\n### H3 Title"
    blocks = markdown_to_blocks(md)
    assert [b["type"] for b in blocks] == ["heading_1", "heading_2", "heading_3"]
    assert _text(blocks[0]) == "H1 Title"
    assert _text(blocks[1]) == "H2 Title"
    assert _text(blocks[2]) == "H3 Title"


def test_heading_levels_above_three_clamp_to_h3():
    blocks = markdown_to_blocks("#### Deep heading")
    assert blocks[0]["type"] == "heading_3"
    assert _text(blocks[0]) == "Deep heading"


# ---- Lists -----------------------------------------------------------------


def test_unordered_list_items():
    md = "- alpha\n- beta\n- gamma"
    blocks = markdown_to_blocks(md)
    assert [b["type"] for b in blocks] == [
        "bulleted_list_item",
        "bulleted_list_item",
        "bulleted_list_item",
    ]
    assert [_text(b) for b in blocks] == ["alpha", "beta", "gamma"]


def test_unordered_list_with_alternate_markers():
    md = "* asterisk\n+ plus"
    blocks = markdown_to_blocks(md)
    assert [b["type"] for b in blocks] == [
        "bulleted_list_item",
        "bulleted_list_item",
    ]
    assert [_text(b) for b in blocks] == ["asterisk", "plus"]


def test_ordered_list_items():
    md = "1. one\n2. two\n3. three"
    blocks = markdown_to_blocks(md)
    assert [b["type"] for b in blocks] == [
        "numbered_list_item",
        "numbered_list_item",
        "numbered_list_item",
    ]
    assert [_text(b) for b in blocks] == ["one", "two", "three"]


# ---- Blockquote ------------------------------------------------------------


def test_blockquote_becomes_quote_block():
    blocks = markdown_to_blocks("> wisdom here")
    assert blocks[0]["type"] == "quote"
    assert _text(blocks[0]) == "wisdom here"


# ---- Fenced code -----------------------------------------------------------


def test_fenced_code_block_default_language_is_plain_text():
    md = "```\nuntyped code\n```"
    blocks = markdown_to_blocks(md)
    assert blocks[0]["type"] == "code"
    assert blocks[0]["code"]["language"] == "plain text"
    assert _text(blocks[0]) == "untyped code"


def test_fenced_code_block_with_known_language():
    md = "```python\nprint('hi')\n```"
    blocks = markdown_to_blocks(md)
    assert blocks[0]["type"] == "code"
    assert blocks[0]["code"]["language"] == "python"
    assert _text(blocks[0]) == "print('hi')"


def test_fenced_code_block_aliases_map_to_canonical_language():
    md = "```sh\necho hi\n```"
    blocks = markdown_to_blocks(md)
    assert blocks[0]["code"]["language"] == "shell"


def test_fenced_code_block_unknown_language_falls_back_to_plain_text():
    md = "```fictional\nfoo bar\n```"
    blocks = markdown_to_blocks(md)
    assert blocks[0]["code"]["language"] == "plain text"


def test_fenced_code_block_preserves_multiline_body_verbatim():
    md = "```\nline 1\n  indented\n\n  blank above\n```"
    blocks = markdown_to_blocks(md)
    assert _text(blocks[0]) == "line 1\n  indented\n\n  blank above"


# ---- Divider ---------------------------------------------------------------


def test_thematic_break_becomes_divider():
    md = "before\n\n---\n\nafter"
    blocks = markdown_to_blocks(md)
    assert [b["type"] for b in blocks] == ["paragraph", "divider", "paragraph"]
    divider = _first(blocks, "divider")
    assert divider["divider"] == {}


# ---- Truncation ------------------------------------------------------------


def test_long_paragraph_truncates_to_max_block_chars_with_marker():
    long_text = "a" * 5000
    blocks = markdown_to_blocks(long_text, max_block_chars=200)
    assert len(blocks) == 1
    rendered = _text(blocks[0])
    assert len(rendered) == 200
    assert rendered.endswith(TRUNCATION_MARKER)
    # Leading content is preserved up to the head room.
    assert rendered.startswith("a" * (200 - len(TRUNCATION_MARKER)))


def test_default_truncation_limit_matches_module_constant():
    long_text = "z" * (DEFAULT_MAX_BLOCK_CHARS * 3)
    blocks = markdown_to_blocks(long_text)
    rendered = _text(blocks[0])
    assert len(rendered) == DEFAULT_MAX_BLOCK_CHARS
    assert rendered.endswith(TRUNCATION_MARKER)


def test_short_paragraph_is_not_modified():
    blocks = markdown_to_blocks("short")
    assert _text(blocks[0]) == "short"
    assert TRUNCATION_MARKER not in _text(blocks[0])


# ---- chunk_blocks ----------------------------------------------------------


def test_chunk_blocks_empty_returns_empty():
    assert chunk_blocks([]) == []


def test_chunk_blocks_under_chunk_size_returns_single_chunk():
    blocks = [{"type": "paragraph"} for _ in range(7)]
    chunks = chunk_blocks(blocks, chunk_size=100)
    assert len(chunks) == 1
    assert len(chunks[0]) == 7


def test_chunk_blocks_exact_multiple_of_chunk_size():
    blocks = [{"type": "paragraph"} for _ in range(200)]
    chunks = chunk_blocks(blocks, chunk_size=100)
    assert [len(c) for c in chunks] == [100, 100]


def test_chunk_blocks_remainder_goes_into_final_chunk():
    blocks = [{"type": "paragraph"} for _ in range(250)]
    chunks = chunk_blocks(blocks, chunk_size=100)
    assert [len(c) for c in chunks] == [100, 100, 50]


def test_chunk_blocks_default_size_matches_module_constant():
    blocks = [{"type": "paragraph"} for _ in range(DEFAULT_CHUNK_SIZE + 1)]
    chunks = chunk_blocks(blocks)
    assert len(chunks) == 2
    assert len(chunks[0]) == DEFAULT_CHUNK_SIZE
    assert len(chunks[1]) == 1


def test_chunk_blocks_rejects_zero_or_negative_size():
    import pytest

    with pytest.raises(ValueError):
        chunk_blocks([{"type": "paragraph"}], chunk_size=0)
    with pytest.raises(ValueError):
        chunk_blocks([{"type": "paragraph"}], chunk_size=-1)


# ---- Mixed-document smoke -------------------------------------------------


def test_mixed_document_preserves_order_and_types():
    md = "\n".join(
        [
            "# Title",
            "",
            "Intro paragraph.",
            "",
            "## Section",
            "",
            "- bullet one",
            "- bullet two",
            "",
            "1. step",
            "",
            "> quote",
            "",
            "```python",
            "print(1)",
            "```",
            "",
            "---",
            "",
            "Closing paragraph.",
        ]
    )
    types = [b["type"] for b in markdown_to_blocks(md)]
    assert types == [
        "heading_1",
        "paragraph",
        "heading_2",
        "bulleted_list_item",
        "bulleted_list_item",
        "numbered_list_item",
        "quote",
        "code",
        "divider",
        "paragraph",
    ]
