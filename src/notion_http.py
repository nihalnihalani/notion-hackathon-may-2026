"""Raw HTTP client for the Notion REST API.

Uses the `requests` library directly so the bridge does not depend on a Notion
SDK whose behavior may drift across API versions. The client always sends
`Authorization`, `Notion-Version`, and `Content-Type`, paces requests against
Notion's published rate limit, and retries 429/5xx responses with backoff.
"""

from __future__ import annotations

import logging
import random
import time
from typing import Any, Callable, Iterable, Mapping, Optional

import requests

log = logging.getLogger(__name__)


NOTION_API_BASE = "https://api.notion.com/v1"
DEFAULT_NOTION_VERSION = "2022-06-28"
DEFAULT_MIN_INTERVAL_SECONDS = 0.35
DEFAULT_MAX_RETRIES = 5
DEFAULT_BACKOFF_BASE = 0.5
DEFAULT_BACKOFF_CAP = 30.0
DEFAULT_TIMEOUT_SECONDS = 30.0
RETRY_STATUS_CODES = frozenset({429, 500, 502, 503, 504})


class NotionAPIError(RuntimeError):
    """Raised when the Notion API returns a non-2xx response we did not retry past."""

    def __init__(self, status_code: int, message: str, payload: Optional[Any] = None):
        super().__init__(f"Notion API {status_code}: {message}")
        self.status_code = status_code
        self.message = message
        self.payload = payload


