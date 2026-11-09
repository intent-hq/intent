# Ephemeral GitHub Actions runner for the intent-cache box.
# One fresh container per job; see docs/GITHUB_RUNNERS.md.
#
# Paths match GitHub-hosted runners (HOME=/home/runner, work directory
# /home/runner/work, CARGO_HOME=/home/runner/.cargo, RUSTUP_HOME=/home/runner/.rustup)
# so sccache keys match entries written on hosted runners.
FROM ubuntu:24.04@sha256:68ee22004a9109b44973313b02ff7b1de250f1de0f5ecb628d73f579aaff33ac

ARG RUNNER_VERSION=2.338.0
ARG RUNNER_SHA256=af4b794c1bc41d73d40535e3fe092a39f9679cd8d965954c2aca25a05ca41d32
ARG RUSTUP_VERSION=1.29.1
ARG RUSTUP_SHA256=dda7234360b7f578ca8b0ddcb80145646fa61a67c1720a5abc7051b35c9fcb71
# Baked so jobs using this toolchain do not download it; others are installed
# per job by rustup and discarded with the container.
ARG RUST_TOOLCHAIN=1.96.0
# Cargo tools intentd's CI installs with taiki-e/install-action, which
# downloads on every run; intentd's cargo-tools action uses these instead
# when present. The builds install-action picks (gnu nextest, musl others),
# with the SHA-256 of each release asset.
ARG CARGO_NEXTEST_VERSION=0.9.151
ARG CARGO_NEXTEST_SHA256=1d4ce302b820c41f4b89c5fb9bce45f0f0c94882c1cf08fc360caf08be6e7df4
ARG CARGO_LLVM_COV_VERSION=0.9.1
ARG CARGO_LLVM_COV_SHA256=3fca950394a3c49457657c158b1619cec8dfd2647ae5b48746734c0ab969a522
ARG CARGO_SHEAR_VERSION=1.14.0
ARG CARGO_SHEAR_SHA256=9004df4eb031a456026c4326ae0d0ce545321527a67be90f4524c1be729dc40e
# Preinstalled on GitHub-hosted ubuntu-24.04 and called by routed jobs without
# a setup step (see docs/GITHUB_RUNNERS.md, Preinstalled tools).
ARG GH_VERSION=2.102.0
ARG GH_SHA256=bb766f710eef8ede859c18578c72c327597cd4c8a85b06001b1f3843c6019386
ARG NODE_VERSION=24.22.0
ARG NODE_SHA256=cc2f601cee82d9a5a233302fe307abc600727035fd7d2c3a3571755989e95008
# NODE_VERSION and these sit in the tool cache, so setup-node finds every
# version workflows ask for and downloads nothing: <version>=<SHA-256 of
# node-v<version>-linux-x64.tar.xz> (from nodejs.org SHASUMS256.txt).
ARG NODE_TOOLCACHE="22.23.4=1805bcd35e6815559bd2eb97db438d3fdb0eb3a5e6a977b7c1badca76337e9ce 24.21.0=fd8e59d5a511510f6a298afb548f18c7d2b1be404d8b4a27d94fbe49f56cb2d6"
ARG PWSH_VERSION=7.4.6
ARG PWSH_SHA256=6f6015203c47806c5cc444c19d8ed019695e610fbd948154264bf9ca8e157561
# Every minor that workflows pass to setup-python, baked into the tool cache
# so the action finds it and downloads nothing (see docs/GITHUB_RUNNERS.md,
# Preinstalled tools). From actions/python-versions: version, release build
# number (the tag is <version>-<build>) and the linux-24.04-x64 SHA-256.
ARG PYTHON_3_11_VERSION=3.11.18
ARG PYTHON_3_11_BUILD=40260280589
ARG PYTHON_3_11_SHA256=099ef30fc27f0d7067a67be5a5fb7fd66154cfa1e4186c88f71c3a3070c81abc
ARG PYTHON_3_12_VERSION=3.12.16
ARG PYTHON_3_12_BUILD=40260402378
ARG PYTHON_3_12_SHA256=dec61ed20cd3e71143f1642ef9966945dea8ae4f3e96b306205a710da4f2191a

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      bison build-essential ca-certificates curl file gcc-mingw-w64-x86-64 git git-lfs iproute2 jq libssl-dev lsof \
      lsb-release pkg-config procps python3 python3-pip python3-venv rsync shellcheck \
      tzdata unzip xz-utils zip zstd \
 && apt-get install -y --no-install-recommends \
