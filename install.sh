#!/usr/bin/env bash
set -euo pipefail

# Free Code Portable installer
# Usage: curl -fsSL https://raw.githubusercontent.com/YanzhangJiang/free-code-portable/main/install.sh | bash

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
DIM='\033[2m'
RESET='\033[0m'

REPO="https://github.com/YanzhangJiang/free-code-portable.git"
INSTALL_DIR="$HOME/free-code-portable"
BUN_MIN_VERSION="1.3.11"

info()  { printf "${CYAN}[*]${RESET} %s\n" "$*"; }
ok()    { printf "${GREEN}[+]${RESET} %s\n" "$*"; }
warn()  { printf "${YELLOW}[!]${RESET} %s\n" "$*"; }
fail()  { printf "${RED}[x]${RESET} %s\n" "$*"; exit 1; }

header() {
  echo ""
  printf "${BOLD}${CYAN}  Free Code Portable${RESET}\n"
  printf "${DIM}  A multi-provider coding agent, forked from free-code${RESET}\n"
  echo ""
}

usage() {
  cat <<EOF
Usage: bash install.sh [--help]

Build and install Free Code Portable on macOS or Linux.
Requires git; installs or upgrades Bun if needed.

Source: $REPO
Checkout: $INSTALL_DIR
Command: $HOME/.local/bin/free-code-portable
Build: bun run build (standard feature set)

The existing free-code installation is not replaced.
EOF
}

# -------------------------------------------------------------------
# System checks
# -------------------------------------------------------------------

check_os() {
  case "$(uname -s)" in
    Darwin) OS="macos" ;;
    Linux)  OS="linux" ;;
    *)      fail "Unsupported OS: $(uname -s). macOS or Linux required." ;;
  esac
  ok "OS: $(uname -s) $(uname -m)"
}

check_git() {
  if ! command -v git &>/dev/null; then
    fail "git is not installed. Install it first:
    macOS:  xcode-select --install
    Linux:  sudo apt install git  (or your distro's equivalent)"
  fi
  ok "git: $(git --version | head -1)"
}

# Compare semver: returns 0 if $1 >= $2
version_gte() {
  [ "$(printf '%s\n' "$1" "$2" | sort -V | head -1)" = "$2" ]
}

check_bun() {
  if command -v bun &>/dev/null; then
    local ver
    ver="$(bun --version 2>/dev/null || echo "0.0.0")"
    if version_gte "$ver" "$BUN_MIN_VERSION"; then
      ok "bun: v${ver}"
      return
    fi
    warn "bun v${ver} found but v${BUN_MIN_VERSION}+ required. Upgrading..."
  else
    info "bun not found. Installing..."
  fi
  install_bun
}

install_bun() {
  curl -fsSL https://bun.sh/install | bash
  # Source the updated profile so bun is on PATH for this session
  export BUN_INSTALL="${BUN_INSTALL:-$HOME/.bun}"
  export PATH="$BUN_INSTALL/bin:$PATH"
  if ! command -v bun &>/dev/null; then
    fail "bun installation succeeded but binary not found on PATH.
    Add this to your shell profile and restart:
      export PATH=\"\$HOME/.bun/bin:\$PATH\""
  fi
  ok "bun: v$(bun --version) (just installed)"
}

# -------------------------------------------------------------------
# Clone & build
# -------------------------------------------------------------------

clone_repo() {
  if [ -e "$INSTALL_DIR" ] || [ -L "$INSTALL_DIR" ]; then
    warn "$INSTALL_DIR already exists"
    [ -d "$INSTALL_DIR/.git" ] || [ -f "$INSTALL_DIR/.git" ] ||
      fail "Existing install directory is not a Git checkout: $INSTALL_DIR"
    local origin
    origin="$(git -C "$INSTALL_DIR" remote get-url origin 2>/dev/null)" ||
      fail "Existing checkout has no origin remote: $INSTALL_DIR"
    case "$origin" in
      "$REPO"|"${REPO%.git}"|git@github.com:YanzhangJiang/free-code-portable.git|ssh://git@github.com/YanzhangJiang/free-code-portable.git) ;;
      *) fail "Existing checkout origin is '$origin', expected '$REPO'. Refusing to update a different repository." ;;
    esac
    [ "$(git -C "$INSTALL_DIR" branch --show-current)" = "main" ] ||
      fail "Existing checkout is not on main. Switch branches yourself before running the installer."
    info "Pulling latest changes..."
    git -C "$INSTALL_DIR" pull --ff-only origin main ||
      fail "Update failed. Resolve the existing checkout before running the installer again."
  else
    info "Cloning repository..."
    git clone --depth 1 "$REPO" "$INSTALL_DIR"
  fi
  ok "Source: $INSTALL_DIR"
}

