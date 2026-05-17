"""Unit tests for src/notion_http.py.

Mocks `requests.Session` so the tests exercise headers, pagination, retry,
and backoff without ever touching the network.
"""

from __future__ import annotations

import sys
from pathlib import Path
from typing import Any, Iterable, Optional
from unittest.mock import MagicMock

import pytest

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT))

from src.notion_http import (  # noqa: E402
    DEFAULT_NOTION_VERSION,
    NotionAPIError,
    NotionHTTPClient,
)


def _make_response(
    status_code: int = 200,
    json_data: Optional[Any] = None,
    *,
    content: Optional[bytes] = None,
    headers: Optional[dict] = None,
    reason: str = "OK",
) -> MagicMock:
    """Build a MagicMock that quacks like requests.Response."""
    response = MagicMock(name=f"Response({status_code})")
    response.status_code = status_code
    response.headers = headers or {}
    response.reason = reason
    if content is None:
        if json_data is None:
            response.content = b""
        else:
            response.content = b"{}"  # truthy so client tries to parse JSON
    else:
        response.content = content
    if json_data is None:
        response.json.side_effect = ValueError("no body")
    else:
        response.json.return_value = json_data
    response.text = "" if content is None else content.decode("utf-8", "replace")
    return response


def _make_client(
    *,
    responses: Iterable[MagicMock],
    sleeps: Optional[list[float]] = None,
    monotonics: Optional[Iterable[float]] = None,
    **kwargs,
) -> tuple[NotionHTTPClient, MagicMock, list[float]]:
    session = MagicMock(name="Session")
    session.headers = {}
    session.request.side_effect = list(responses)
    sleep_log = sleeps if sleeps is not None else []

    def fake_sleep(seconds: float) -> None:
        sleep_log.append(seconds)

    if monotonics is None:
        ticks_iter = iter([0.0, 100.0, 200.0, 300.0, 400.0, 500.0, 600.0])
    else:
        ticks_iter = iter(monotonics)

    def fake_monotonic() -> float:
        return next(ticks_iter)

    client = NotionHTTPClient(
        token="ntn_test",
        session=session,
        sleep=fake_sleep,
        monotonic=fake_monotonic,
        **kwargs,
    )
    return client, session, sleep_log


# ---- Header / construction -------------------------------------------------


def test_session_headers_include_version_and_auth():
    client, session, _ = _make_client(responses=[])
    assert client.notion_version == DEFAULT_NOTION_VERSION
    assert DEFAULT_NOTION_VERSION == "2025-09-03"
    assert session.headers["Authorization"] == "Bearer ntn_test"
    assert session.headers["Notion-Version"] == "2025-09-03"
    assert session.headers["Content-Type"] == "application/json"


def test_custom_notion_version_propagates():
    client, session, _ = _make_client(responses=[], notion_version="2025-09-03")
    assert session.headers["Notion-Version"] == "2025-09-03"
    assert client.notion_version == "2025-09-03"


def test_empty_token_rejected():
    with pytest.raises(ValueError):
        NotionHTTPClient(token="")


# ---- query_database --------------------------------------------------------


def test_query_database_uses_databases_endpoint():
    response = _make_response(
        200,
        {"object": "list", "results": [{"id": "p1"}], "has_more": False, "next_cursor": None},
    )
    client, session, _ = _make_client(responses=[response])
    result = client.query_database("db_xyz", {"page_size": 50})

    args, kwargs = session.request.call_args
    assert args[0] == "POST"
    assert args[1] == "https://api.notion.com/v1/databases/db_xyz/query"
    assert kwargs["json"] == {"page_size": 50}
    assert result["results"] == [{"id": "p1"}]


