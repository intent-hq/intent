import io

old = (
    "the same unit as the `note.listVersions` summaries' `contentLength`)"
)
new = (
    "the same unit as the `note.listVersions` summaries' `contentLength` for the "
    "NUL-free content the daemon writes \u2014 `note.listVersions` uses SQL `LENGTH`, "
    "which stops at the first U+0000)"
)

for p in ("docs/protocol/versioning.md", "docs/protocol/methods/notes-tasks.md"):
    t = io.open(p, encoding="utf-8").read()
    assert t.count(old) == 1, f"{p}: expected exactly one occurrence, got {t.count(old)}"
    io.open(p, "w", encoding="utf-8").write(t.replace(old, new))

print("ok")