install_deps() {
  info "Installing dependencies..."
  cd "$INSTALL_DIR"
  bun install --frozen-lockfile
  ok "Dependencies installed"
}

build_binary() {
  info "Building Free Code Portable (standard feature set)..."
  cd "$INSTALL_DIR"
  bun run build
  ok "Binary built: $INSTALL_DIR/cli"
}

link_binary() {
  local link_dir="$HOME/.local/bin"
  mkdir -p "$link_dir"

  local link_path="$link_dir/free-code-portable"
  if [ -e "$link_path" ] || [ -L "$link_path" ]; then
    [ -L "$link_path" ] && [ "$(readlink "$link_path")" = "$INSTALL_DIR/cli" ] ||
      fail "Refusing to replace an existing command at $link_path. Move it yourself before installing."
  fi
  ln -sf "$INSTALL_DIR/cli" "$link_path"
  ok "Symlinked: $link_path"

  if ! echo "$PATH" | tr ':' '\n' | grep -qx "$link_dir"; then
    warn "$link_dir is not on your PATH"
    echo ""
    printf "${YELLOW}  Add this to your shell profile (~/.bashrc, ~/.zshrc, etc.):${RESET}\n"
    printf "${BOLD}    export PATH=\"\$HOME/.local/bin:\$PATH\"${RESET}\n"
    echo ""
  fi
}

# -------------------------------------------------------------------
# Main
# -------------------------------------------------------------------

main() {
  [ "$#" -le 1 ] || fail "Unexpected arguments: $*"
  case "${1:-}" in
    --help|-h) usage; return 0 ;;
    "") ;;
    *) usage >&2; fail "Unknown argument: $1" ;;
  esac

  header
  info "Starting installation..."
  echo ""

  check_os
  check_git
  check_bun
  echo ""

  clone_repo
  install_deps
  build_binary
  link_binary

  echo ""
  printf "${GREEN}${BOLD}  Installation complete!${RESET}\n"
  echo ""
  printf "  ${BOLD}Run it:${RESET}\n"
  printf "    ${CYAN}free-code-portable${RESET}                       # interactive REPL\n"
  printf "    ${CYAN}free-code-portable -p \"your prompt\"${RESET}     # one-shot mode\n"
  echo ""
  printf "  ${BOLD}Configure your providers and services:${RESET}\n"
  printf "    %s\n" "$INSTALL_DIR/PROVIDERS.md" "$INSTALL_DIR/EXTERNAL_SERVICES.md"
  printf "    ${CYAN}free-code-portable --providers-file /path/to/providers.json --provider <profile>${RESET}\n"
  echo ""
  printf "  ${BOLD}For an Anthropic API key:${RESET}\n"
  printf "    ${CYAN}export ANTHROPIC_API_KEY=\"sk-ant-...\"${RESET}\n"
  echo ""
  printf "  ${DIM}Source: $INSTALL_DIR${RESET}\n"
  printf "  ${DIM}Binary: $INSTALL_DIR/cli${RESET}\n"
  printf "  ${DIM}Link:   ~/.local/bin/free-code-portable${RESET}\n"
  echo ""
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  main "$@"
fi
