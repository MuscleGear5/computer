#!/bin/bash
# ============================================================================
# Hermes Agent - Termux Install Script (Forked Repo)
# ============================================================================
# Installs Hermes Agent on a fresh Termux environment using the
# MuscleGear5/computer fork. Handles all Termux packages, Python venv,
# psutil Android shim, and hermes command setup.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/MuscleGear5/computer/main/scripts/install-termux.sh | bash
#
# Or:
#   bash scripts/install-termux.sh
# ============================================================================

set -e

# Guard against inherited Python env leaking into pip
if [ -n "${PYTHONPATH:-}" ]; then
    echo "[*] Clearing inherited PYTHONPATH"
    unset PYTHONPATH
fi
if [ -n "${PYTHONHOME:-}" ]; then
    echo "[*] Clearing inherited PYTHONHOME"
    unset PYTHONHOME
fi

export UV_NO_CONFIG=1

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
BLUE='\033[0;34m'
NC='\033[0m'
BOLD='\033[1m'

log_info()  { echo -e "${BLUE}${BOLD}[*]${NC} $*"; }
log_ok()    { echo -e "${GREEN}${BOLD}[+]${NC} $*"; }
log_warn()  { echo -e "${YELLOW}[!]${NC} $*"; }
log_err()   { echo -e "${RED}${BOLD}[-]${NC} $*"; }

# Config
REPO_URL="https://github.com/MuscleGear5/computer.git"
REPO_BRANCH="main"
HERMES_HOME="${HERMES_HOME:-$HOME/.hermes}"
INSTALL_DIR="$HERMES_HOME/hermes-agent"
HERMES_REPO_DIR="$HERMES_HOME/computer"  # full repo checkout
HERMES_SUBDIR="hermes-agent"             # subdir inside the repo

# --- Banner ---
print_banner() {
    echo
    echo -e "${BLUE}${BOLD}  Hermes Agent${NC} -- ${BOLD}Termux Installer (Forked)${NC}"
    echo -e "${BLUE}${BOLD}  Repo: ${NC}$REPO_URL"
    echo
}

# --- Validate Termux ---
if [ -z "${TERMUX_VERSION:-}" ] && [[ "${PREFIX:-}" != *"com.termux/files/usr"* ]]; then
    log_err "This script is for Termux only."
    log_info "For Linux/macOS use: curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash"
    exit 1
fi

log_ok "Termux detected"

# --- Install system packages ---
log_info "Installing Termux packages..."
TERMUX_PKGS=(git python clang rust make pkg-config libffi openssl ca-certificates curl ripgrep ffmpeg sox)

for pkg in "${TERMUX_PKGS[@]}"; do
    if ! command -v "$pkg" &>/dev/null; then
        log_info "  Downloading $pkg..."
        if pkg install -y "$pkg" >/dev/null 2>&1; then
            log_ok "  $pkg installed"
        else
            log_warn "  Failed to install $pkg (may already be present or repo issue)"
        fi
    else
        log_ok "  $pkg already present"
    fi
done

log_ok "Termux packages ready"

# --- Install edge-tts ---
log_info "Installing edge-tts..."
if ! command -v edge-tts &>/dev/null; then
    if pip install edge-tts 2>&1; then
        log_ok "edge-tts installed"
    else
        log_error "edge-tts install FAILED -- TTS will not work"
        log_error "Try manually: pip install edge-tts"
    fi
else
    log_ok "edge-tts already present"
fi

# --- Network check ---
log_info "Checking network..."
if curl -fsSL --max-time 10 https://pypi.org/simple/ >/dev/null 2>&1; then
    log_ok "PyPI reachable"
else
    log_warn "PyPI unreachable. Try: termux-change-repo && pkg update"
fi

# --- Clone/Update repo ---
clone_repo() {
    log_info "Cloning repo to $HERMES_REPO_DIR..."

    # Handle broken/incomplete clones
    if [ -d "$HERMES_REPO_DIR/.git" ] && ! git -C "$HERMES_REPO_DIR" rev-parse --verify HEAD >/dev/null 2>&1; then
        backup="${HERMES_REPO_DIR}.broken-$(date -u +%Y%m%d-%H%M%S)"
        log_warn "Broken clone detected, moving to $backup"
        mv "$HERMES_REPO_DIR" "$backup"
    fi

    if [ -d "$HERMES_REPO_DIR/.git" ]; then
        log_info "Existing checkout found, updating..."
        cd "$HERMES_REPO_DIR"
        git remote set-branches origin "$REPO_BRANCH" 2>/dev/null || true
        git fetch origin "$REPO_BRANCH"
        git checkout "$REPO_BRANCH"
        git pull --ff-only origin "$REPO_BRANCH"
    else
        log_info "Cloning $REPO_URL (branch: $REPO_BRANCH)..."
        rm -rf "$HERMES_REPO_DIR" 2>/dev/null
        if git clone --depth 1 --branch "$REPO_BRANCH" "$REPO_URL" "$HERMES_REPO_DIR"; then
            log_ok "Cloned successfully"
        else
            log_err "Clone failed. Check your internet connection."
            exit 1
        fi
    fi

    cd "$HERMES_REPO_DIR"
    log_ok "Repository ready at $HERMES_REPO_DIR"
}

