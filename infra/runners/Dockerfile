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
# Preinstalled on GitHub-hosted ubuntu-24.04 and called by routed jobs without
# a setup step (see docs/GITHUB_RUNNERS.md, Preinstalled tools).
ARG GH_VERSION=2.102.0
ARG GH_SHA256=bb766f710eef8ede859c18578c72c327597cd4c8a85b06001b1f3843c6019386
ARG NODE_VERSION=24.22.0
ARG NODE_SHA256=cc2f601cee82d9a5a233302fe307abc600727035fd7d2c3a3571755989e95008
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

# Node lives in /opt/node owned by runner, so `corepack enable` and
# `npm install -g` work without sudo, as on hosted runners.
RUN fetch-release cli/cli "v${GH_VERSION}" "gh_${GH_VERSION}_linux_amd64.tar.gz" /tmp/gh.tgz \
 && echo "${GH_SHA256}  /tmp/gh.tgz" | sha256sum -c - \
 && tar xzf /tmp/gh.tgz -C /tmp && install -m 0755 "/tmp/gh_${GH_VERSION}_linux_amd64/bin/gh" /usr/local/bin/gh \
 && curl -fsSL --retry 3 --retry-all-errors -o /tmp/node.txz "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz" \
 && echo "${NODE_SHA256}  /tmp/node.txz" | sha256sum -c - \
 && install -d -o runner -g runner /opt/node && tar xJf /tmp/node.txz -C /opt/node --strip-components=1 && chown -R runner:runner /opt/node \
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
 && /tmp/rustup-init -y --no-modify-path --profile minimal --default-toolchain "${RUST_TOOLCHAIN}" -c rustfmt -c clippy \
 && rm /tmp/rustup-init \
 && rm -rf /home/runner/.rustup/downloads /home/runner/.rustup/tmp

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

ENTRYPOINT ["/usr/local/bin/runner-entrypoint"]
