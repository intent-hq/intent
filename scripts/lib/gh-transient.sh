# shellcheck shell=bash
# ERE (for grep -iE) matching gh stderr from failures a later poll can retry:
# rate limits, 5xx and every connection-level error (Go's `dial tcp|udp`, any
# errno from connect, i/o or TLS timeouts). An unmatched "no route to host"
# from a brief outage evicted the "Wait for shipped alpha" hook. Shared by
# shipped-in.sh and pin-includes.sh so their polling hooks agree.
# shellcheck disable=SC2034
gh_transient_pattern='rate limit|HTTP 429|HTTP 5[0-9]{2}|error connecting|dial (tcp|udp)|connection (reset|refused|timed out)|no route to host|host is (down|unreachable)|network is (down|unreachable)|timeout|no such host|temporary failure|unexpected EOF|broken pipe'