# --- Link or copy hermes-agent subdir to INSTALL_DIR ---
setup_hermes_dir() {
    local src="$HERMES_REPO_DIR/$HERMES_SUBDIR"

    if [ ! -d "$src" ]; then
        log_err "hermes-agent subdirectory not found at $src"
        log_err "Make sure your repo has a 'hermes-agent/' folder at the root."
        exit 1
    fi

    log_info "Setting up hermes-agent at $INSTALL_DIR..."

    if [ -L "$INSTALL_DIR" ]; then
        # Already a symlink -- update it
        rm -f "$INSTALL_DIR"
        ln -s "$src" "$INSTALL_DIR"
        log_ok "Symlink updated"
    elif [ -d "$INSTALL_DIR" ]; then
        if [ -d "$INSTALL_DIR/.git" ]; then
            # Existing standalone install -- offer to replace
            log_warn "Existing hermes-agent install found at $INSTALL_DIR"
            log_info "Replacing with symlink to fork..."
            rm -rf "$INSTALL_DIR"
            ln -s "$src" "$INSTALL_DIR"
            log_ok "Replaced with symlink"
        else
            log_err "Directory exists but is not a git repo: $INSTALL_DIR"
            log_info "Remove it and re-run this script."
            exit 1
        fi
    else
        ln -s "$src" "$INSTALL_DIR"
        log_ok "Symlink created: $INSTALL_DIR -> $src"
    fi

    cd "$INSTALL_DIR"
}

# --- Setup Python venv ---
setup_venv() {
    log_info "Creating Python virtual environment..."

    PYTHON_PATH="$(command -v python)"
    if [ -z "$PYTHON_PATH" ]; then
        log_err "Python not found. Run: pkg install python"
        exit 1
    fi

    PYTHON_VER=$("$PYTHON_PATH" --version 2>/dev/null)
    log_ok "Using $PYTHON_VER"

    if [ -d "$INSTALL_DIR/venv" ]; then
        log_info "Existing venv found, recreating..."
        rm -rf "$INSTALL_DIR/venv"
    fi

    "$PYTHON_PATH" -m venv "$INSTALL_DIR/venv"
    log_ok "Virtual environment ready ($("$INSTALL_DIR/venv/bin/python" --version 2>/dev/null))"
}

# --- Install Python dependencies ---
install_deps() {
    log_info "Installing Python dependencies (this may take a few minutes)..."

    cd "$INSTALL_DIR"
    export VIRTUAL_ENV="$INSTALL_DIR/venv"
    export ANDROID_API_LEVEL="${ANDROID_API_LEVEL:-$(getprop ro.build.version.sdk 2>/dev/null || echo 24)}"
    PIP_PYTHON="$INSTALL_DIR/venv/bin/python"

    # Upgrade pip
    "$PIP_PYTHON" -m pip install --upgrade pip setuptools wheel >/dev/null 2>&1

    # psutil Android shim
    if "$PIP_PYTHON" -c 'import sys; raise SystemExit(0 if sys.platform == "android" else 1)' 2>/dev/null; then
        log_info "Android detected: prebuilding psutil compatibility shim..."
        if "$PIP_PYTHON" "$INSTALL_DIR/scripts/install_psutil_android.py" --pip "$PIP_PYTHON -m pip" 2>/dev/null; then
            log_ok "psutil shim built"
        else
            log_warn "psutil Android prebuild failed -- pip install may fail"
            log_info "Workaround: python scripts/install_psutil_android.py --pip 'python -m pip'"
        fi
    fi

    # Try termux-all, fall back to termux, then base
    if "$PIP_PYTHON" -m pip install -e '.[termux-all]' -c constraints-termux.txt 2>&1 | tail -1; then
        log_ok "Installed with termux-all profile"
    elif "$PIP_PYTHON" -m pip install -e '.[termux]' -c constraints-termux.txt 2>&1 | tail -1; then
        log_ok "Installed with termux profile"
    elif "$PIP_PYTHON" -m pip install -e '.' -c constraints-termux.txt 2>&1 | tail -1; then
        log_ok "Installed base package"
    else
        log_err "Package installation failed!"
        log_info "Make sure build tools are installed:"
        log_info "  pkg install clang rust make pkg-config libffi openssl"
        exit 1
    fi

    log_ok "All dependencies installed"
}

