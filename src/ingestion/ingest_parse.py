from __future__ import annotations

import email.header
import email.utils
import gzip
import hashlib
import mailbox
import re
import tempfile
from datetime import datetime, timezone
from pathlib import Path


MESSAGE_ID_RE = re.compile(r"<[^<>\r\n]+>")
GIT_PATCH_FROM_RE = re.compile(
    rb"^From [0-9a-f]{7,64} Mon Sep 17 00:00:00 2001(?: .*)?$"
)
RFC822_HEADER_RE = re.compile(rb"^[A-Za-z0-9-]+:")

_TEXT_APPLICATION_TYPES = {
    "application/sql",
    "application/x-sql",
    "application/x-sh",
    "application/x-shellscript",
    "application/x-perl",
    "application/x-perl-script",
    "application/x-python",
    "application/x-python-script",
    "application/x-ruby-script",
    "application/xhtml+xml",
}


def _decode_body(msg) -> str:
    def _restore_mbox_escaped_from_lines(text: str) -> str:
        return re.sub(r"(?m)^>(>*From )", r"\1", text)

    if msg.is_multipart():
        for part in msg.walk():
            if part.get_content_type() != "text/plain":
                continue
            if part.get_content_disposition() == "attachment":
                continue
            try:
                payload = part.get_payload(decode=True)
                if payload is None:
                    continue
                charset = part.get_content_charset() or "utf-8"
                return _restore_mbox_escaped_from_lines(
                    payload.decode(charset, errors="replace")
                )
            except Exception:
                continue
        return ""
    else:
        try:
            payload = msg.get_payload(decode=True)
            if payload:
                charset = msg.get_content_charset() or "utf-8"
                return _restore_mbox_escaped_from_lines(
                    payload.decode(charset, errors="replace")
                )
        except Exception:
            pass
        return _restore_mbox_escaped_from_lines(str(msg.get_payload() or ""))


def _parse_attachments(msg) -> list:
    """Extract attachments from a MIME message. Returns list of dicts."""
    if not msg.is_multipart():
        return []

    attachments = []
    for part in msg.walk():
        if part.is_multipart():
            continue

        ct = part.get_content_type()
        disp = part.get_content_disposition() or ""
        filename = part.get_filename()
        ext = (
            filename.rsplit(".", 1)[-1].lower() if filename and "." in filename else ""
        )

        if ct in (
            "application/pgp-signature",
            "application/pkcs7-signature",
            "application/applefile",
            "application/mbox",
            "text/vnd.google.email-reaction+json",
        ):
            continue
        if ct.startswith("video/"):
            continue
        if ext == "asc":
            continue

        if ct in ("text/plain", "text/html") and disp != "attachment":
            continue

        payload = part.get_payload(decode=True)
        if not payload:
            continue
        size = len(payload)
        content = None

        if payload:
            if (
                ct.startswith("text/")
                or ct in _TEXT_APPLICATION_TYPES
                or ext in ("patch", "diff")
            ):
                charset = part.get_content_charset() or "utf-8"
                try:
                    content = payload.decode(charset, errors="replace")
                except Exception:
                    pass
            elif ct in (
                "application/gzip",
                "application/x-gzip",
                "application/x-compressed",
            ) or ext in ("gz", "tgz"):
                try:
                    content = gzip.decompress(payload).decode("utf-8")
                except Exception:
                    pass

        attachments.append(
            {
                "filename": _strip_nul(filename) if filename else None,
                "content_type": ct,
                "size_bytes": size,
                "content": _strip_nul(content) if content else None,
            }
        )

    return attachments


def _decode_header(value: str) -> str:
    """Decode MIME encoded-word sequences (e.g. =?UTF-8?q?...?=) in a header value."""
    parts = []
    for part, charset in email.header.decode_header(value):
        if isinstance(part, bytes):
            parts.append(part.decode(charset or "utf-8", errors="replace"))
        else:
            parts.append(part)
    return "".join(parts)


def _decode_subject(value: str | None) -> str:
    return _strip_nul(_decode_header(value or ""))


def _normalize_email(addr: str) -> str:
    """Lowercase and strip +tags (e.g. user+tag@example.com → user@example.com)."""
    addr = addr.lower().strip()
    return re.sub(r"\+[^@]*@", "@", addr)


def _extract_message_ids(value: str | None) -> list[str]:
    decoded = _decode_header(value or "").strip()
    if not decoded:
        return []
    ids = MESSAGE_ID_RE.findall(decoded)
    if ids:
        return ids
    return [part for part in decoded.split() if part]


def _extract_message_id(value: str | None, *, prefer_last: bool = False) -> str | None:
    ids = _extract_message_ids(value)
    if not ids:
        return None
    return ids[-1] if prefer_last else ids[0]


def _normalize_subject(subject: str) -> str:
    return re.sub(r"^(Re|Fwd?)\s*:\s*", "", subject, flags=re.IGNORECASE).strip()


def _strip_nul(s: str) -> str:
    """Remove NUL bytes that PostgreSQL rejects in text fields."""
    return s.replace("\x00", "") if s else s


def _is_git_patch_from_line(raw: bytes) -> bool:
    return bool(GIT_PATCH_FROM_RE.match(raw.rstrip(b"\r\n")))


