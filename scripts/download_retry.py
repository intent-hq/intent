"""Bounded retry for CI downloads that a transient GitHub/CDN failure would fail.

A single GitHub 504 on a release download ejected merge-queue PRs
(intent-hq/intent#8613, runs 41999101145 and 41999539245). Retry transient
failures only: 5xx responses, connection errors and timeouts. A 4xx (a wrong
version, asset name or pin) fails at once.

Load it as a sibling so `python3 -I` callers (which drop the script directory
from sys.path) can use it:

    spec = importlib.util.spec_from_file_location(
        "download_retry", Path(__file__).with_name("download_retry.py"))

Ported from intent-hq/intentd scripts/download_retry.py; keep the copies in
step. scripts/test_setup_sccache.py covers it.
"""
import http.client
import ssl
import sys
import time
import urllib.error

# Delays between attempts, in seconds: four attempts in all.
RETRY_DELAYS = (2, 5, 15)


def transient(error):
    """True for a failure another attempt may not hit: 5xx, network, timeout."""
    if isinstance(error, urllib.error.HTTPError):
        return error.code >= 500
    return isinstance(error, (urllib.error.URLError, TimeoutError, ConnectionError, ssl.SSLError,
                              http.client.HTTPException))


def retrying(operation, label, delays=RETRY_DELAYS, sleep=None, cleanup=None):
    """Return operation() with bounded retries on transient failures.

    `cleanup` runs before each retry (for example to drop a partial file).
    A non-transient error, or the last transient one, is re-raised.
    """
    for attempt, delay in enumerate((*delays, None), start=1):
        try:
            return operation()
        except Exception as error:
            if delay is None or not transient(error):
                raise
            print(f"::warning::{label} attempt {attempt} failed ({error}); retrying in {delay}s",
                  file=sys.stderr)
            if cleanup is not None:
                cleanup()
            (sleep or time.sleep)(delay)