def test_query_database_paginates_until_has_more_false():
    page1 = _make_response(
        200,
        {
            "object": "list",
            "results": [{"id": "p1"}, {"id": "p2"}],
            "has_more": True,
            "next_cursor": "cursor-2",
        },
    )
    page2 = _make_response(
        200,
        {
            "object": "list",
            "results": [{"id": "p3"}],
            "has_more": True,
            "next_cursor": "cursor-3",
        },
    )
    page3 = _make_response(
        200,
        {
            "object": "list",
            "results": [{"id": "p4"}],
            "has_more": False,
            "next_cursor": None,
        },
    )
    client, session, _ = _make_client(responses=[page1, page2, page3])

    result = client.query_database("db_xyz", {"page_size": 2})

    assert session.request.call_count == 3
    assert [c.kwargs["json"].get("start_cursor") for c in session.request.call_args_list] == [
        None,
        "cursor-2",
        "cursor-3",
    ]
    assert [page["id"] for page in result["results"]] == ["p1", "p2", "p3", "p4"]
    assert result["has_more"] is False
    assert result["next_cursor"] is None


def test_query_database_passes_through_initial_cursor():
    response = _make_response(
        200,
        {"object": "list", "results": [], "has_more": False, "next_cursor": None},
    )
    client, session, _ = _make_client(responses=[response])
    client.query_database("db_xyz", {"start_cursor": "from-caller", "page_size": 10})
    sent = session.request.call_args.kwargs["json"]
    assert sent == {"start_cursor": "from-caller", "page_size": 10}


def test_query_database_empty_payload_ok():
    response = _make_response(
        200, {"object": "list", "results": [], "has_more": False, "next_cursor": None}
    )
    client, session, _ = _make_client(responses=[response])
    client.query_database("db_xyz")
    assert session.request.call_args.kwargs["json"] == {}


def test_query_database_requires_id():
    client, _, _ = _make_client(responses=[])
    with pytest.raises(ValueError):
        client.query_database("", {})


def test_query_database_stops_when_has_more_true_but_cursor_missing():
    # Defensive: Notion shouldn't do this, but if has_more is True without a
    # cursor we must not loop forever.
    response = _make_response(
        200,
        {"object": "list", "results": [{"id": "p1"}], "has_more": True, "next_cursor": None},
    )
    client, session, _ = _make_client(responses=[response])
    result = client.query_database("db_xyz", {})
    assert session.request.call_count == 1
    assert result["results"] == [{"id": "p1"}]


# ---- discover_first_data_source -------------------------------------------


def test_discover_first_data_source_returns_first_id():
    response = _make_response(
        200,
        {
            "object": "database",
            "id": "db_xyz",
            "data_sources": [{"id": "ds_first"}, {"id": "ds_second"}],
        },
    )
    client, session, _ = _make_client(responses=[response])

    ds_id = client.discover_first_data_source("db_xyz")

    args, kwargs = session.request.call_args
    assert args[0] == "GET"
    assert args[1] == "https://api.notion.com/v1/databases/db_xyz"
    assert kwargs.get("json") is None
    assert ds_id == "ds_first"


def test_discover_first_data_source_returns_none_when_field_absent():
    response = _make_response(200, {"object": "database", "id": "db_xyz"})
    client, _, _ = _make_client(responses=[response])
    assert client.discover_first_data_source("db_xyz") is None


def test_discover_first_data_source_returns_none_when_empty_list():
    response = _make_response(
        200, {"object": "database", "id": "db_xyz", "data_sources": []}
    )
    client, _, _ = _make_client(responses=[response])
    assert client.discover_first_data_source("db_xyz") is None


def test_discover_first_data_source_requires_id():
    client, _, _ = _make_client(responses=[])
    with pytest.raises(ValueError):
        client.discover_first_data_source("")


# ---- update_page -----------------------------------------------------------


def test_update_page_patches_pages_endpoint_with_properties_envelope():
    response = _make_response(200, {"object": "page", "id": "page_1"})
    client, session, _ = _make_client(responses=[response])

    properties = {
        "Status": {"status": {"name": "Dispatched"}},
        "War Room Key": {"rich_text": [{"type": "text", "text": {"content": "wrb_x"}}]},
    }
    client.update_page("page_1", properties)

    args, kwargs = session.request.call_args
    assert args[0] == "PATCH"
    assert args[1] == "https://api.notion.com/v1/pages/page_1"
    assert kwargs["json"] == {"properties": properties}