def _looks_like_mbox_message_start(lines: list[bytes], index: int) -> bool:
    """Heuristically distinguish real mbox separators from body lines starting with 'From '."""
    if index < 0 or index >= len(lines):
        return False

    raw = lines[index].rstrip(b"\r\n")
    if not raw.startswith(b"From "):
        return False
    if _is_git_patch_from_line(raw):
        return False

    saw_header = False
    for candidate in lines[index + 1 :]:
        stripped = candidate.rstrip(b"\r\n")
        if not stripped:
            return saw_header
        if RFC822_HEADER_RE.match(stripped):
            saw_header = True
            continue
        if saw_header and candidate.startswith((b" ", b"\t")):
            continue
        return False

    return False


def _mbox_contains_git_patch_from_lines(path: Path) -> bool:
    with path.open("rb") as src:
        return any(_is_git_patch_from_line(raw) for raw in src)


def _sanitize_mbox_from_lines(path: Path) -> Path:
    """Create a temp mbox copy that escapes body lines mistaken for message separators."""
    lines = path.read_bytes().splitlines(keepends=True)
    tmp = tempfile.NamedTemporaryFile(
        mode="wb",
        prefix=f"{path.name}.",
        suffix=".sanitized",
        dir=path.parent,
        delete=False,
    )
    tmp_path = Path(tmp.name)
    try:
        with tmp:
            in_headers = False
            in_body = False

            for index, raw in enumerate(lines):
                if not in_headers and not in_body:
                    if _looks_like_mbox_message_start(lines, index):
                        in_headers = True
                    tmp.write(raw)
                    continue

                if in_headers:
                    tmp.write(raw)
                    if raw in (b"\n", b"\r\n"):
                        in_headers = False
                        in_body = True
                    continue

                if raw.startswith(b"From "):
                    if _looks_like_mbox_message_start(lines, index):
                        in_headers = True
                        in_body = False
                        tmp.write(raw)
                        continue
                    raw = b">" + raw

                tmp.write(raw)
        return tmp_path
    except Exception:
        tmp_path.unlink(missing_ok=True)
        raise


def _iter_mbox_messages(path: Path):
    if _mbox_contains_git_patch_from_lines(path):
        print(
            "  [warn] detected embedded git patch From-lines; retrying with sanitized copy"
        )
        sanitized_path = _sanitize_mbox_from_lines(path)
        try:
            mbox = mailbox.mbox(str(sanitized_path))
            try:
                for msg in mbox:
                    yield msg
                return
            finally:
                mbox.close()
        finally:
            sanitized_path.unlink(missing_ok=True)

    buffered = []
    mbox = mailbox.mbox(str(path))
    try:
        for msg in mbox:
            if not msg.keys():
                print(
                    "  [warn] detected header-less mbox fragments; retrying with sanitized copy"
                )
                break
            buffered.append(msg)
        else:
            yield from buffered
            return
    except UnicodeDecodeError as e:
        print(f"  [warn] malformed mbox From-line ({e}); retrying with sanitized copy")
    finally:
        mbox.close()

    sanitized_path = _sanitize_mbox_from_lines(path)
    try:
        mbox = mailbox.mbox(str(sanitized_path))
        try:
            for msg in mbox:
                yield msg
        finally:
            mbox.close()
    finally:
        sanitized_path.unlink(missing_ok=True)


def parse_mbox(path: Path, list_id: int):
    """Yield message dicts parsed from an mbox file."""
    mbox_ym = path.name.split(".")[-1]
    mbox_date = datetime(int(mbox_ym[:4]), int(mbox_ym[4:]), 1, tzinfo=timezone.utc)

    for msg in _iter_mbox_messages(path):
        if not msg.keys():
            continue

        message_id = _extract_message_id(msg.get("Message-ID"))
        if not message_id:
            digest = hashlib.sha256(str(msg).encode()).hexdigest()[:16]
            message_id = f"<synthetic-{digest}@pginbox>"

        sent_at = None
        used_date_header = False
        from_line = msg.get_from() or ""
        from_line_parts = from_line.split(" ", 1)
        if len(from_line_parts) == 2:
            try:
                parsed = email.utils.parsedate_to_datetime(from_line_parts[1])
                if parsed.year > 2001:
                    sent_at = parsed
            except Exception:
                pass
        if sent_at is None:
            date_str = msg.get("Date") or ""
            if date_str:
                try:
                    sent_at = email.utils.parsedate_to_datetime(date_str)
                    used_date_header = True
                except Exception:
                    pass
        sent_at_approx = False
        if used_date_header and sent_at is not None:
            aware = sent_at if sent_at.tzinfo else sent_at.replace(tzinfo=timezone.utc)
            if aware < mbox_date:
                sent_at = mbox_date
                sent_at_approx = True

        from_name, from_email = "", ""
        from_str = msg.get("From") or ""
        if from_str:
            name, addr = email.utils.parseaddr(_decode_header(from_str))
            from_name = name or ""
            from_email = _normalize_email(addr) if addr else ""

        in_reply_to = _extract_message_id(msg.get("In-Reply-To"), prefer_last=True)
        refs = _extract_message_ids(msg.get("References"))
        thread_id = refs[0] if refs else message_id

        body = _strip_nul(_decode_body(msg))
        subject = _decode_subject(msg.get("Subject"))
        yield {
            "message_id": _strip_nul(message_id),
            "thread_id": _strip_nul(thread_id),
            "list_id": list_id,
            "sent_at": sent_at,
            "from_name": _strip_nul(from_name),
            "from_email": _strip_nul(from_email),
            "subject": subject,
            "in_reply_to": _strip_nul(in_reply_to) if in_reply_to else None,
            "refs": [_strip_nul(r) for r in refs] if refs else None,
            "body": body,
            "sent_at_approx": sent_at_approx,
            "_normalized_subject": _normalize_subject(subject),
            "_attachments": _parse_attachments(msg),
        }
