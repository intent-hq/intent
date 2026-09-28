"""Bounded, secret-safe GitHub readiness shared by doctor and status.

Two enforced identity responses, never auth-status's aggregate exit status or
/rate_limit's quota overview. Each API has its own state because REST and
GraphQL quotas/availability differ. No retries; at most two gh processes and
2 * GITHUB_READINESS_TIMEOUT seconds (default 3s per call, hard cap 10s).
"""
import datetime
import email.utils
import json
import math
import os
import re
import shutil
import signal
import subprocess
import sys

TIMEOUT_DEFAULT = 3.0
TIMEOUT_MAX = 10.0


def probe_timeout():
    try:
        value = float(os.environ.get("GITHUB_READINESS_TIMEOUT", TIMEOUT_DEFAULT))
    except ValueError:
        return TIMEOUT_DEFAULT
    # Do not echo untrusted environment values; they can contain credentials.
    return value if math.isfinite(value) and 0 < value <= TIMEOUT_MAX else TIMEOUT_DEFAULT


def unknown(reason):
    return {"state": "unknown", "reason": reason}


def utc(value):
    return value.astimezone(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def rate_limit(headers):
    result = {"state": "rate_limited"}
    reset = headers.get("x-ratelimit-reset", "")
    if re.fullmatch(r"[0-9]{1,12}", reset):
        try:
            result["resetAt"] = utc(datetime.datetime.fromtimestamp(int(reset), datetime.timezone.utc))
        except (ValueError, OverflowError, OSError):
            pass
    retry = headers.get("retry-after", "")
    if re.fullmatch(r"[0-9]{1,10}", retry):
        result["retryAfterSeconds"] = int(retry)
    elif retry:
        try:
            parsed = email.utils.parsedate_to_datetime(retry)
            if parsed.tzinfo is not None:
                result["retryAt"] = utc(parsed)
        except (ValueError, TypeError, OverflowError):
            pass
    return result


def classify(stdout, stderr, returncode, api):
    # --include prints response headers even on HTTP errors. Only trust the
    # response, not gh's human auth-status summary or a quota overview.
    matches = list(re.finditer(r"^HTTP/\S+ (\d{3})[^\n]*\n", stdout, re.MULTILINE))
    if not matches:
        # gh exits before an HTTP call when no token is configured. Nonzero
        # exits alone (including auth-status failures) are deliberately unknown.
        if returncode != 0 and re.search(
            r"^To get started with GitHub CLI, please run:\s+gh auth login\s*$",
            stderr, re.MULTILINE,
        ):
            return {"state": "unauthenticated", "reason": "missing_credentials"}
        return unknown("transport" if returncode else "invalid_response")
    match = matches[-1]
    status = int(match[1])
    header_text, separator, body_text = stdout[match.end():].replace("\r\n", "\n").partition("\n\n")
    # No headers is a single blank line after the status line.
    if header_text.startswith("\n"):
        body_text, header_text, separator = header_text[1:], "", "\n"
    headers = {}
    for line in header_text.splitlines():
        name, colon, value = line.partition(":")
        if colon:
            headers[name.lower()] = value.strip()
    try:
        body = json.loads(body_text) if separator else None
    except (ValueError, TypeError):
        body = None
    if not isinstance(body, dict):
        body = {}
    if status == 401:
        return {"state": "unauthenticated", "reason": "unauthorized"}
    errors = body.get("errors")
    errors = errors if isinstance(errors, list) else []
    graphql_limited = any(isinstance(error, dict) and error.get("type") == "RATE_LIMITED" for error in errors)
    message = body.get("message")
    message = message.lower() if isinstance(message, str) else ""
    limited = status == 429 or (status == 403 and (
        headers.get("x-ratelimit-remaining") == "0"
        or "retry-after" in headers
        or "secondary rate limit" in message
        or "api rate limit exceeded" in message
    )) or (api == "graphql" and status == 200 and graphql_limited)
    if limited:
        return rate_limit(headers)
    if 200 <= status < 300 and returncode == 0 and not errors:
        identity = body
        if api == "graphql":
            data = body.get("data")
            identity = data.get("viewer") if isinstance(data, dict) else None
        if isinstance(identity, dict) and isinstance(identity.get("login"), str) and identity["login"]:
            return {"state": "authenticated"}
    if status == 403:
        return unknown("forbidden")
    if status >= 500:
        return unknown("server_error")
    return unknown("invalid_response")


def probe(api, timeout):
    command = ["gh", "api", "user" if api == "rest" else "graphql", "--include", "--hostname", "github.com"]
    if api == "graphql":
        command += ["-f", "query=query { viewer { login } }"]
    env = os.environ.copy()
    env.pop("GH_DEBUG", None)
    env.update(GH_PROMPT_DISABLED="1", GH_PAGER="cat")
    try:
        process = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                   text=True, errors="replace", env=env, start_new_session=True)
    except OSError:
        return unknown("transport")
    try:
        stdout, stderr = process.communicate(timeout=timeout)
    except subprocess.TimeoutExpired:
        # A broken wrapper may leave descendants holding the pipes. Kill the
        # whole process group, as bootstrap's other bounded probes do.
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        process.communicate()
        return unknown("timeout")
    return classify(stdout, stderr, process.returncode, api)


def readiness(timeout=None):
    if shutil.which("gh") is None:
        return {"state": "missing_cli", "rest": unknown("missing_cli"),
                "graphql": unknown("missing_cli"), "prReady": False}
    budget = probe_timeout()
    if timeout is not None:
        budget = min(budget, timeout)
    rest, graphql = probe("rest", budget), probe("graphql", budget)
    states = {rest["state"], graphql["state"]}
    if "rate_limited" in states:
        state = "rate_limited"
    elif "authenticated" in states:
        state = "authenticated"
    elif states == {"unauthenticated"}:
        state = "unauthenticated"
    else:
        state = "unknown"
    return {"state": state, "rest": rest, "graphql": graphql,
            "prReady": graphql["state"] == "authenticated"}


def describe(report):
    if report["state"] == "missing_cli":
        return "GitHub CLI not installed; run make bootstrap-dev-host"
    rows = []
    authenticated = any(report[api]["state"] == "authenticated" for api in ("rest", "graphql"))
    for api, label in (("rest", "REST"), ("graphql", "GraphQL")):
        result = report[api]
        state = result["state"]
        if state == "rate_limited":
            text = "rate limited"
            if "resetAt" in result:
                text += f"; reset {result['resetAt']}"
            if "retryAfterSeconds" in result:
                text += f"; retry after {result['retryAfterSeconds']}s"
            if "retryAt" in result:
                text += f"; retry at {result['retryAt']}"
        elif state == "unknown":
            text = "unavailable (" + {
                "forbidden": "HTTP 403; permission or policy restriction",
                "server_error": "temporary server failure",
                "timeout": "probe timed out",
                "transport": "transport failure",
            }.get(result.get("reason"), "unrecognized response") + ")"
        elif state == "unauthenticated":
            text = "credentials missing or rejected"
            if not authenticated:
                text += "; run gh auth login"
        else:
            text = "authenticated"
        rows.append(f"{label} {text}")
    return "; ".join(rows)


if __name__ == "__main__":
    report = readiness()
    print(describe(report) if "--human" in sys.argv[1:] else json.dumps(report, separators=(",", ":")))