def test_update_page_requires_id():
    client, _, _ = _make_client(responses=[])
    with pytest.raises(ValueError):
        client.update_page("", {})


# ---- append_block_children -------------------------------------------------


def test_append_block_children_patches_children_endpoint():
    response = _make_response(200, {"object": "list", "results": [{"id": "child_1"}]})
    client, session, _ = _make_client(responses=[response])

    children = [
        {"type": "code", "code": {"rich_text": [], "language": "plain text"}},
    ]
    client.append_block_children("block_root", children)

    args, kwargs = session.request.call_args
    assert args[0] == "PATCH"
    assert args[1] == "https://api.notion.com/v1/blocks/block_root/children"
    assert kwargs["json"] == {"children": children}


def test_append_block_children_requires_id():
    client, _, _ = _make_client(responses=[])
    with pytest.raises(ValueError):
        client.append_block_children("", [])


# ---- update_block ----------------------------------------------------------


def test_update_block_sends_payload_verbatim():
    response = _make_response(200, {"object": "block", "id": "block_1"})
    client, session, _ = _make_client(responses=[response])

    payload = {
        "code": {
            "rich_text": [{"type": "text", "text": {"content": "hello"}}],
            "language": "plain text",
        }
    }
    client.update_block("block_1", payload)

    args, kwargs = session.request.call_args
    assert args[0] == "PATCH"
    assert args[1] == "https://api.notion.com/v1/blocks/block_1"
    assert kwargs["json"] == payload


def test_update_block_requires_id():
    client, _, _ = _make_client(responses=[])
    with pytest.raises(ValueError):
        client.update_block("", {})


# ---- Rate-limit pacing -----------------------------------------------------


def test_rate_limit_pacing_sleeps_between_requests():
    r1 = _make_response(200, {"object": "list", "results": [], "has_more": False})
    r2 = _make_response(200, {"object": "page", "id": "p"})
    # monotonic ticks: first _pace() reads (no sleep, no prior); then sets
    # last_request_at; the second _pace() reads again and sees ~0.1s elapsed.
    monotonics = iter(
        [
            0.0,  # first _pace check (no prior request, short-circuits)
            0.1,  # _last_request_at set after first request
            0.2,  # second _pace check: elapsed = 0.1
            0.3,  # _last_request_at set after second request
        ]
    )

    sleeps: list[float] = []
    client, _, _ = _make_client(
        responses=[r1, r2],
        sleeps=sleeps,
        monotonics=monotonics,
        min_interval_seconds=0.35,
    )
    client.query_database("db", {})
    client.update_page("p", {})

    # Exactly one pacing sleep (before the second request), value ~= 0.25s.
    assert len(sleeps) == 1
    assert sleeps[0] == pytest.approx(0.25, rel=1e-3)


def test_rate_limit_pacing_skips_when_interval_already_elapsed():
    r1 = _make_response(200, {"object": "list", "results": [], "has_more": False})
    r2 = _make_response(200, {"object": "page", "id": "p"})
    # ticks: (1) set _last_request_at after first request = 0.0,
    #        (2) second _pace check = 10.0 -> elapsed=10s >> 0.35s, no sleep,
    #        (3) set _last_request_at after second request = 10.0.
    monotonics = iter([0.0, 10.0, 10.0])
    sleeps: list[float] = []
    client, _, _ = _make_client(
        responses=[r1, r2],
        sleeps=sleeps,
        monotonics=monotonics,
        min_interval_seconds=0.35,
    )
    client.query_database("db", {})
    client.update_page("p", {})
    assert sleeps == []


def test_rate_limit_pacing_disabled_when_interval_zero():
    r1 = _make_response(200, {"object": "list", "results": [], "has_more": False})
    r2 = _make_response(200, {"object": "page", "id": "p"})
    sleeps: list[float] = []
    client, _, _ = _make_client(
        responses=[r1, r2],
        sleeps=sleeps,
        min_interval_seconds=0.0,
    )
    client.query_database("db", {})
    client.update_page("p", {})
    assert sleeps == []


