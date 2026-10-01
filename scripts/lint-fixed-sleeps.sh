#!/usr/bin/env bash
#
# Fixed-sleep annotation lint for the monorepo shell suites.
#
# A fixed sleep in a `scripts/*.test.sh` suite is a timing assumption: on a
# positive path it wastes the whole delay, and it flakes as soon as the machine
# is slower than the number (intent-hq/intent#5411, #5422). Positive-path waits
# belong on an observable event (a barrier file, a deadline-bounded poll on the
# state under test). This lint fails, naming `file:line`, for every fixed sleep
# that is neither justified with a `timing-guard:` marker nor grandfathered by
# the committed baseline. It mirrors intentd's
# `crates/intent-core/tests/fixed_sleep_lint.rs` so agents learn one convention.
#
# Scanned: every `scripts/*.test.sh` (non-recursive), sorted; the lint's own
# self-test `scripts/lint-fixed-sleeps.test.sh` is skipped by name because its
# fixtures spell the patterns out.
#
# A line has a fixed sleep when (leading blanks trimmed; never when it starts
# with `#`):
#   1. it contains a shell `sleep` at a word boundary, followed by blanks and an
#      argument that (after stripping leading quotes) starts with a digit, `.`
#      or `{`. Only the exact `sleep 60 &` stay-alive idiom is exempt: the `&`
#      must be the whole operator, so `sleep 60 &&` and `sleep 60 &>` count;
#   2. it contains `time.sleep(` followed by a numeric literal (python heredocs);
#   3. it is a fixed-count loop header `for <name> in {<int>..<int>}` (optional
#      step) whose body, up to the matching `done` (nesting-aware for
#      `for`/`while`/`until`...`done`), contains a sleep per rule 1 or 2. The
#      `for` line is the reported site; the inner sleep counts on its own.
#      Loop words count only in command position (so `f() {` opens a function
#      body and `echo done` is an argument), and the body of a `<<` / `<<-`
#      heredoc is data for loop tracking: it opens and closes no shell loop,
#      while rules 1 and 2 still scan it (`cat <<'SH'` writes executable stubs).
#
# Known limitations of rule 3 (accepted, pinned by the self-test's "known
# limitations" group). Tokenisation is line-local, so a construct that spans
# lines can confuse the loop tracker, which then may miss or misattribute loop
# findings for the rest of the file:
#   - a multi-line `$(( … ))` / `(( … ))` whose `<<` sits on a continuation
#     line is taken as a heredoc opener: later loop headers are missed, and a
#     `done` inside the mistaken heredoc region leaves its loop open, so a later
#     marked sleep is reported against that earlier header;
#   - a `case` pattern `done)` at the start of a line closes the loop early.
# Rules 1 and 2 are unaffected. A contributor who hits one can restructure the
# expression onto one line or add a `# timing-guard:` marker.
#
# Marker: `# timing-guard: <reason>` in a `#` comment (standalone or trailing)
# on the sleep's own line or the line immediately above exempts it, e.g.
# `# timing-guard: poll interval`. The reason is required: a bare
# `timing-guard:` is malformed, never exempts, and is reported as its own error.
# Detection is line-based: `"…"` / `'…'` literals are skipped when locating the
# `#`; heredoc state affects loop tracking only, so a marker on a heredoc line
# exempts the sleep on that line as usual.
#
# Baseline (`scripts/fixed-sleep-baseline.txt`): one `<path> <count>` line per
# file that still has unannotated sleeps, sorted by path. It only ratchets down:
# a file over its entry (or absent from the baseline) fails naming every
# unannotated line; a file under its entry, or an entry whose file is gone,
# fails naming the exact baseline line to write.
#
# Usage:
#   scripts/lint-fixed-sleeps.sh                 # exit 1 on any finding
#   scripts/lint-fixed-sleeps.sh --print-counts  # print `<path> <count>` for every
#                                                # scanned file with unannotated
#                                                # sleeps (baseline regeneration)

set -euo pipefail
export LC_ALL=C

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)
cd "$repo_root"

baseline_file=scripts/fixed-sleep-baseline.txt
self_test=scripts/lint-fixed-sleeps.test.sh
marker='timing-guard:'

print_counts=0
case "${1:-}" in
  '') ;;
  --print-counts) print_counts=1 ;;
  *)
    printf 'usage: %s [--print-counts]\n' "$0" >&2
    exit 2
    ;;
esac

