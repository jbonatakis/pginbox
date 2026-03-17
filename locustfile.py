import os
import random
from importlib import import_module
from typing import TYPE_CHECKING, Any, Callable, TypeVar
from urllib.parse import quote

# Main knobs:
# - PGINBOX_LOCUST_WAIT_MIN_SECONDS / PGINBOX_LOCUST_WAIT_MAX_SECONDS
# - PGINBOX_LOCUST_THREAD_LIST_LIMIT / PGINBOX_LOCUST_THREAD_DETAIL_LIMIT
# - PGINBOX_LOCUST_ANON_WEIGHT / PGINBOX_LOCUST_AUTH_WEIGHT
# - PGINBOX_LOCUST_SESSION_COOKIE
# - PGINBOX_LOCUST_AUTH_EMAIL / PGINBOX_LOCUST_AUTH_PASSWORD
#
# Prefer PGINBOX_LOCUST_SESSION_COOKIE for authenticated runs on live systems.
# It avoids login bursts and auth rate limits while still exercising the
# authenticated read path (`/api/auth/me`, `/api/me/thread-follow-states`,
# `/api/threads/:threadId/progress`, and `/api/me/followed-threads`).

F = TypeVar("F", bound=Callable[..., Any])

if TYPE_CHECKING:
    class Semaphore:
        def __init__(self, value: int = 1) -> None: ...
        def __enter__(self) -> "Semaphore": ...
        def __exit__(self, exc_type: object, exc: object, tb: object) -> None: ...

    class HttpUser:
        client: Any
        host: str
        wait_time: object

        def on_start(self) -> None: ...

    def between(min_wait: float, max_wait: float) -> object: ...
    def task(weight: int) -> Callable[[F], F]: ...

    class StopUser(Exception):
        pass
else:
    Semaphore = import_module("gevent.lock").Semaphore
    _locust = import_module("locust")
    HttpUser = _locust.HttpUser
    between = _locust.between
    task = _locust.task
    StopUser = import_module("locust.exception").StopUser


def env_int(name: str, default: int) -> int:
    value = os.getenv(name)
    if value is None:
        return default

    try:
        return int(value)
    except ValueError:
        return default


def env_float(name: str, default: float) -> float:
    value = os.getenv(name)
    if value is None:
        return default

    try:
        return float(value)
    except ValueError:
        return default


THREAD_LIST_LIMIT = env_int("PGINBOX_LOCUST_THREAD_LIST_LIMIT", 25)
THREAD_DETAIL_LIMIT = env_int("PGINBOX_LOCUST_THREAD_DETAIL_LIMIT", 50)
THREAD_SAMPLE_SIZE = env_int("PGINBOX_LOCUST_THREAD_SAMPLE_SIZE", 12)
WAIT_MIN_SECONDS = env_float("PGINBOX_LOCUST_WAIT_MIN_SECONDS", 1.0)
WAIT_MAX_SECONDS = env_float("PGINBOX_LOCUST_WAIT_MAX_SECONDS", 4.0)

ANONYMOUS_WEIGHT = env_int("PGINBOX_LOCUST_ANON_WEIGHT", 3)

AUTH_EMAIL = os.getenv("PGINBOX_LOCUST_AUTH_EMAIL")
AUTH_PASSWORD = os.getenv("PGINBOX_LOCUST_AUTH_PASSWORD")
SESSION_COOKIE_OVERRIDE = os.getenv("PGINBOX_LOCUST_SESSION_COOKIE")
AUTH_ENABLED = bool(SESSION_COOKIE_OVERRIDE or (AUTH_EMAIL and AUTH_PASSWORD))
AUTH_WEIGHT = env_int("PGINBOX_LOCUST_AUTH_WEIGHT", 2) if AUTH_ENABLED else 0

_shared_auth_cookies: dict[str, str] | None = None
_shared_auth_lock = Semaphore()


class BasePginboxUser(HttpUser):
    wait_time = between(WAIT_MIN_SECONDS, WAIT_MAX_SECONDS)
    abstract = True

    def on_start(self) -> None:
        self.thread_cache: list[str] = []

    def _load_json(self, response):
        try:
            return response.json()
        except ValueError:
            return None

    def _response_preview(self, response, limit: int = 240) -> str:
        text = ""
        try:
            text = response.text
        except Exception:
            text = ""

        compact = " ".join(text.split())
        if not compact:
            return "<empty>"
        if len(compact) <= limit:
            return compact
        return f"{compact[:limit]}..."

    def refresh_thread_cache(self, include_page: bool) -> list[str]:
        if include_page:
            self.client.get("/threads", name="/threads (page)")

        self.client.get("/api/lists", name="/api/lists")
        response = self.client.get(
            f"/api/threads?limit={THREAD_LIST_LIMIT}",
            name="/api/threads",
        )
        payload = self._load_json(response) or {}
        items = payload.get("items") if isinstance(payload, dict) else None

        if not isinstance(items, list):
            self.thread_cache = []
            return self.thread_cache

        thread_ids = []
        for item in items:
            if not isinstance(item, dict):
                continue
            thread_id = item.get("thread_id")
            if isinstance(thread_id, str) and thread_id:
                thread_ids.append(thread_id)

        self.thread_cache = thread_ids[:THREAD_SAMPLE_SIZE]
        return self.thread_cache

    def pick_thread_id(self, include_page: bool) -> str | None:
        if not self.thread_cache:
            self.refresh_thread_cache(include_page=include_page)

        if not self.thread_cache:
            return None

        return random.choice(self.thread_cache)

    def read_thread_detail(
        self,
        thread_id: str,
        *,
        include_page: bool,
        include_progress: bool = False,
    ) -> None:
        encoded_thread_id = quote(thread_id, safe="")

        if include_page:
            self.client.get(
                f"/threads/{encoded_thread_id}",
                name="/threads/:threadId (page)",
            )

        self.client.get(
            f"/api/threads/{encoded_thread_id}?limit={THREAD_DETAIL_LIMIT}",
            name="/api/threads/:threadId",
        )

        if include_progress:
            self.client.get(
                f"/api/threads/{encoded_thread_id}/progress",
                name="/api/threads/:threadId/progress",
            )