# ---- Retry / backoff -------------------------------------------------------


def test_retries_on_429_respecting_retry_after_header():
    retry1 = _make_response(429, None, headers={"Retry-After": "2"}, reason="Too Many Requests")
    retry2 = _make_response(429, None, headers={"Retry-After": "3"}, reason="Too Many Requests")
    success = _make_response(200, {"object": "page", "id": "p1"})
    sleeps: list[float] = []
    client, session, _ = _make_client(
        responses=[retry1, retry2, success],
        sleeps=sleeps,
        min_interval_seconds=0.0,
    )

    result = client.update_page("p1", {"x": 1})

    assert result == {"object": "page", "id": "p1"}
    assert session.request.call_count == 3
    # Backoff sleeps come from Retry-After.
    assert sleeps == [2.0, 3.0]


def test_retries_on_5xx_and_eventually_succeeds():
    s500 = _make_response(500, None, reason="Server Error")
    s502 = _make_response(502, None, reason="Bad Gateway")
    success = _make_response(200, {"ok": True})
    sleeps: list[float] = []
    client, session, _ = _make_client(
        responses=[s500, s502, success],
        sleeps=sleeps,
        min_interval_seconds=0.0,
        backoff_base=0.5,
    )

    result = client.update_block("b1", {"code": {"rich_text": []}})

    assert result == {"ok": True}
    assert session.request.call_count == 3
    assert len(sleeps) == 2
    # Each backoff falls within [base*2^n, base*2^n + base] (jitter band).
    assert 0.5 <= sleeps[0] <= 1.0
    assert 1.0 <= sleeps[1] <= 1.5


def test_retries_give_up_after_max_attempts_and_raise():
    fail = _make_response(503, {"message": "still unavailable"}, reason="Unavailable")
    responses = [fail for _ in range(4)]
    sleeps: list[float] = []
    client, session, _ = _make_client(
        responses=responses,
        sleeps=sleeps,
        min_interval_seconds=0.0,
        max_retries=3,
        backoff_base=0.1,
    )

    with pytest.raises(NotionAPIError) as excinfo:
        client.update_page("p1", {"x": 1})

    assert excinfo.value.status_code == 503
    # max_retries=3 -> 1 initial + 3 retries == 4 requests.
    assert session.request.call_count == 4
    assert len(sleeps) == 3


def test_non_retryable_4xx_raises_immediately():
    fail = _make_response(
        400, {"message": "invalid body", "code": "validation_error"}, reason="Bad Request"
    )
    client, session, _ = _make_client(responses=[fail], min_interval_seconds=0.0)
    with pytest.raises(NotionAPIError) as excinfo:
        client.update_page("p1", {"x": 1})

    assert excinfo.value.status_code == 400
    assert "invalid body" in str(excinfo.value)
    assert session.request.call_count == 1


def test_retry_after_invalid_falls_back_to_exponential_backoff():
    retry1 = _make_response(429, None, headers={"Retry-After": "garbage"}, reason="Too Many")
    success = _make_response(200, {"ok": True})
    sleeps: list[float] = []
    client, _, _ = _make_client(
        responses=[retry1, success],
        sleeps=sleeps,
        min_interval_seconds=0.0,
        backoff_base=0.4,
    )

    client.update_page("p", {"x": 1})

    assert len(sleeps) == 1
    # Should fall in the exponential band [0.4, 0.8].
    assert 0.4 <= sleeps[0] <= 0.8


def test_retry_after_caps_at_backoff_cap():
    retry = _make_response(429, None, headers={"Retry-After": "9999"}, reason="Too Many")
    success = _make_response(200, {"ok": True})
    sleeps: list[float] = []
    client, _, _ = _make_client(
        responses=[retry, success],
        sleeps=sleeps,
        min_interval_seconds=0.0,
        backoff_cap=12.0,
    )
    client.update_page("p", {})
    assert sleeps == [12.0]