# --- Setup hermes command ---
setup_path() {
    log_info "Setting up hermes command..."

    HERMES_BIN="$INSTALL_DIR/venv/bin/hermes"
    if [ ! -x "$HERMES_BIN" ]; then
        log_err "hermes entry point not found at $HERMES_BIN"
        log_info "pip install may not have completed. Try running install_deps manually."
        exit 1
    fi

    # Create launcher shim in $PREFIX/bin
    mkdir -p "$PREFIX/bin"
    rm -f "$PREFIX/bin/hermes"
    cat > "$PREFIX/bin/hermes" <<EOF
#!/usr/bin/env bash
unset PYTHONPATH
unset PYTHONHOME
exec "$HERMES_BIN" "\$@"
EOF
    chmod +x "$PREFIX/bin/hermes"

    export PATH="$PREFIX/bin:$PATH"
    log_ok "hermes command installed to $PREFIX/bin/hermes"
}

# --- Copy config templates ---
copy_config_templates() {
    log_info "Setting up config..."
    if [ ! -f "$HERMES_HOME/config.yaml" ]; then
        if [ -f "$INSTALL_DIR/cli-config.yaml.example" ]; then
            cp "$INSTALL_DIR/cli-config.yaml.example" "$HERMES_HOME/config.yaml"
            log_ok "Default config written to $HERMES_HOME/config.yaml"
        else
            log_warn "No config template found, skipping"
        fi
    else
        log_ok "Config already exists at $HERMES_HOME/config.yaml"
    fi
}

# --- Wire tts-speak plugin ---
wire_tts_plugin() {
    log_info "Wiring tts-speak plugin..."
    local repo_tts="$HERMES_REPO_DIR/tts-speak"
    local plugin_dir="$HERMES_HOME/plugins/tts-speak"

    if [ ! -d "$repo_tts/__init__.py" ] || [ ! -f "$repo_tts/__init__.py" ]; then
        log_warn "tts-speak plugin not found in repo, skipping"
        return
    fi

    # Remove old loose files (non-symlink)
    if [ -d "$plugin_dir" ]; then
        # Remove old real files, keep symlinks intact
        find "$plugin_dir" -maxdepth 2 ! -type l -delete 2>/dev/null || true
        # Remove empty dirs
        rmdir "$plugin_dir/scripts" 2>/dev/null || true
    else
        mkdir -p "$plugin_dir"
    fi

    # Create symlinks: __init__.py, plugin.yaml, scripts/
    ln -sfn "$repo_tts/__init__.py" "$plugin_dir/__init__.py"
    ln -sfn "$repo_tts/plugin.yaml" "$plugin_dir/plugin.yaml"
    ln -sfn "$repo_tts/scripts" "$plugin_dir/scripts"

    # Install edge-tts for TTS
    if ! command -v edge-tts &>/dev/null; then
        log_info "Installing edge-tts..."
        pip install edge-tts 2>&1 | tail -1 || log_warn "edge-tts install failed"
    fi

    # Install MiniMax TTS CLI (speak) to ~/.local/bin
    local speak_repo="$repo_tts/../scripts/speak"
    if [ -f "$speak_repo" ]; then
        mkdir -p "$HOME/.local/bin"
        ln -sfn "$speak_repo" "$HOME/.local/bin/speak"
        chmod +x "$speak_repo"
        log_ok "MiniMax speak CLI linked to ~/.local/bin/speak"
    fi

    # Generate chimes directory
    mkdir -p "$HOME/chimes"
    log_ok "tts-speak plugin wired (symlinked from repo)"
}

# --- Print success ---
print_success() {
    echo
    echo -e "${GREEN}${BOLD}  Installation complete!${NC}"
    echo
    echo -e "  ${BOLD}Source your shell to get the hermes command:${NC}"
    echo -e "    ${BLUE}source ~/.bashrc${NC}"
    echo
    echo -e "  ${BOLD}Then start Hermes:${NC}"
    echo -e "    ${BLUE}hermes${NC}"
    echo
    echo -e "  ${BOLD}Or run setup wizard:${NC}"
    echo -e "    ${BLUE}hermes setup${NC}"
    echo

    # Write install method marker
    echo "git-fork" > "$HERMES_HOME/.install_method"
}

# ============================================================================
# Main
# ============================================================================
main() {
    print_banner
    clone_repo
    setup_hermes_dir
    setup_venv
    install_deps
    setup_path
    copy_config_templates
    wire_tts_plugin
    print_success
}

main