class AnonymousBrowsingUser(BasePginboxUser):
    weight = ANONYMOUS_WEIGHT

    @task(4)
    def browse_threads(self) -> None:
        self.refresh_thread_cache(include_page=True)

    @task(8)
    def read_thread(self) -> None:
        thread_id = self.pick_thread_id(include_page=False)
        if thread_id is None:
            return

        self.read_thread_detail(thread_id, include_page=True)

    @task(1)
    def hit_homepage(self) -> None:
        self.client.get("/", name="/ (page)")

    @task(1)
    def browse_people(self) -> None:
        self.client.get("/people", name="/people (page)")
        self.client.get("/api/people", name="/api/people")

    @task(1)
    def browse_analytics(self) -> None:
        self.client.get("/analytics", name="/analytics (page)")
        self.client.get("/api/analytics/summary", name="/api/analytics/summary")


class AuthenticatedReadingUser(BasePginboxUser):
    weight = AUTH_WEIGHT

    def on_start(self) -> None:
        super().on_start()
        self.ensure_authenticated()
        self.refresh_thread_cache(include_page=False)

    def ensure_authenticated(self) -> None:
        global _shared_auth_cookies

        if not AUTH_ENABLED:
            raise StopUser("Authenticated load is disabled. Set auth env vars to enable it.")

        if SESSION_COOKIE_OVERRIDE:
            self.apply_session_cookie_override()
        else:
            self.apply_shared_login()

        with self.client.get("/api/auth/me", name="/api/auth/me", catch_response=True) as me_response:
            payload = self._load_json(me_response) or {}
            if me_response.status_code == 200 and isinstance(payload, dict) and payload.get("user") is not None:
                me_response.success()
                return

            preview = self._response_preview(me_response)
            me_response.failure(
                "authenticated session check failed: "
                f"status={me_response.status_code}, body={preview}"
            )
            raise StopUser(
                "Authenticated load user could not establish a valid session: "
                f"status={me_response.status_code}, body={preview}"
            )

    def apply_session_cookie_override(self) -> None:
        cookie_value = SESSION_COOKIE_OVERRIDE or ""
        cookie_name = "pginbox_session"

        if "=" in cookie_value and ";" not in cookie_value:
            cookie_name, cookie_value = cookie_value.split("=", 1)

        self.client.cookies.set(cookie_name, cookie_value)

    def apply_shared_login(self) -> None:
        global _shared_auth_cookies

        with _shared_auth_lock:
            if _shared_auth_cookies is None:
                with self.client.post(
                    "/api/auth/login",
                    json={
                        "email": AUTH_EMAIL,
                        "password": AUTH_PASSWORD,
                    },
                    headers={"Origin": self.host},
                    name="/api/auth/login",
                    catch_response=True,
                ) as response:
                    if response.status_code != 200:
                        response.failure(
                            f"login failed with status {response.status_code}; "
                            "set PGINBOX_LOCUST_SESSION_COOKIE to avoid auth rate limits"
                        )
                        raise StopUser("Authenticated load user could not log in.")

                    response.success()
                    _shared_auth_cookies = dict(self.client.cookies.items())

            if not _shared_auth_cookies:
                raise StopUser("Authenticated load user could not reuse a shared session.")

        self.client.cookies.update(_shared_auth_cookies)

    def fetch_follow_states(self, thread_ids: list[str]) -> None:
        if not thread_ids:
            return

        self.client.post(
            "/api/me/thread-follow-states",
            json={"threadIds": thread_ids},
            name="/api/me/thread-follow-states",
        )

    @task(5)
    def browse_threads(self) -> None:
        thread_ids = self.refresh_thread_cache(include_page=True)
        self.client.get("/api/auth/me", name="/api/auth/me")
        self.fetch_follow_states(thread_ids)

    @task(10)
    def read_thread(self) -> None:
        thread_id = self.pick_thread_id(include_page=False)
        if thread_id is None:
            return

        self.read_thread_detail(
            thread_id,
            include_page=True,
            include_progress=True,
        )

    @task(2)
    def read_thread_from_index(self) -> None:
        thread_ids = self.refresh_thread_cache(include_page=False)
        self.fetch_follow_states(thread_ids)

        if not thread_ids:
            return

        self.read_thread_detail(
            random.choice(thread_ids),
            include_page=False,
            include_progress=True,
        )

    @task(1)
    def view_followed_threads(self) -> None:
        self.client.get("/account", name="/account (page)")
        self.client.get("/api/auth/me", name="/api/auth/me")
        self.client.get("/api/me/followed-threads?limit=25", name="/api/me/followed-threads")
