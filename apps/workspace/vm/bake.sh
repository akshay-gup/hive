#!/usr/bin/env bash
# Turns a fresh Ubuntu 24.04 Droplet into the image every workspace's Droplet is made from.
#
# The workspace is taken out of the container image the project builds (apps/workspace/Dockerfile),
# so a machine runs the program the container does, and is then set up as a machine: its own user,
# a firewall, a service that starts it, and a disk that keeps what the agent installs. It ends by
# powering the machine off, which is how apps/control/tools/do-image.ts knows it is done. A Droplet
# that stays on has failed, and /var/log/hive-bake.log says why.
#
#   HIVE_WORKSPACE_IMAGE   the container image to take the workspace from (required)
#   HIVE_REGISTRY_USER     a login for the registry the image is in, if it needs one
#   HIVE_REGISTRY_TOKEN
#
# With no argument it runs every stage in turn. With one it runs that stage alone, which is for
# testing it: prepare, fetch, install, seal.
set -euo pipefail
# Files and folders made here are made the same whoever started this.
umask 022

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
WORK=${HIVE_BAKE_DIR:-$HERE}
PAYLOAD=${HIVE_BAKE_PAYLOAD:-$WORK/payload}
export DEBIAN_FRONTEND=noninteractive NEEDRESTART_SUSPEND=1

# A machine that has just started may be updating itself, and holds the package lock while it does.
apt() { apt-get -o DPkg::Lock::Timeout=600 "$@"; }

# The same user the container image has, so a disk that moves between the two still fits.
HIVE_UID=10001

# The tunnel client, for workspaces that are reached through a Cloudflare Tunnel. A release is pinned
# here and its package checked against the checksum, so what a workspace runs does not change under
# it. To take a newer one, change both (or set HIVE_CLOUDFLARED_VERSION and HIVE_CLOUDFLARED_SHA256,
# the checksum of cloudflared-linux-amd64.deb on its release page).
CLOUDFLARED_VERSION=${HIVE_CLOUDFLARED_VERSION:-2026.10.0}
CLOUDFLARED_SHA256=${HIVE_CLOUDFLARED_SHA256:-9721287c28f78cb623e77c7b95a63feea87e909054d75666a0ec9eff20e5d548}

# The tool the updater reads a newer build with: one static program, no Docker. Pinned like cloudflared.
CRANE_VERSION=${HIVE_CRANE_VERSION:-0.22.1}
CRANE_SHA256=${HIVE_CRANE_SHA256:-0ab7a1d6932a213aed964ce97666c3077fe691c8606413674a8b3e0b9ec4cda0}

say() { printf '\n==> %s\n' "$*"; }

# What the agent finds on its machine is what the container image gives it: the tools a shell
# session reaches for. The firewall is the machine's own, and sudo is for the agent.
prepare() {
  say "Packages"
  apt update
  apt -y upgrade
  apt install -y --no-install-recommends ca-certificates curl git jq python3 ripgrep unzip nftables sudo
  install_cloudflared
  install_crane
}

# Installed on every machine, and started only on one given a tunnel token (see hive-tunnel.service).
install_cloudflared() {
  say "cloudflared $CLOUDFLARED_VERSION"
  if [ "$(dpkg --print-architecture)" != amd64 ]; then
    echo "The pinned cloudflared is for amd64; this machine is $(dpkg --print-architecture)" >&2
    exit 1
  fi
  local deb=$WORK/cloudflared.deb
  curl -fsSL --retry 3 -o "$deb" \
    "https://github.com/cloudflare/cloudflared/releases/download/$CLOUDFLARED_VERSION/cloudflared-linux-amd64.deb"
  echo "$CLOUDFLARED_SHA256  $deb" | sha256sum --check --strict -
  apt install -y --no-install-recommends "$deb"
  rm -f "$deb"
  cloudflared --version
}

