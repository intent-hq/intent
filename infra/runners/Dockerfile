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

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      bison build-essential ca-certificates curl file git git-lfs iproute2 jq libssl-dev lsof \
      lsb-release pkg-config procps python3 python3-pip python3-venv rsync shellcheck \
      tzdata unzip xz-utils zip zstd
# Package lists stay in the image, as on hosted runners: jobs simulate
# installs (`apt-get install -s`, e.g. playwright install-deps --dry-run).

# Same user name and uid as GitHub-hosted runners. No sudo: jobs run
# unprivileged; anything they need from apt belongs in this image.
RUN userdel -r ubuntu 2>/dev/null || true \
 && useradd --create-home --uid 1001 --shell /bin/bash runner \
 && install -d -o runner -g runner /home/runner/work /home/runner/actions-runner /opt/hostedtoolcache

WORKDIR /home/runner/actions-runner
RUN curl -fsSL -o runner.tgz "https://github.com/actions/runner/releases/download/v${RUNNER_VERSION}/actions-runner-linux-x64-${RUNNER_VERSION}.tar.gz" \
 && echo "${RUNNER_SHA256}  runner.tgz" | sha256sum -c - \
 && tar xzf runner.tgz && rm runner.tgz \
 && ./bin/installdependencies.sh \
 && chown -R runner:runner /home/runner/actions-runner

# Node lives in /opt/node owned by runner, so `corepack enable` and
# `npm install -g` work without sudo, as on hosted runners.
RUN curl -fsSL -o /tmp/gh.tgz "https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_linux_amd64.tar.gz" \
 && echo "${GH_SHA256}  /tmp/gh.tgz" | sha256sum -c - \
 && tar xzf /tmp/gh.tgz -C /tmp && install -m 0755 "/tmp/gh_${GH_VERSION}_linux_amd64/bin/gh" /usr/local/bin/gh \
 && curl -fsSL -o /tmp/node.txz "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz" \
 && echo "${NODE_SHA256}  /tmp/node.txz" | sha256sum -c - \
 && install -d -o runner -g runner /opt/node && tar xJf /tmp/node.txz -C /opt/node --strip-components=1 && chown -R runner:runner /opt/node \
 && curl -fsSL -o /tmp/pwsh.tgz "https://github.com/PowerShell/PowerShell/releases/download/v${PWSH_VERSION}/powershell-${PWSH_VERSION}-linux-x64.tar.gz" \
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
RUN curl -fsSL -o /tmp/rustup-init "https://static.rust-lang.org/rustup/archive/${RUSTUP_VERSION}/x86_64-unknown-linux-gnu/rustup-init" \
 && echo "${RUSTUP_SHA256}  /tmp/rustup-init" | sha256sum -c - \
 && chmod +x /tmp/rustup-init \
 && /tmp/rustup-init -y --no-modify-path --profile minimal --default-toolchain "${RUST_TOOLCHAIN}" -c rustfmt -c clippy \
 && rm /tmp/rustup-init \
 && rm -rf /home/runner/.rustup/downloads /home/runner/.rustup/tmp

ENTRYPOINT ["/usr/local/bin/runner-entrypoint"]
