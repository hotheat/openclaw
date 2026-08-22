#!/usr/bin/env python3
"""Remove credential-shaped URL data from an AI review before publishing it."""

from __future__ import annotations

import argparse
import re

from pathlib import Path
from urllib.parse import SplitResult, urlsplit, urlunsplit

HTTP_URL_PATTERN = re.compile(
    r'https?://'
    r'(?:[^\s<>{}\[\]()`/@]+@)?'
    r'(?:\[[0-9a-f:.]+\]|[^\s<>{}\[\]()`/?#:]+)'
    r'(?::\d+)?'
    r'[^\s<>{}\[\]()`]*',
    re.IGNORECASE,
)


def _safe_netloc(parsed: SplitResult) -> str:
    """Return a URL authority without user information."""
    netloc = parsed.netloc.rsplit('@', maxsplit=1)[-1]
    if parsed.hostname is None:
        return netloc

    host = parsed.hostname
    if ':' in host:
        host = f'[{host}]'

    try:
        port = parsed.port
    except ValueError:
        return netloc
    return f'{host}:{port}' if port is not None else host


def _sanitize_url(match: re.Match[str]) -> str:
    parsed = urlsplit(match.group(0))
    sanitized = SplitResult(
        scheme=parsed.scheme,
        netloc=_safe_netloc(parsed),
        path=parsed.path,
        query='',
        fragment=parsed.fragment,
    )
    return urlunsplit(sanitized)


def sanitize_review(review: str) -> str:
    """Strip HTTP URL user information and queries while preserving review text."""
    return HTTP_URL_PATTERN.sub(_sanitize_url, review)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument('review_file', type=Path)
    args = parser.parse_args()
    review = args.review_file.read_text(encoding='utf-8')
    print(sanitize_review(review), end='')


if __name__ == '__main__':
    main()
