def test_parse_mbox_recovers_attachments_from_embedded_git_patch_from_lines(
    ingest, tmp_path
):
    path = tmp_path / "pgsql-hackers.202409"
    path.write_text(
        """From pgsql-hackers-owner+archive@lists.postgresql.org Sun Sep 01 01:33:15 2024
Date: Sun, 1 Sep 2024 02:27:50 -0400
From: Andres Freund <andres@anarazel.de>
To: pgsql-hackers@postgresql.org
Subject: AIO v2.0
Message-ID: <root@example.com>
MIME-Version: 1.0
Content-Type: multipart/mixed; boundary="boundary"
Content-Disposition: inline

--boundary
Content-Type: text/plain; charset=us-ascii
Content-Disposition: inline

Hi,

See attached patches.

--boundary
Content-Type: text/x-diff; charset=us-ascii
Content-Disposition: attachment;
 filename="0001-first.patch"

From 1234567890abcdef1234567890abcdef12345678 Mon Sep 17 00:00:00 2001
From: Example Author <author@example.com>
Date: Sun, 1 Sep 2024 02:27:50 -0400
Subject: [PATCH 1/2] First patch

---
 file1 | 1 +
 1 file changed, 1 insertion(+)

--boundary
Content-Type: text/x-diff; charset=us-ascii
Content-Disposition: attachment;
 filename="0002-second.patch"

From abcdefabcdefabcdefabcdefabcdefabcdefabcd Mon Sep 17 00:00:00 2001
From: Example Author <author@example.com>
Date: Sun, 1 Sep 2024 02:27:50 -0400
Subject: [PATCH 2/2] Second patch

---
 file2 | 1 +
 1 file changed, 1 insertion(+)

--boundary--
""",
        encoding="utf-8",
    )

    records = list(ingest.parse_mbox(path, list_id=1))

    assert len(records) == 1
    assert records[0]["message_id"] == "<root@example.com>"
    assert [attachment["filename"] for attachment in records[0]["_attachments"]] == [
        "0001-first.patch",
        "0002-second.patch",
    ]


def test_parse_mbox_recovers_body_lines_starting_with_from(ingest, tmp_path):
    path = tmp_path / "pgsql-hackers.202603"
    path.write_text(
        """From pgsql-hackers-owner+archive@lists.postgresql.org Mon Mar 16 19:28:55 2026
Date: Mon, 16 Mar 2026 15:28:06 -0400
From: Jack Bonatakis <jack@bonatak.is>
To: pgsql-hackers@postgresql.org
Subject: Re: Read-only connection mode for AI workflows.
Message-ID: <root@example.com>
Content-Type: text/plain; charset=utf-8

Hi Andrei,

> Also, which commands do you want to restrict?

From my perspective, many AI integrations would want to limit just about anything that can change the state of the database.

That said, the design space becomes quite large.

Jack

From pgsql-hackers-owner+archive@lists.postgresql.org Mon Mar 16 19:34:21 2026
Date: Mon, 16 Mar 2026 19:34:12 +0100
From: Someone Else <someone@example.com>
To: pgsql-hackers@postgresql.org
Subject: Re: Another thread
Message-ID: <next@example.com>
Content-Type: text/plain; charset=utf-8

Second message.
""",
        encoding="utf-8",
    )

    records = list(ingest.parse_mbox(path, list_id=1))

    assert len(records) == 2
    assert records[0]["message_id"] == "<root@example.com>"
    assert records[0]["body"] == (
        "Hi Andrei,\n\n"
        "> Also, which commands do you want to restrict?\n\n"
        "From my perspective, many AI integrations would want to limit just about anything "
        "that can change the state of the database.\n\n"
        "That said, the design space becomes quite large.\n\n"
        "Jack\n"
    )
    assert records[1]["message_id"] == "<next@example.com>"


