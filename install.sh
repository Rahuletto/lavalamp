#!/bin/bash
set -euo pipefail

LAVALAMP_VERSION="${1:-latest}"
INSTALL_DIR="${INSTALL_DIR:-$HOME/.lavalamp/bin}"
REPO="rahuletto/lavalamp"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

info() { echo -e "${GREEN}[lavalamp]${NC} $1"; }
warn() { echo -e "${YELLOW}[lavalamp]${NC} $1"; }
error() { echo -e "${RED}[lavalamp]${NC} $1" >&2; exit 1; }

# Detect platform
detect_platform() {
  local os arch
  case "$(uname -s)" in
    Linux*)  os="linux" ;;
    Darwin*) os="darwin" ;;
    MINGW*|MSYS*|CYGWIN*) os="windows" ;;
    *) error "Unsupported OS: $(uname -s)" ;;
  esac

  case "$(uname -m)" in
    x86_64|amd64) arch="x64" ;;
    arm64|aarch64) arch="arm64" ;;
    *) error "Unsupported architecture: $(uname -m)" ;;
  esac

  # Handle Rosetta on macOS
  if [ "$os" = "darwin" ] && [ "$arch" = "x64" ]; then
    if sysctl -n sysctl.proc_translated 2>/dev/null | grep -q 1; then
      arch="arm64"
    fi
  fi

  echo "${os}-${arch}"
}

# Get latest version from GitHub
get_latest_version() {
  if command -v curl &>/dev/null; then
    curl -sL "https://api.github.com/repos/${REPO}/releases/latest" | grep '"tag_name"' | head -1 | cut -d'"' -f4
  elif command -v wget &>/dev/null; then
    wget -qO- "https://api.github.com/repos/${REPO}/releases/latest" | grep '"tag_name"' | head -1 | cut -d'"' -f4
  else
    error "curl or wget required"
  fi
}

# Check if directory is in PATH
in_path() {
  local dir="$1"
  case ":$PATH:" in
    *":$dir:"*) return 0 ;;
    *) return 1 ;;
  esac
}

# Add to PATH in shell config files
setup_path() {
  local dir="$1"

  if in_path "$dir"; then
    info "PATH already includes $dir"
    return
  fi

  info "Adding $dir to PATH..."

  # Detect shell and config file
  local shell_name
  shell_name="$(basename "${SHELL:-/bin/bash}")"

  local config_files=()
  case "$shell_name" in
    zsh)
      config_files+=("$HOME/.zshrc")
      ;;
    bash)
      if [ "$(uname)" = "Darwin" ]; then
        config_files+=("$HOME/.bash_profile")
      else
        config_files+=("$HOME/.bashrc")
      fi
      ;;
    fish)
      config_files+=("$HOME/.config/fish/config.fish")
      ;;
  esac

  for config in "${config_files[@]}"; do
    if [ -f "$config" ]; then
      if grep -q "lavalamp" "$config" 2>/dev/null; then
        info "PATH already configured in $config"
        return
      fi
    fi

    # Create config if it doesn't exist
    touch "$config"

    if [ "$shell_name" = "fish" ]; then
      echo "set -gx PATH $dir \$PATH" >> "$config"
    else
      echo "" >> "$config"
      echo "# lavalamp" >> "$config"
      echo "export PATH=\"\$HOME/.lavalamp/bin:\$PATH\"" >> "$config"
    fi

    info "Added PATH to $config"
  done

  # Also export for current session
  export PATH="$dir:$PATH"
}

# Download and install
install_lavalamp() {
  local platform version binary_url tmp_dir

  platform=$(detect_platform)
  info "Detected platform: ${platform}"

  if [ "$LAVALAMP_VERSION" = "latest" ]; then
    version=$(get_latest_version)
    if [ -z "$version" ]; then
      error "Failed to get latest version"
    fi
  else
    version="$LAVALAMP_VERSION"
  fi

  info "Installing lavalamp ${version}..."

  binary_url="https://github.com/${REPO}/releases/download/${version}/lavalamp-${platform}"
  tmp_dir=$(mktemp -d)
  trap "rm -rf $tmp_dir" EXIT

  info "Downloading from ${binary_url}..."

  if command -v curl &>/dev/null; then
    curl -sL "$binary_url" -o "${tmp_dir}/lavalamp"
  else
    wget -q "$binary_url" -O "${tmp_dir}/lavalamp"
  fi

  chmod +x "${tmp_dir}/lavalamp"

  # Create install directory
  mkdir -p "$INSTALL_DIR"

  mv "${tmp_dir}/lavalamp" "${INSTALL_DIR}/lavalamp"

  info "Installed lavalamp to ${INSTALL_DIR}/lavalamp"

  # Setup PATH
  setup_path "$INSTALL_DIR"

  info "Done! Run 'lavalamp' to start."
}

# Main
main() {
  echo ""
  echo "  lavalamp — Cloudflare-native AI coding harness"
  echo ""

  if ! command -v git &>/dev/null; then
    error "git is required but not installed"
  fi

  install_lavalamp
}

main "$@"
