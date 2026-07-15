#!/usr/bin/env bash
set -Eeuo pipefail

LAVALAMP_VERSION="${1:-latest}"
INSTALL_DIR="${INSTALL_DIR:-$HOME/.agents/bin}"
REPO="rahuletto/lavalamp"
ASSET_PREFIX="lavalamp"

# Global cleanup variables
tmp_dir=""

info() { printf '[lavalamp] %s\n' "$*"; }
warn() { printf '[lavalamp] Warning: %s\n' "$*" >&2; }
error() { printf '[lavalamp] Error: %s\n' "$*" >&2; exit 1; }

require_downloader() {
  command -v curl >/dev/null 2>&1 || command -v wget >/dev/null 2>&1 ||
    error "curl or wget is required"
}

download() {
  local url="$1" destination="$2"
  local size=0
  
  if command -v curl >/dev/null 2>&1; then
    size=$(curl -sIL "$url" | grep -i '^content-length:' | tail -n 1 | tr -d '\r' | cut -d' ' -f2 || echo 0)
  fi
  
  if ! [[ "$size" =~ ^[0-9]+$ ]]; then
    size=0
  fi

  if command -v curl >/dev/null 2>&1; then
    curl --fail --silent --show-error --location --retry 3 \
      --output "$destination" "$url" &
  else
    wget --quiet --tries=3 --output-document="$destination" "$url" &
  fi
  
  local pid=$!
  local current=0
  local percent=0
  local bar_size=20
  local filled=0
  local empty=0
  local bar=""
  
  while kill -0 $pid 2>/dev/null; do
    if [ -f "$destination" ]; then
      if [ "$(uname -s)" = "Darwin" ]; then
        current=$(stat -f %z "$destination" 2>/dev/null || echo 0)
      else
        current=$(stat -c %s "$destination" 2>/dev/null || echo 0)
      fi
      
      if [ "$size" -gt 0 ]; then
        percent=$(( current * 100 / size ))
        if [ "$percent" -gt 100 ]; then percent=100; fi
        
        filled=$(( percent * bar_size / 100 ))
        empty=$(( bar_size - filled ))
        
        bar=""
        for ((i=0; i<filled; i++)); do bar="${bar}#"; done
        for ((i=0; i<empty; i++)); do bar="${bar}-"; done
        
        local cur_mb=$((current / 1048576))
        local cur_frac=$(( (current % 1048576) * 10 / 1048576 ))
        local sz_mb=$((size / 1048576))
        local sz_frac=$(( (size % 1048576) * 10 / 1048576 ))
        
        printf '\r[lavalamp] Downloading... [%-20s] %d%% (%d.%d/%d.%d MB)' "$bar" "$percent" "$cur_mb" "$cur_frac" "$sz_mb" "$sz_frac" >&2
      else
        local cur_mb=$((current / 1048576))
        local cur_frac=$(( (current % 1048576) * 10 / 1048576 ))
        printf '\r[lavalamp] Downloading... %d.%d MB' "$cur_mb" "$cur_frac" >&2
      fi
    fi
    sleep 0.1
  done
  
  wait $pid
  local exit_code=$?
  
  if [ $exit_code -eq 0 ]; then
    if [ "$size" -gt 0 ]; then
      bar=""
      for ((i=0; i<bar_size; i++)); do bar="${bar}#"; done
      local sz_mb=$((size / 1048576))
      local sz_frac=$(( (size % 1048576) * 10 / 1048576 ))
      printf '\r[lavalamp] Downloading... [%-20s] 100%% (%d.%d/%d.%d MB)\n' "$bar" "$sz_mb" "$sz_frac" "$sz_mb" "$sz_frac" >&2
    else
      printf '\r[lavalamp] Downloading... Done\n' >&2
    fi
    return 0
  else
    printf '\n' >&2
    return $exit_code
  fi
}

download_optional() {
  local url="$1" destination="$2"
  if command -v curl >/dev/null 2>&1; then
    curl --fail --silent --show-error --location --output "$destination" "$url" 2>/dev/null
  else
    wget --quiet --output-document="$destination" "$url" 2>/dev/null
  fi
}

detect_platform() {
  local os arch
  case "$(uname -s)" in
    Linux*) os="linux" ;;
    Darwin*) os="darwin" ;;
    MINGW*|MSYS*|CYGWIN*) error "Windows installation is not currently supported; use a Linux or macOS host" ;;
    *) error "Unsupported OS: $(uname -s)" ;;
  esac

  case "$(uname -m)" in
    x86_64|amd64) arch="x64" ;;
    arm64|aarch64) arch="arm64" ;;
    *) error "Unsupported architecture: $(uname -m)" ;;
  esac

  if [ "$os" = "darwin" ] && [ "$arch" = "x64" ] &&
    [ "$(sysctl -in sysctl.proc_translated 2>/dev/null || true)" = "1" ]; then
    arch="arm64"
  fi

  printf '%s-%s\n' "$os" "$arch"
}