# ---- Error surface ---------------------------------------------------------


def test_api_error_contains_status_and_payload():
    fail = _make_response(
        404, {"message": "not found", "code": "object_not_found"}, reason="Not Found"
    )
    client, _, _ = _make_client(responses=[fail], min_interval_seconds=0.0)
    with pytest.raises(NotionAPIError) as excinfo:
        client.update_page("missing", {})

    err = excinfo.value
    assert err.status_code == 404
    assert err.message == "not found"
    assert isinstance(err.payload, dict)
    assert err.payload["code"] == "object_not_found"


def test_api_error_when_response_has_no_json_body():
    fail = _make_response(500, None, content=b"upstream gateway down", reason="Server Error")
    client, _, _ = _make_client(
        responses=[fail, fail, fail, fail, fail, fail, fail],
        min_interval_seconds=0.0,
        max_retries=0,
    )
    with pytest.raises(NotionAPIError) as excinfo:
        client.update_page("p", {})
    assert excinfo.value.status_code == 500
    # Without a JSON body we fall back to reason text.
    assert "Server Error" in str(excinfo.value)


def test_2xx_with_empty_body_returns_empty_dict():
    ok = _make_response(204, None, reason="No Content")
    client, _, _ = _make_client(responses=[ok], min_interval_seconds=0.0)
    result = client.update_block("b", {"code": {"rich_text": []}})
    assert result == {}


# ---- Timeout propagation ---------------------------------------------------


def test_timeout_is_passed_to_session_request():
    response = _make_response(
        200, {"object": "list", "results": [], "has_more": False, "next_cursor": None}
    )
    client, session, _ = _make_client(
        responses=[response],
        min_interval_seconds=0.0,
        timeout_seconds=7.5,
    )
    client.query_database("db", {})
    assert session.request.call_args.kwargs["timeout"] == 7.5

def test_retries_on_connection_error_and_eventually_succeeds():
    import requests
    fail = requests.exceptions.ConnectionError("Connection reset by peer")
    success = _make_response(200, {"ok": True})
    sleeps: list[float] = []
    
    session = MagicMock(name="Session")
    session.headers = {}
    session.request.side_effect = [fail, success]
    
    def fake_sleep(seconds: float) -> None:
        sleeps.append(seconds)

    ticks_iter = iter([0.0, 100.0, 200.0])
    def fake_monotonic() -> float:
        return next(ticks_iter)
        
    client = NotionHTTPClient(
        token="ntn_test",
        session=session,
        sleep=fake_sleep,
        monotonic=fake_monotonic,
        min_interval_seconds=0.0,
        backoff_base=0.5,
    )

    result = client.update_block("b1", {"code": {"rich_text": []}})

    assert result == {"ok": True}
    assert session.request.call_count == 2
    assert len(sleeps) == 1
    assert 0.5 <= sleeps[0] <= 1.0


def test_retries_connection_error_gives_up_after_max_attempts():
    import requests
    fail = requests.exceptions.ConnectionError("Network unreachable")
    sleeps: list[float] = []
    
    session = MagicMock(name="Session")
    session.headers = {}
    session.request.side_effect = [fail, fail, fail, fail]
    
    def fake_sleep(seconds: float) -> None:
        sleeps.append(seconds)

    ticks_iter = iter([0.0, 100.0, 200.0, 300.0, 400.0, 500.0])
    def fake_monotonic() -> float:
        return next(ticks_iter)
        
    client = NotionHTTPClient(
        token="ntn_test",
        session=session,
        sleep=fake_sleep,
        monotonic=fake_monotonic,
        min_interval_seconds=0.0,
        max_retries=2,
        backoff_base=0.1,
    )

    with pytest.raises(NotionAPIError) as excinfo:
        client.update_page("p1", {"x": 1})

    assert excinfo.value.status_code == 0
    assert "Network error" in str(excinfo.value)
    # max_retries=2 -> 1 initial + 2 retries == 3 requests.
    assert session.request.call_count == 3
    assert len(sleeps) == 2