# Chromium's shared libraries (Playwright 1.58 install-deps, ubuntu24.04-x64
# chromium list plus its non-font tools), so browser jobs need no sudo.
      libasound2t64 libatk-bridge2.0-0t64 libatk1.0-0t64 libatspi2.0-0t64 libcairo2 libcups2t64 \
      libdbus-1-3 libdrm2 libgbm1 libglib2.0-0t64 libnspr4 libnss3 libpango-1.0-0 libx11-6 libxcb1 \
      libxcomposite1 libxdamage1 libxext6 libxfixes3 libxkbcommon0 libxrandr2 \
      libfontconfig1 libfreetype6 xvfb
# Package lists stay in the image, as on hosted runners: jobs simulate
# installs (`apt-get install -s`, e.g. playwright install-deps --dry-run).

COPY --chmod=0755 fetch-release.sh /usr/local/bin/fetch-release

# Same user name and uid as GitHub-hosted runners. No sudo: jobs run
# unprivileged; anything they need from apt belongs in this image.
RUN userdel -r ubuntu 2>/dev/null || true \
 && useradd --create-home --uid 1001 --shell /bin/bash runner \
 && install -d -o runner -g runner /home/runner/work /home/runner/actions-runner /opt/hostedtoolcache

WORKDIR /home/runner/actions-runner
RUN fetch-release actions/runner "v${RUNNER_VERSION}" "actions-runner-linux-x64-${RUNNER_VERSION}.tar.gz" runner.tgz \
 && echo "${RUNNER_SHA256}  runner.tgz" | sha256sum -c - \
 && tar xzf runner.tgz && rm runner.tgz \
 && ./bin/installdependencies.sh \
 && chown -R runner:runner /home/runner/actions-runner

# Node lives in the tool cache, owned by runner and linked as /opt/node, so
# `corepack enable` and `npm install -g` work without sudo, as on hosted
# runners, and setup-node finds it.
RUN fetch-release cli/cli "v${GH_VERSION}" "gh_${GH_VERSION}_linux_amd64.tar.gz" /tmp/gh.tgz \
 && echo "${GH_SHA256}  /tmp/gh.tgz" | sha256sum -c - \
 && tar xzf /tmp/gh.tgz -C /tmp && install -m 0755 "/tmp/gh_${GH_VERSION}_linux_amd64/bin/gh" /usr/local/bin/gh \
 && curl -fsSL --retry 3 --retry-all-errors -o /tmp/node.txz "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz" \
 && echo "${NODE_SHA256}  /tmp/node.txz" | sha256sum -c - \
 && node_dir="/opt/hostedtoolcache/node/${NODE_VERSION}/x64" && install -d "$node_dir" \
 && tar xJf /tmp/node.txz -C "$node_dir" --strip-components=1 && touch "$node_dir.complete" \
 && chown -R runner:runner /opt/hostedtoolcache/node && ln -s "$node_dir" /opt/node \
 && fetch-release PowerShell/PowerShell "v${PWSH_VERSION}" "powershell-${PWSH_VERSION}-linux-x64.tar.gz" /tmp/pwsh.tgz \
 && echo "${PWSH_SHA256}  /tmp/pwsh.tgz" | sha256sum -c - \
 && install -d /opt/microsoft/powershell/7 && tar xzf /tmp/pwsh.tgz -C /opt/microsoft/powershell/7 \
 && chmod +x /opt/microsoft/powershell/7/pwsh && ln -s /opt/microsoft/powershell/7/pwsh /usr/local/bin/pwsh \
 && rm -rf /tmp/gh* /tmp/node.txz /tmp/pwsh.tgz

COPY --chmod=0755 entrypoint.sh /usr/local/bin/runner-entrypoint