get_latest_version() {
  local response version latest_url
  if command -v curl >/dev/null 2>&1; then
    response="$(curl --fail --silent --show-error --location --retry 3 \
      "https://api.github.com/repos/${REPO}/releases/latest" 2>/dev/null || true)"
  else
    response="$(wget --quiet --tries=3 --output-document=- \
      "https://api.github.com/repos/${REPO}/releases/latest" 2>/dev/null || true)"
  fi
  version="$(printf '%s' "$response" | sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1)"
  [ -n "$version" ] && { printf '%s\n' "$version"; return; }

  # Fallback avoids the API and extracts the tag from GitHub's latest-release redirect.
  if command -v curl >/dev/null 2>&1; then
    latest_url="$(curl --fail --silent --show-error --location --output /dev/null \
      --write-out '%{url_effective}' "https://github.com/${REPO}/releases/latest")" || return 1
  else
    latest_url="$(wget --server-response --spider \
      "https://github.com/${REPO}/releases/latest" 2>&1 |
      sed -n 's/^[[:space:]]*Location: \([^[:space:]]*\).*/\1/p' | tail -n 1)"
  fi
  version="${latest_url##*/}"
  [ -n "$version" ] && [ "$version" != "latest" ] && printf '%s\n' "$version"
}

verify_checksum_if_available() {
  local base_url="$1" asset_name="$2" binary="$3"
  local checksum_file="$4" checksum_name expected actual

  for checksum_name in "${asset_name}.sha256" SHA256SUMS checksums.txt; do
    if download_optional "${base_url}/${checksum_name}" "$checksum_file"; then
      if [ "$checksum_name" = "${asset_name}.sha256" ]; then
        expected="$(sed -n 's/^\([0-9A-Fa-f]\{64\}\).*/\1/p' "$checksum_file" | head -n 1)"
      else
        expected="$(awk -v name="$asset_name" '$2 == name || $2 == "*" name { print $1; exit }' "$checksum_file")"
      fi
      [ -n "$expected" ] || continue

      if command -v sha256sum >/dev/null 2>&1; then
        actual="$(sha256sum "$binary" | awk '{print $1}')"
      elif command -v shasum >/dev/null 2>&1; then
        actual="$(shasum -a 256 "$binary" | awk '{print $1}')"
      else
        error "A checksum was published, but sha256sum or shasum is required to verify it"
      fi
      [ "$(printf '%s' "$expected" | tr '[:upper:]' '[:lower:]')" = "$actual" ] ||
        error "Checksum verification failed for ${asset_name}"
      info "Verified SHA-256 checksum from ${checksum_name}"
      return
    fi
  done
  warn "No matching published checksum was found; proceeding without checksum verification"
}

setup_path() {
  local marker='# lavalamp installer PATH' config shell_name path_line
  case ":${PATH}:" in *":${INSTALL_DIR}:"*) info "PATH already includes ${INSTALL_DIR}"; return ;; esac

  shell_name="$(basename "${SHELL:-/bin/bash}")"
  case "$shell_name" in
    zsh) config="$HOME/.zshrc" ;;
    fish) config="$HOME/.config/fish/config.fish" ;;
    bash) [ "$(uname -s)" = Darwin ] && config="$HOME/.bash_profile" || config="$HOME/.bashrc" ;;
    *) warn "Add ${INSTALL_DIR} to PATH to run lavalamp from a new shell"; return ;;
  esac

  mkdir -p "$(dirname "$config")"
  touch "$config"
  if grep -Fq "$marker" "$config"; then
    info "PATH is already configured in ${config}"
    return
  fi
  if [ "$shell_name" = fish ]; then
    path_line="fish_add_path ${INSTALL_DIR}"
  else
    path_line="export PATH=\"${INSTALL_DIR}:\$PATH\""
  fi
  printf '\n%s\n%s\n' "$marker" "$path_line" >> "$config"
  info "Added ${INSTALL_DIR} to PATH in ${config} (restart your shell or source that file)"
}

install_lavalamp() {
  local platform version asset_name base_url candidate checksum_file destination
  platform="$(detect_platform)"
  version="$LAVALAMP_VERSION"
  if [ "$version" = latest ]; then
    version="$(get_latest_version)" || error "Failed to resolve the latest GitHub release"
    [ -n "$version" ] || error "Failed to resolve the latest GitHub release"
  fi

  # Release naming convention: lavalamp-{linux|darwin}-{x64|arm64}.
  asset_name="${ASSET_PREFIX}-${platform}"
  base_url="https://github.com/${REPO}/releases/download/${version}"
  mkdir -p "$INSTALL_DIR"
  tmp_dir="$(mktemp -d "${INSTALL_DIR}/.lavalamp-install.XXXXXX")"
  trap 'rm -rf "$tmp_dir"' EXIT
  candidate="${tmp_dir}/lavalamp"
  checksum_file="${tmp_dir}/checksum"
  destination="${INSTALL_DIR}/lavalamp"

  info "Downloading ${asset_name} from release ${version}"
  download "${base_url}/${asset_name}" "$candidate" ||
    error "Failed to download ${base_url}/${asset_name}"
  [ -s "$candidate" ] || error "Downloaded binary is empty"
  verify_checksum_if_available "$base_url" "$asset_name" "$candidate" "$checksum_file"
  chmod +x "$candidate"
  "$candidate" --version >/dev/null 2>&1 ||
    error "Downloaded binary failed its --version smoke check"
  mv -f "$candidate" "$destination"

  "$destination" --version >/dev/null 2>&1 ||
    error "Installed binary failed its --version smoke check"
  info "Installed and verified ${destination}"
  setup_path
  info "Run '${destination} --version' now, or 'lavalamp' after refreshing your PATH"
}

main() {
  require_downloader
  install_lavalamp
}

main "$@"