def test_parse_mbox_keeps_real_message_separator_with_underscore_header(
    ingest, tmp_path
):
    path = tmp_path / "pgsql-hackers.202603"
    path.write_text(
        """From pgsql-hackers-owner+archive@lists.postgresql.org Mon Mar 16 19:28:55 2026
Date: Mon, 16 Mar 2026 15:28:06 -0400
From: Example Author <author@example.com>
To: pgsql-hackers@postgresql.org
Subject: Patch set
Message-ID: <root@example.com>
MIME-Version: 1.0
Content-Type: multipart/mixed; boundary="boundary"

--boundary
Content-Type: text/plain; charset=utf-8

Please review.

--boundary
Content-Type: text/x-diff; charset=us-ascii
Content-Disposition: attachment; filename="0001-test.patch"

From 1234567890abcdef1234567890abcdef12345678 Mon Sep 17 00:00:00 2001
From: Example Author <author@example.com>
Date: Sun, 1 Sep 2024 02:27:50 -0400
Subject: [PATCH] Example change

---
 file1 | 1 +
 1 file changed, 1 insertion(+)

--boundary--

From pgsql-hackers-owner+archive@lists.postgresql.org Wed Mar 18 10:13:48 2026
Received: from mail.example.com ([192.0.2.10])
	by lists.postgresql.org with esmtp id 123
	for pgsql-hackers@postgresql.org;
	Wed, 18 Mar 2026 10:09:08 +0000
From: Someone Else <someone@example.com>
To: pgsql-hackers@postgresql.org
Subject: Re: Another thread
Message-ID: <next@example.com>
msip_labels: Example_Label
Content-Type: text/plain; charset=utf-8

Second message.
""",
        encoding="utf-8",
    )

    records = list(ingest.parse_mbox(path, list_id=1))

    assert len(records) == 2
    assert records[0]["message_id"] == "<root@example.com>"
    assert records[1]["message_id"] == "<next@example.com>"
    assert records[1]["body"] == "Second message.\n"


def test_parse_mbox_preserves_plain_from_body_line_during_sanitized_parse(
    ingest, tmp_path
):
    path = tmp_path / "pgsql-hackers.202603"
    path.write_text(
        """From pgsql-hackers-owner+archive@lists.postgresql.org Mon Mar 16 19:28:55 2026
Date: Mon, 16 Mar 2026 15:28:06 -0400
From: Example Author <author@example.com>
To: pgsql-hackers@postgresql.org
Subject: Patch set
Message-ID: <root@example.com>
MIME-Version: 1.0
Content-Type: multipart/mixed; boundary="boundary"

--boundary
Content-Type: text/plain; charset=utf-8

Hi Andrei,

From my perspective, many AI integrations would want to limit state changes.

That said, the design space becomes quite large.

--boundary
Content-Type: text/x-diff; charset=us-ascii
Content-Disposition: attachment; filename="0001-test.patch"

From 1234567890abcdef1234567890abcdef12345678 Mon Sep 17 00:00:00 2001
From: Example Author <author@example.com>
Date: Sun, 1 Sep 2024 02:27:50 -0400
Subject: [PATCH] Example change

---
 file1 | 1 +
 1 file changed, 1 insertion(+)

--boundary--

From pgsql-hackers-owner+archive@lists.postgresql.org Wed Mar 18 10:13:48 2026
Date: Wed, 18 Mar 2026 10:09:08 +0000
From: Someone Else <someone@example.com>
To: pgsql-hackers@postgresql.org
Subject: Re: Another thread
Message-ID: <next@example.com>
Content-Type: text/plain; charset=utf-8

Second message.
""",
        encoding="utf-8",
    )

    records = list(ingest.parse_mbox(path, list_id=1))

    assert len(records) == 2
    assert records[0]["message_id"] == "<root@example.com>"
    assert records[0]["body"] == (
        "Hi Andrei,\n\n"
        "From my perspective, many AI integrations would want to limit state changes.\n\n"
        "That said, the design space becomes quite large.\n"
    )
    assert records[1]["message_id"] == "<next@example.com>"


def test_parse_mbox_prefers_message_date_header_over_mbox_separator_timestamp(
    ingest, tmp_path
):
    path = tmp_path / "pgsql-hackers.202508"
    path.write_text(
        """From pgsql-hackers-owner+archive@lists.postgresql.org Thu Aug 07 17:16:16 2025
Date: Thu, 7 Aug 2025 12:46:47 -0400
From: Mat Arye <mat@example.com>
To: pgsql-hackers@postgresql.org
Subject: Read-only connection mode for AI workflows.
Message-ID: <root@example.com>
Content-Type: text/plain; charset=utf-8

Hello.
""",
        encoding="utf-8",
    )

    records = list(ingest.parse_mbox(path, list_id=1))

    assert len(records) == 1
    assert records[0]["sent_at"].isoformat() == "2025-08-07T12:46:47-04:00"
    assert records[0]["sent_at_approx"] is False


def test_parse_mbox_falls_back_to_mbox_separator_timestamp_when_date_header_is_missing(
    ingest, tmp_path
):
    path = tmp_path / "pgsql-hackers.202508"
    path.write_text(
        """From pgsql-hackers-owner+archive@lists.postgresql.org Thu Aug 07 17:16:16 2025
From: Mat Arye <mat@example.com>
To: pgsql-hackers@postgresql.org
Subject: Read-only connection mode for AI workflows.
Message-ID: <root@example.com>
Content-Type: text/plain; charset=utf-8

Hello.
""",
        encoding="utf-8",
    )

    records = list(ingest.parse_mbox(path, list_id=1))

    assert len(records) == 1
    assert records[0]["sent_at"].isoformat() == "2025-08-07T17:16:16"
    assert records[0]["sent_at_approx"] is False