# Kept on the machine, unlike Docker: it is what lets a machine be updated without being made again.
install_crane() {
  say "crane $CRANE_VERSION"
  local tgz=$WORK/crane.tgz
  curl -fsSL --retry 3 -o "$tgz" \
    "https://github.com/google/go-containerregistry/releases/download/v$CRANE_VERSION/go-containerregistry_Linux_x86_64.tar.gz"
  echo "$CRANE_SHA256  $tgz" | sha256sum --check --strict -
  tar -xzf "$tgz" -C /usr/local/bin crane
  rm -f "$tgz"
  crane version
}

# The browser the agent works with. Chromium and the libraries it needs are installed here, with the
# Playwright that came in the image, so the two match. They are kept out of the container image to
# keep updates small. An update that moves Playwright to a new version needs a new snapshot, or the
# browser will not start (the workspace goes on without it and says so).
install_browser() {
  say "Chromium"
  local cli=/app/browser-worker/node_modules/playwright/cli.js
  [ -f "$cli" ] || { echo "The image has no browser worker ($cli)" >&2; exit 1; }
  PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright "$PAYLOAD/node" "$cli" install --with-deps --only-shell chromium
  chmod -R a+rX /opt/ms-playwright
}

# Docker is here only to take the workspace out of its image; seal removes it.
fetch() {
  : "${HIVE_WORKSPACE_IMAGE:?HIVE_WORKSPACE_IMAGE names the container image to take the workspace from}"
  local image=$HIVE_WORKSPACE_IMAGE
  say "The workspace, from $image"
  command -v docker >/dev/null || apt install -y --no-install-recommends docker.io
  local login=
  if [ -n "${HIVE_REGISTRY_TOKEN:-}" ]; then
    login=yes
    local registry=
    case "${image%%/*}" in *.* | *:* | localhost) registry=${image%%/*} ;; esac
    # shellcheck disable=SC2086 # the registry is one word, or none for Docker Hub
    printf '%s' "$HIVE_REGISTRY_TOKEN" |
      docker login $registry --username "${HIVE_REGISTRY_USER:?HIVE_REGISTRY_USER goes with the token}" --password-stdin
  fi
  docker image inspect "$image" >/dev/null 2>&1 || docker pull "$image"
  rm -rf "$PAYLOAD"
  mkdir -p "$PAYLOAD"
  local container
  container=$(docker create "$image")
  docker cp "$container:/app" "$PAYLOAD/app"
  docker cp "$container:/usr/local/bin/node" "$PAYLOAD/node"
  docker cp "$container:/usr/local/bin/opencode" "$PAYLOAD/opencode"
  docker rm "$container" >/dev/null
  docker inspect --format '{{index .RepoDigests 0}}' "$image" >"$PAYLOAD/digest" 2>/dev/null || echo "$image" >"$PAYLOAD/digest"
  # The login is not part of the image that is made.
  if [ -n "$login" ]; then docker logout >/dev/null 2>&1 || true; fi
}

install_workspace() {
  say "The workspace"
  getent group hive >/dev/null || groupadd --gid "$HIVE_UID" hive
  id hive >/dev/null 2>&1 ||
    useradd --uid "$HIVE_UID" --gid "$HIVE_UID" --create-home --home-dir /home/hive --shell /usr/sbin/nologin hive
  # The agent may become root. The machine is the team's own, and what the agent installs for
  # itself (packages, services) is then part of it and stays. It does not run as root: it asks.
  echo 'hive ALL=(ALL) NOPASSWD:ALL' >/etc/sudoers.d/90-hive-workspace
  chmod 0440 /etc/sudoers.d/90-hive-workspace
  visudo -cf /etc/sudoers.d/90-hive-workspace
  install -m 0755 "$PAYLOAD/node" /usr/local/bin/node
  install -m 0755 "$PAYLOAD/opencode" /usr/local/bin/opencode
  rm -rf /app
  cp -a "$PAYLOAD/app" /app
  install_browser
  # Where the workspace keeps everything of its own. The disk is the machine's, so it all stays.
  install -d -m 0755 /data
  # Settings come here at first boot, readable by root alone.
  install -d -m 0755 /etc/hive
  printf '{"image":"%s","baked":"%s"}\n' "$(cat "$PAYLOAD/digest")" "$(date -u +%FT%TZ)" >/etc/hive/image.json
  install -m 0644 "$HERE/hive-workspace.service" /etc/systemd/system/hive-workspace.service
  # Enabled so that it comes back when the machine does; it does not start without its settings.
  systemctl enable hive-workspace.service
  # The same for the tunnel: it comes back with the machine, and does not start without its token.
  install -m 0644 "$HERE/hive-tunnel.service" /etc/systemd/system/hive-tunnel.service
  systemctl enable hive-tunnel.service
  # The updater: the timer asks now and then, the path unit starts it when asked to update now. Neither
  # does anything on a machine whose /etc/hive/updater.json has not been written.
  install -d -m 0755 /var/lib/hive
  install -m 0755 "$HERE/hive-update" /usr/local/sbin/hive-update
  for unit in hive-update.service hive-update.timer hive-update.path; do
    install -m 0644 "$HERE/$unit" "/etc/systemd/system/$unit"
  done
  systemctl enable hive-update.timer hive-update.path

  say "The firewall"
  nft -c -f "$HERE/nftables.conf"
  install -m 0644 "$HERE/nftables.conf" /etc/nftables.conf
  systemctl enable nftables.service

  say "Login, logs and memory"
  mkdir -p /run/sshd /etc/ssh/sshd_config.d /etc/systemd/journald.conf.d /etc/sysctl.d
  cat >/etc/ssh/sshd_config.d/10-hive.conf <<'EOF'
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin prohibit-password
EOF
  sshd -t
  # A machine that is up for months keeps its logs, and not without end.
  cat >/etc/systemd/journald.conf.d/10-hive.conf <<'EOF'
[Journal]
Storage=persistent
SystemMaxUse=400M
EOF
  # What the agent runs can use more memory than the machine has for a moment. Swap is for that.
  if ! grep -q '^/swapfile ' /etc/fstab; then
    fallocate -l 2G /swapfile
    chmod 600 /swapfile
    mkswap /swapfile >/dev/null
    echo '/swapfile none swap sw 0 0' >>/etc/fstab
  fi
  echo 'vm.swappiness=10' >/etc/sysctl.d/90-hive.conf

  check
}

# Starts the workspace once, the way the service does, on a scratch disk and with settings made up
# here, and stops it: an image that cannot do that is not worth a snapshot.
check() {
  say "Starting a workspace to see that it does"
  /usr/local/bin/node --version
  /usr/local/bin/opencode --version
  cloudflared --version
  runuser -u hive -- sudo -n true
  # A browser that cannot start is found out here, not by the first person who asks the agent to browse.
  runuser -u hive -- env PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright /usr/local/bin/node -e '
    import("/app/browser-worker/node_modules/playwright/index.mjs").then(async ({ chromium }) => {
      const browser = await chromium.launch({ headless: true });
      const page = await browser.newPage();
      await page.setContent("<title>ok</title>");
      if ((await page.title()) !== "ok") throw new Error("the page did not load");
      await browser.close();
    }).catch((error) => { console.error(error); process.exit(1); });
  '
  local dir port=18787
  dir=$(mktemp -d /tmp/hive-check.XXXXXX)
  chmod 755 "$dir"
  install -d -o "$HIVE_UID" -g "$HIVE_UID" "$dir/home"
  /usr/local/bin/node -e '
    const { generateKeyPairSync } = require("node:crypto");
    const { writeFileSync } = require("node:fs");
    const [, dir, port] = process.argv;
    const key = generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "der" }).toString("base64url");
    writeFileSync(dir + "/workspace.json", JSON.stringify({
      WORKSPACE_MODE: "live",
      WORKSPACE_ID: "wcheck",
      CONTROL_PLANE_PUBLIC_KEY: key,
      PUBLIC_API_URL: "http://127.0.0.1:" + port,
      ALLOWED_ORIGINS: "https://hive.invalid",
      HOST: "127.0.0.1",
      PORT: port,
      DATA_DIR: dir + "/data/hive",
      MODEL: "anthropic/check",
    }), { mode: 0o600 });
  ' "$dir" "$port"
  (
    cd /app
    exec env -i PATH=/usr/local/bin:/usr/bin:/bin NODE_ENV=production HIVE_ENV_FILE="$dir/workspace.json" \
      VOLUME_DIR="$dir/data" WORKSPACE_UID="$HIVE_UID" WORKSPACE_GID="$HIVE_UID" WORKSPACE_HOME="$dir/home" \
      /usr/local/bin/node dist/apps/workspace/src/index.js >"$dir/log" 2>&1
  ) &
  local pid=$! answered=
  for _ in $(seq 1 180); do
    if curl -fsS "http://127.0.0.1:$port/api/health" 2>/dev/null | jq -e '.ok == true and .workspace == "wcheck"' >/dev/null; then
      answered=yes
      break
    fi
    kill -0 "$pid" 2>/dev/null || break
    sleep 1
  done
  kill -TERM "$pid" 2>/dev/null || true
  local status=0
  wait "$pid" || status=$?
  if [ -z "$answered" ] || [ "$status" != 0 ]; then
    echo "The workspace did not start cleanly (answered: ${answered:-no}, exit: $status). Its output:" >&2
    cat "$dir/log" >&2
    exit 1
  fi
  rm -rf "$dir"
}

# Leaves the disk as a new machine's: no docker, nothing of this machine's own identity, nothing
# of the bake, and then switches the machine off for the snapshot.
seal() {
  say "Cleaning up"
  apt purge -y docker.io containerd runc
  apt autoremove -y --purge
  apt clean
  rm -rf /var/lib/apt/lists/* /var/lib/docker /var/lib/containerd /etc/docker /root/.docker
  # Bash remembers where it found docker when fetch ran it, and `command -v` goes on saying so after
  # the file is gone.
  hash -r
  if command -v docker >/dev/null; then
    echo "docker is still installed" >&2
    exit 1
  fi
  # Each Droplet makes its own host keys and machine id when it first starts.
  rm -f /etc/ssh/ssh_host_*
  : >/etc/machine-id
  rm -rf /root/.ssh /root/.bash_history /home/hive/.bash_history
  command -v cloud-init >/dev/null && cloud-init clean --logs --seed
  journalctl --rotate >/dev/null 2>&1 || true
  rm -rf /var/log/journal/*
  find /var/log -type f \( -name '*.gz' -o -name '*.[0-9]' \) -delete
  find /var/log -type f -exec truncate -s 0 {} +
  rm -rf /tmp/* /var/tmp/*
  if [ -z "${HIVE_BAKE_KEEP:-}" ]; then rm -rf "$WORK"; fi
  sync
  say "Done: switching off"
  systemctl poweroff
}

stage=${1:-all}
if [ "$stage" = all ]; then
  exec > >(tee -a /var/log/hive-bake.log) 2>&1
  # Settings for this run come in a file that only root can read, which is gone once it is read.
  if [ -f "$WORK/bake.env" ]; then
    set -a
    # shellcheck disable=SC1091
    . "$WORK/bake.env"
    set +a
    rm -f "$WORK/bake.env"
  fi
  prepare
  fetch
  install_workspace
  seal
else
  case "$stage" in
    prepare | fetch | check | seal) "$stage" ;;
    install) install_workspace ;;
    *)
      echo "No stage $stage: prepare, fetch, install, check or seal" >&2
      exit 2
      ;;
  esac
fi