USER runner
ENV HOME=/home/runner \
    CARGO_HOME=/home/runner/.cargo \
    RUSTUP_HOME=/home/runner/.rustup \
    RUNNER_TOOL_CACHE=/opt/hostedtoolcache \
    AGENT_TOOLSDIRECTORY=/opt/hostedtoolcache \
    ImageOS=ubuntu24 \
    PATH=/home/runner/.cargo/bin:/opt/node/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
RUN curl -fsSL --retry 3 --retry-all-errors -o /tmp/rustup-init "https://static.rust-lang.org/rustup/archive/${RUSTUP_VERSION}/x86_64-unknown-linux-gnu/rustup-init" \
 && echo "${RUSTUP_SHA256}  /tmp/rustup-init" | sha256sum -c - \
 && chmod +x /tmp/rustup-init \
 && /tmp/rustup-init -y --no-modify-path --profile minimal --default-toolchain "${RUST_TOOLCHAIN}" -c rustfmt -c clippy -c llvm-tools-preview \
 && rm /tmp/rustup-init \
 && rm -rf /home/runner/.rustup/downloads /home/runner/.rustup/tmp

RUN set -eu; \
    install_cargo_tool() { \
      fetch-release "$1" "$2" "$3" /tmp/tool.tgz; \
      echo "$5  /tmp/tool.tgz" | sha256sum -c -; \
      tar xzf /tmp/tool.tgz -C "$CARGO_HOME/bin" "$4"; \
      rm /tmp/tool.tgz; \
      test -x "$CARGO_HOME/bin/$4"; \
    }; \
    install_cargo_tool nextest-rs/nextest "cargo-nextest-$CARGO_NEXTEST_VERSION" \
      "cargo-nextest-$CARGO_NEXTEST_VERSION-x86_64-unknown-linux-gnu.tar.gz" cargo-nextest "$CARGO_NEXTEST_SHA256"; \
    install_cargo_tool taiki-e/cargo-llvm-cov "v$CARGO_LLVM_COV_VERSION" \
      cargo-llvm-cov-x86_64-unknown-linux-musl.tar.gz cargo-llvm-cov "$CARGO_LLVM_COV_SHA256"; \
    install_cargo_tool Boshen/cargo-shear "v$CARGO_SHEAR_VERSION" \
      cargo-shear-x86_64-unknown-linux-musl.tar.gz cargo-shear "$CARGO_SHEAR_SHA256"

# setup.sh is the installer setup-python runs after its own download.
RUN set -eu; \
    install_python() { \
      fetch-release actions/python-versions "$1-$2" "python-$1-linux-24.04-x64.tar.gz" /tmp/python.tgz; \
      echo "$3  /tmp/python.tgz" | sha256sum -c -; \
      mkdir /tmp/python && tar xzf /tmp/python.tgz -C /tmp/python; \
      (cd /tmp/python && PIP_NO_CACHE_DIR=1 bash ./setup.sh); \
      rm -rf /tmp/python /tmp/python.tgz; \
      test -f "$RUNNER_TOOL_CACHE/Python/$1/x64.complete"; \
    }; \
    install_python "$PYTHON_3_11_VERSION" "$PYTHON_3_11_BUILD" "$PYTHON_3_11_SHA256"; \
    install_python "$PYTHON_3_12_VERSION" "$PYTHON_3_12_BUILD" "$PYTHON_3_12_SHA256"

RUN set -eu; \
    for entry in $NODE_TOOLCACHE; do \
      version="${entry%%=*}"; dir="$RUNNER_TOOL_CACHE/node/$version/x64"; \
      curl -fsSL --retry 3 --retry-all-errors -o /tmp/node.txz "https://nodejs.org/dist/v$version/node-v$version-linux-x64.tar.xz"; \
      echo "${entry#*=}  /tmp/node.txz" | sha256sum -c -; \
      mkdir -p "$dir"; tar xJf /tmp/node.txz -C "$dir" --strip-components=1; touch "$dir.complete"; \
      rm /tmp/node.txz; \
    done

ENTRYPOINT ["/usr/local/bin/runner-entrypoint"]
