### Debian / Ubuntu (.deb)

Every release also ships Debian packages (`intentd_<version>_amd64.deb` and
`intentd_<version>_arm64.deb`, built by `.github/workflows/build-deb.yml`) installing
the binary at `/usr/bin/intentd` and a systemd **user** unit at
`/usr/lib/systemd/user/intentd.service`. Download the .deb for your architecture from
the [releases page](https://github.com/intent-hq/intentd/releases), then:

```sh
sudo apt install ./intentd_<version>_amd64.deb
# The package does not auto-enable the unit (it is per-user); start it at login with:
systemctl --user enable --now intentd
```
