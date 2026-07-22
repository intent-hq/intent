import pathlib

root = pathlib.Path("/tmp/intentd-deb")
scratch = pathlib.Path(__file__).resolve().parent

p = root / "dist-workspace.toml"
s = p.read_text()
old = 'post-announce-jobs = ["./publish-channel-manifest"]'
assert old in s, "post-announce-jobs line not found"
s = s.replace(old, 'post-announce-jobs = ["./publish-channel-manifest", "./build-deb"]')
p.write_text(s)

p = root / ".github/workflows/ci.yml"
s = p.read_text()
assert "deb-packaging:" not in s, "deb-packaging job already present"
job = (scratch / "ci-deb-job.yml").read_text()
p.write_text(s.rstrip("\n") + "\n" + job)

p = root / "README.md"
s = p.read_text()
section = (scratch / "readme-deb-section.md").read_text()
anchor = "\n## Quickstart\n"
assert s.count(anchor) == 1, "README Quickstart anchor not unique"
p.write_text(s.replace(anchor, "\n" + section + anchor))

print("ok")