# Emit `line:malformed:text` for every fixed sleep in the file that carries no
# reasoned marker on its own line or the line above; `malformed` is 1 when one
# of those two lines carries a `timing-guard:` marker with no reason.
read -r -d '' scan_awk <<'AWK' || true
function trim(s) { sub(/^[ \t]+/, "", s); sub(/[ \t]+$/, "", s); return s }

# Is the text after a shell `sleep` the `60 &` stay-alive idiom? The `&` must
# be the complete operator: followed by nothing or anything but `&` / `>`.
function stay_alive(arg) {
  return substr(arg, 1, 4) == "60 &" && substr(arg, 5, 1) !~ /[&>]/
}

# Does the `sleep` at offset `at` of `line` take a fixed argument (rule 1)?
function sleep_at(line, at,   after, arg) {
  if (at > 1 && substr(line, at - 1, 1) ~ /[A-Za-z0-9_]/) return 0
  after = substr(line, at + 5)
  arg = after
  sub(/^[ \t]+/, "", arg)
  if (length(arg) == length(after) || stay_alive(arg)) return 0
  sub(/^["']+/, "", arg)
  return arg ~ /^[0-9.{]/
}

# Fill pos[] with the offset of every fixed sleep on `line` (rules 1 and 2),
# in offset order; return how many. Callers pass the line cut at its `#`
# comment (see mask()), so `echo ok # sleep 1` never counts; a sleep before
# the comment still does.
function sleep_positions(line, pos,   n, t, rest, off, at, a, b, v) {
  n = 0
  split("", pos)
  t = line
  sub(/^[ \t]+/, "", t)
  if (substr(t, 1, 1) == "#") return 0
  rest = line
  off = 0
  while ((at = index(rest, "sleep")) > 0) {
    if (sleep_at(line, off + at)) pos[++n] = off + at
    off += at + 4
    rest = substr(rest, at + 5)
  }
  rest = line
  off = 0
  while (match(rest, /time\.sleep\([0-9.]/)) {
    pos[++n] = off + RSTART
    off += RSTART
    rest = substr(rest, RSTART + 1)
  }
  for (a = 2; a <= n; a++) {
    v = pos[a]
    for (b = a - 1; b >= 1 && pos[b] > v; b--) pos[b + 1] = pos[b]
    pos[b + 1] = v
  }
  return n
}

# Blank out the contents of `"…"` / `'…'` literals (keeping offsets) and drop
# everything from the first `#` comment on; sets comment_at to that `#` offset
# (0 when the line has no comment). As in the shell, an unquoted `#` starts a
# comment only at the start of a word: first on the line or after a blank or
# one of `; & | ( ) { }` — `foo#bar` is one word.
function mask(line,   out, i, n, c, in_dq, in_sq) {
  out = ""; in_dq = 0; in_sq = 0; comment_at = 0
  n = length(line)
  for (i = 1; i <= n; i++) {
    c = substr(line, i, 1)
    if (in_sq) {
      if (c == "'") { in_sq = 0; out = out c } else out = out " "
      continue
    }
    if (in_dq) {
      if (c == "\\") { out = out "  "; i++; continue }
      if (c == "\"") { in_dq = 0; out = out c } else out = out " "
      continue
    }
    if (c == "\\") { out = out "  "; i++; continue }
    if (c == "'") { in_sq = 1; out = out c; continue }
    if (c == "\"") { in_dq = 1; out = out c; continue }
    if (c == "#" && (i == 1 || substr(line, i - 1, 1) ~ /[ \t;&|(){}]/)) { comment_at = i; break }
    out = out c
  }
  return out
}

# 0 = no marker, 1 = marker with a reason, 2 = malformed (marker, no reason).
# Only a marker inside the line's `#` comment counts.
function classify_marker(line,   comment, at) {
  mask(line)
  if (comment_at == 0) return 0
  comment = substr(line, comment_at)
  at = index(comment, marker)
  if (at == 0) return 0
  return trim(substr(comment, at + length(marker))) == "" ? 2 : 1
}

# Fill kpos[] / kind[] with every loop reserved word on the masked line, in
# offset order: "fixed" (a fixed-count `for` header), "open" (any other
# `for`/`while`/`until`, including a bare `while` whose condition follows on
# the next line) or "done". Return how many.
#
# The line is split into shell words (quoted text is already blanked by
# mask(), so `"done"` is never a word). A word is a loop keyword only when it
# is exactly `for`/`while`/`until`/`do`/`done` AND stands in command position:
# the first word of the line, the word after `;` `&&` `||` `|` `&` `(` `{`, the
# word after the `)` that closes a function's `()` or a subshell (a `$(…)`,
# `<(…)` or `>(…)` substitution ends mid-word instead, so `echo $(x) done` is
# an argument), or the word after a `do`/`then`/`else`/`{` that was itself in
# command position. A leading `NAME=value` assignment keeps command position
# for the next word; any other word (`echo do done`, `done=1`, `echo {`) ends it.
function keyword_tokens(masked, kpos, kind,   n, i, len, c, start, word, cmdpos, pd, psub) {
  n = 0
  split("", kpos); split("", kind); split("", psub)
  len = length(masked)
  cmdpos = 1
  pd = 0
  i = 1
  while (i <= len) {
    c = substr(masked, i, 1)
    if (c == " " || c == "\t") { i++; continue }
    if (c == ";" || c == "&" || c == "|" || c == "(" || c == ")") {
      if (c == "(") { pd++; psub[pd] = (i > 1 && substr(masked, i - 1, 1) ~ /[$<>]/) }
      if (i < len && substr(masked, i + 1, 1) == c) i++
      i++
      cmdpos = 1
      if (c == ")" && pd > 0) { cmdpos = !psub[pd]; pd-- }
      continue
    }
    start = i
    while (i <= len && substr(masked, i, 1) !~ /[ \t;&|()]/) i++
    word = substr(masked, start, i - start)
    if (!cmdpos) continue
    if (word == "done") {
      n++; kpos[n] = start; kind[n] = "done"
      cmdpos = 0
    } else if (word == "for") {
      n++; kpos[n] = start
      kind[n] = (substr(masked, start) ~ /^for[ \t]+[A-Za-z_][A-Za-z0-9_]*[ \t]+in[ \t]+[{]-?[0-9]+\.\.-?[0-9]+(\.\.-?[0-9]+)?[}]/) ? "fixed" : "open"
      cmdpos = 0
    } else if (word == "while" || word == "until") {
      n++; kpos[n] = start; kind[n] = "open"
      cmdpos = 0
    } else if (word == "do" || word == "then" || word == "else" || word == "{") {
      cmdpos = 1
    } else if (word !~ /^[A-Za-z_][A-Za-z0-9_]*=/) {
      cmdpos = 0
    }
  }
  return n
}

# Append the delimiter of every heredoc operator on the line (`<<` / `<<-`,
# never the `<<<` here-string) to the hd_delim[] / hd_strip[] queue. The
# operator is located on the masked line so quoted or commented `<<` never
# opens one, and neither does the left shift inside an arithmetic `$((…))` /
# `((…))`: a `(` right after another `(` opens an arithmetic level (parens
# nest inside it), and `<<` is an operator while any such level is open. The
# delimiter is read from the raw line as one shell word — `'…'` / `"…"`
# spans and `\`-escapes included, so `<<'END CODE'` and `<<END\ CODE` name
# `END CODE` — and stored with the quoting removed, as the shell compares it.
function heredoc_openers(masked, raw,   len, rlen, i, j, c, pd, na, arith, strip, word) {
  len = length(masked)
  rlen = length(raw)
  pd = 0; na = 0
  split("", arith)
  for (i = 1; i < len; i++) {
    c = substr(masked, i, 1)
    if (c == "(") {
      pd++
      arith[pd] = 0
      if (pd > 1 && substr(masked, i - 1, 1) == "(") {
        if (!arith[pd - 1]) { arith[pd - 1] = 1; na++ }
        arith[pd] = 1; na++
      }
      continue
    }
    if (c == ")") {
      if (pd > 0) { if (arith[pd]) na--; pd-- }
      continue
    }
    if (c != "<" || substr(masked, i + 1, 1) != "<") continue
    if (substr(masked, i + 2, 1) == "<") { i += 2; continue }
    if (na > 0) { i++; continue }
    i += 2
    strip = 0
    if (substr(masked, i, 1) == "-") { strip = 1; i++ }
    while (i <= rlen && substr(raw, i, 1) ~ /[ \t]/) i++
    word = ""
    for (j = i; j <= rlen; j++) {
      c = substr(raw, j, 1)
      if (c == "'") {
        for (j++; j <= rlen && substr(raw, j, 1) != "'"; j++) word = word substr(raw, j, 1)
      } else if (c == "\"") {
        for (j++; j <= rlen && (c = substr(raw, j, 1)) != "\""; j++) {
          if (c == "\\" && substr(raw, j + 1, 1) ~ /["\\$`]/) j++
          word = word substr(raw, j, 1)
        }
      } else if (c == "\\") {
        j++
        if (j <= rlen) word = word substr(raw, j, 1)
      } else if (c ~ /[ \t;&|<>()]/) {
        break
      } else {
        word = word c
      }
    }
    if (word != "") { hd_n++; hd_delim[hd_n] = word; hd_strip[hd_n] = strip }
    i = j - 1
  }
}

function emit(lineno, text, m_here, m_above) {
  if (m_here == 1 || m_above == 1) return
  printf "%d:%d:%s\n", lineno, (m_here == 2 || m_above == 2) ? 1 : 0, text
}

# Pop the innermost loop; report it if it is a fixed-count loop whose body slept.
function close_loop() {
  if (st_fixed[depth] && st_flag[depth])
    emit(st_line[depth], st_text[depth], st_here[depth], st_above[depth])
  depth--
}

FNR == 1 { depth = 0; m_above = 0; hd_n = 0; hd_at = 1 }
{
  m_here = classify_marker($0)
  masked = mask($0)
  ns = sleep_positions(comment_at ? substr($0, 1, comment_at - 1) : $0, spos)
  if (hd_at <= hd_n) {
    # Heredoc data: rules 1-2 and markers apply as on any line, loop words
    # do not. The terminator line is the delimiter alone (`<<-` strips tabs).
    nk = 0
    term = $0
    if (hd_strip[hd_at]) sub(/^\t+/, "", term)
    if (term == hd_delim[hd_at]) hd_at++
    if (hd_at > hd_n) { hd_n = 0; hd_at = 1 }
  } else {
    nk = keyword_tokens(masked, kpos, kind)
    heredoc_openers(masked, $0)
  }
  if (ns > 0) emit(FNR, trim($0), m_here, m_above)
  # Walk sleeps and loop keywords in offset order so a same-line
  # `for … do sleep 1; done` attributes the sleep to its own loop.
  i = 1; j = 1
  while (i <= ns || j <= nk) {
    if (j > nk || (i <= ns && spos[i] < kpos[j])) {
      for (k = 1; k <= depth; k++) if (st_fixed[k]) st_flag[k] = 1
      i++
      continue
    }
    if (kind[j] == "done") {
      if (depth > 0) close_loop()
    } else if (kind[j] == "fixed") {
      depth++
      st_fixed[depth] = 1; st_flag[depth] = 0
      st_line[depth] = FNR; st_text[depth] = trim($0)
      st_here[depth] = m_here; st_above[depth] = m_above
    } else if (depth > 0) {
      depth++
      st_fixed[depth] = 0; st_flag[depth] = 0
    }
    j++
  }
  m_above = m_here
}
END { while (depth > 0) close_loop() }
AWK

trim() {
  local s=$1
  s=${s#"${s%%[![:space:]]*}"}
  s=${s%"${s##*[![:space:]]}"}
  printf '%s' "$s"
}

# ---- scan -------------------------------------------------------------------

scanned_paths=()
scanned_counts=()
scanned_sites=()
malformed=()
for file in scripts/*.test.sh; do
  [[ -f "$file" && "$file" != "$self_test" ]] || continue
  sites=$(awk -v marker="$marker" "$scan_awk" "$file" | sort -t: -k1,1n)
  count=0
  if [[ -n "$sites" ]]; then
    while IFS= read -r record; do
      count=$((count + 1))
      lineno=${record%%:*}
      rest=${record#*:}
      if [[ "${rest%%:*}" == 1 ]]; then
        malformed+=("$file:$lineno: ${rest#*:}")
      fi
    done <<<"$sites"
  fi
  scanned_paths+=("$file")
  scanned_counts+=("$count")
  scanned_sites+=("$sites")
done

if [[ ${#scanned_paths[@]} -eq 0 ]]; then
  printf 'error: no scripts/*.test.sh found under %s\n' "$repo_root" >&2
  exit 1
fi

if [[ "$print_counts" -eq 1 ]]; then
  for ((i = 0; i < ${#scanned_paths[@]}; i++)); do
    if [[ "${scanned_counts[i]}" -gt 0 ]]; then
      printf '%s %s\n' "${scanned_paths[i]}" "${scanned_counts[i]}"
    fi
  done
  exit 0
fi

# ---- baseline ---------------------------------------------------------------

baseline_paths=()
baseline_counts=()
baseline_linenos=()
baseline_error() {
  printf '%s:%s: error: %s\n' "$baseline_file" "$1" "$2" >&2
  exit 1
}

if [[ ! -f "$baseline_file" ]]; then
  printf '%s: error: baseline file is missing\n' "$baseline_file" >&2
  exit 1
fi
n=0
previous=
while IFS= read -r raw || [[ -n "$raw" ]]; do
  n=$((n + 1))
  line=$(trim "$raw")
  [[ -z "$line" || "$line" == \#* ]] && continue
  if [[ "$line" != *[[:space:]]* ]]; then
    baseline_error "$n" "expected \`<path> <count>\`, got \"$raw\""
  fi
  count=${line##*[[:space:]]}
  path=$(trim "${line%[[:space:]]*}")
  case "$count" in
    *[!0-9]*) baseline_error "$n" "count \"$count\" is not a number" ;;
  esac
  count=$((10#$count))
  if [[ "$count" -eq 0 ]]; then
    baseline_error "$n" "a file with no unannotated sleeps has no entry; remove \"$raw\""
  fi
  if [[ -n "$previous" && ! "$previous" < "$path" ]]; then
    baseline_error "$n" "entries must be sorted by path and unique, but \"$path\" follows \"$previous\""
  fi
  previous=$path
  baseline_paths+=("$path")
  baseline_counts+=("$count")
  baseline_linenos+=("$n")
done <"$baseline_file"

# Index of `$1` in baseline_paths, or -1.
baseline_index() {
  local i
  for ((i = 0; i < ${#baseline_paths[@]}; i++)); do
    if [[ "${baseline_paths[i]}" == "$1" ]]; then
      printf '%s' "$i"
      return
    fi
  done
  printf '%s' -1
}

# ---- classify + render ------------------------------------------------------

report=
finding() {
  report+="$1"$'\n'
}

for ((i = 0; i < ${#malformed[@]}; i++)); do
  finding "${malformed[i]%%: *}: error: timing-guard marker is malformed: expected \`# $marker <reason>\` in a \`#\` comment; the reason is required: ${malformed[i]#*: }"
done

for ((i = 0; i < ${#scanned_paths[@]}; i++)); do
  path=${scanned_paths[i]}
  count=${scanned_counts[i]}
  b=$(baseline_index "$path")
  if [[ "$b" -lt 0 ]]; then
    allowed=
    allowed_text='the baseline has no entry for it'
  else
    allowed=${baseline_counts[b]}
    allowed_text="the baseline allows $allowed"
  fi
  if [[ "$count" -gt "${allowed:-0}" ]]; then
    finding "$path: $count unannotated fixed sleep(s), $allowed_text:"
    while IFS= read -r record; do
      lineno=${record%%:*}
      rest=${record#*:}
      finding "$path:$lineno: error: unannotated fixed sleep: ${rest#*:}"
    done <<<"${scanned_sites[i]}"
    finding "  fix: justify each new sleep with \`# $marker <reason>\` on its line or the one above, or replace it with a wait on an observable event; as a last resort (never preferred) set its entry in $baseline_file to \`$path $count\`."
  elif [[ -n "$allowed" && "$count" -eq 0 ]]; then
    finding "$baseline_file:${baseline_linenos[b]}: error: $path has no unannotated fixed sleeps left but the baseline allows $allowed; the ratchet only moves down: remove its line \`$path $allowed\`"
  elif [[ -n "$allowed" && "$count" -lt "$allowed" ]]; then
    finding "$baseline_file:${baseline_linenos[b]}: error: $path has $count unannotated fixed sleep(s) but the baseline allows $allowed; the ratchet only moves down: replace its line with \`$path $count\`"
  fi
done

for ((i = 0; i < ${#baseline_paths[@]}; i++)); do
  path=${baseline_paths[i]}
  found=0
  for ((j = 0; j < ${#scanned_paths[@]}; j++)); do
    if [[ "${scanned_paths[j]}" == "$path" ]]; then
      found=1
      break
    fi
  done
  if [[ "$found" -eq 0 ]]; then
    finding "$baseline_file:${baseline_linenos[i]}: error: $path no longer exists; remove its line \`$path ${baseline_counts[i]}\`"
  fi
done

if [[ -n "$report" ]]; then
  printf 'error: fixed sleeps in scripts/*.test.sh are out of step with %s:\n%s' "$baseline_file" "$report" >&2
  exit 1
fi