class NotionHTTPClient:
    """Thin wrapper around `requests.Session` for the Notion API.

    The client is intentionally small: it owns headers, rate-limit pacing,
    retry/backoff, and the few endpoints the bridge needs. Higher-level
    semantics (which property names, which status values) live in the sync
    modules.
    """

    def __init__(
        self,
        token: str,
        *,
        notion_version: str = DEFAULT_NOTION_VERSION,
        base_url: str = NOTION_API_BASE,
        session: Optional[requests.Session] = None,
        min_interval_seconds: float = DEFAULT_MIN_INTERVAL_SECONDS,
        max_retries: int = DEFAULT_MAX_RETRIES,
        backoff_base: float = DEFAULT_BACKOFF_BASE,
        backoff_cap: float = DEFAULT_BACKOFF_CAP,
        timeout_seconds: float = DEFAULT_TIMEOUT_SECONDS,
        sleep: Callable[[float], None] = time.sleep,
        monotonic: Callable[[], float] = time.monotonic,
    ) -> None:
        if not token:
            raise ValueError("token is required")
        self._base_url = base_url.rstrip("/")
        self._notion_version = notion_version
        self._session = session if session is not None else requests.Session()
        self._session.headers.update(
            {
                "Authorization": f"Bearer {token}",
                "Notion-Version": notion_version,
                "Content-Type": "application/json",
            }
        )
        self._min_interval = max(0.0, float(min_interval_seconds))
        self._max_retries = max(0, int(max_retries))
        self._backoff_base = max(0.0, float(backoff_base))
        self._backoff_cap = max(self._backoff_base, float(backoff_cap))
        self._timeout = float(timeout_seconds)
        self._sleep = sleep
        self._monotonic = monotonic
        self._last_request_at: Optional[float] = None

    @property
    def session(self) -> requests.Session:
        return self._session

    @property
    def notion_version(self) -> str:
        return self._notion_version

    # ---- Public endpoints ----------------------------------------------------

    def query_database(
        self,
        db_id: str,
        payload: Optional[Mapping[str, Any]] = None,
    ) -> dict[str, Any]:
        """POST /v1/databases/{id}/query, following `has_more`/`next_cursor`.

        Returns a single dict shaped like a Notion query response:
        `{"object": "list", "results": [...all pages...], "has_more": False,
        "next_cursor": None}`. The caller does not need to paginate.
        """
        if not db_id:
            raise ValueError("db_id is required")
        base_payload: dict[str, Any] = dict(payload or {})
        results: list[Any] = []
        cursor: Optional[str] = base_payload.pop("start_cursor", None)
        while True:
            page_payload = dict(base_payload)
            if cursor:
                page_payload["start_cursor"] = cursor
            data = self._request(
                "POST",
                f"/databases/{db_id}/query",
                json=page_payload,
            )
            page_results = data.get("results") or []
            results.extend(page_results)
            if not data.get("has_more"):
                break
            cursor = data.get("next_cursor")
            if not cursor:
                break
        return {
            "object": "list",
            "results": results,
            "has_more": False,
            "next_cursor": None,
        }

    def discover_first_data_source(self, database_id: str) -> Optional[str]:
        """GET /v1/databases/{database_id}; return first data source id if any.

        Notion's `2025-09-03` split exposes data sources under
        `data_sources: [{"id": "..."}, ...]` on the database response. Older
        API versions omit that field; in that case we return None so the
        caller can fall back to the database id itself.
        """
        if not database_id:
            raise ValueError("database_id is required")
        data = self._request("GET", f"/databases/{database_id}")
        sources = data.get("data_sources") or []
        if not sources:
            return None
        first = sources[0]
        if isinstance(first, Mapping):
            return first.get("id")
        return None

    def update_page(
        self,
        page_id: str,
        properties: Mapping[str, Any],
    ) -> dict[str, Any]:
        if not page_id:
            raise ValueError("page_id is required")
        return self._request(
            "PATCH",
            f"/pages/{page_id}",
            json={"properties": dict(properties)},
        )

    def append_block_children(
        self,
        block_id: str,
        children: Iterable[Mapping[str, Any]],
    ) -> dict[str, Any]:
        if not block_id:
            raise ValueError("block_id is required")
        children_list = [dict(child) for child in children]
        return self._request(
            "PATCH",
            f"/blocks/{block_id}/children",
            json={"children": children_list},
        )

    def update_block(
        self,
        block_id: str,
        payload: Mapping[str, Any],
    ) -> dict[str, Any]:
        if not block_id:
            raise ValueError("block_id is required")
        return self._request(
            "PATCH",
            f"/blocks/{block_id}",
            json=dict(payload),
        )

    # ---- Internals -----------------------------------------------------------

    def _request(
        self,
        method: str,
        path: str,
        *,
        json: Optional[Any] = None,
        params: Optional[Mapping[str, Any]] = None,
    ) -> dict[str, Any]:
        url = f"{self._base_url}{path}"
        attempt = 0
        while True:
            self._pace()
            try:
                response = self._session.request(
                    method,
                    url,
                    json=json,
                    params=params,
                    timeout=self._timeout,
                )
                self._last_request_at = self._monotonic()
                status = response.status_code
    
                if 200 <= status < 300:
                    if not response.content:
                        return {}
                    try:
                        return response.json()
                    except ValueError as exc:
                        raise NotionAPIError(status, f"invalid JSON response: {exc}") from exc
    
                if status in RETRY_STATUS_CODES and attempt < self._max_retries:
                    delay = self._compute_backoff(attempt, response)
                    log.warning(
                        "Notion %s %s -> %s; retrying in %.2fs (attempt %d/%d)",
                        method,
                        path,
                        status,
                        delay,
                        attempt + 1,
                        self._max_retries,
                    )
                    self._sleep(delay)
                    attempt += 1
                    continue
    
                message, payload = _extract_error(response)
                raise NotionAPIError(status, message, payload)

            except requests.RequestException as exc:
                self._last_request_at = self._monotonic()
                if attempt < self._max_retries:
                    delay = self._compute_backoff(attempt, None)
                    log.warning(
                        "Notion %s %s -> network error (%s); retrying in %.2fs (attempt %d/%d)",
                        method,
                        path,
                        type(exc).__name__,
                        delay,
                        attempt + 1,
                        self._max_retries,
                    )
                    self._sleep(delay)
                    attempt += 1
                    continue
                raise NotionAPIError(0, f"Network error: {exc}") from exc

    def _pace(self) -> None:
        if self._min_interval <= 0 or self._last_request_at is None:
            return
        elapsed = self._monotonic() - self._last_request_at
        remaining = self._min_interval - elapsed
        if remaining > 0:
            self._sleep(remaining)

    def _compute_backoff(self, attempt: int, response: Optional[requests.Response]) -> float:
        retry_after = response.headers.get("Retry-After") if response is not None else None
        if retry_after:
            try:
                explicit = float(retry_after)
                if explicit > 0:
                    return min(explicit, self._backoff_cap)
            except ValueError:
                pass
        exponential = self._backoff_base * (2 ** attempt)
        jitter = random.uniform(0, self._backoff_base)
        return min(self._backoff_cap, exponential + jitter)


def _extract_error(response: requests.Response) -> tuple[str, Optional[Any]]:
    payload: Optional[Any] = None
    message = response.reason or "request failed"
    if response.content:
        try:
            payload = response.json()
        except ValueError:
            payload = response.text
        if isinstance(payload, Mapping):
            message = str(payload.get("message") or payload.get("code") or message)
    return message, payload
