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

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      build-essential ca-certificates curl file git git-lfs jq libssl-dev \
      lsb-release pkg-config python3 python3-venv shellcheck tzdata unzip \
      xz-utils zip zstd \
 && rm -rf /var/lib/apt/lists/*

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
 && rm -rf /var/lib/apt/lists/* \
 && chown -R runner:runner /home/runner/actions-runner

COPY --chmod=0755 entrypoint.sh /usr/local/bin/runner-entrypoint

USER runner
ENV HOME=/home/runner \
    CARGO_HOME=/home/runner/.cargo \
    RUSTUP_HOME=/home/runner/.rustup \
    RUNNER_TOOL_CACHE=/opt/hostedtoolcache \
    AGENT_TOOLSDIRECTORY=/opt/hostedtoolcache \
    ImageOS=ubuntu24 \
    PATH=/home/runner/.cargo/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
RUN curl -fsSL -o /tmp/rustup-init "https://static.rust-lang.org/rustup/archive/${RUSTUP_VERSION}/x86_64-unknown-linux-gnu/rustup-init" \
 && echo "${RUSTUP_SHA256}  /tmp/rustup-init" | sha256sum -c - \
 && chmod +x /tmp/rustup-init \
 && /tmp/rustup-init -y --no-modify-path --profile minimal --default-toolchain "${RUST_TOOLCHAIN}" -c rustfmt -c clippy \
 && rm /tmp/rustup-init \
 && rm -rf /home/runner/.rustup/downloads /home/runner/.rustup/tmp

ENTRYPOINT ["/usr/local/bin/runner-entrypoint"]
