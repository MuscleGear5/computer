#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────
# Voice System Setup Script
# Checks and installs dependencies for the pi voice-system extension
# Works on Termux/Android and Linux desktop
# ──────────────────────────────────────────────────────────────

set -euo pipefail

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

info()  { echo -e "${BLUE}  [INFO]${NC} $1"; }
ok()    { echo -e "${GREEN}  [OK]${NC} $1"; }
warn()  { echo -e "${YELLOW}  [WARN]${NC} $1"; }
fail()  { echo -e "${RED}  [FAIL]${NC} $1"; }

# ── Platform Detection ──

if [ -n "${TERMUX_VERSION:-}" ] || echo "$PREFIX" | grep -q com.termux; then
    PLATFORM="termux"
    PKG_CMD="pkg"
    info "Detected platform: Termux/Android"
else
    PLATFORM="linux"
    if command -v apt-get &>/dev/null; then
        PKG_CMD="sudo apt-get"
    elif command -v dnf &>/dev/null; then
        PKG_CMD="sudo dnf"
    elif command -v pacman &>/dev/null; then
        PKG_CMD="sudo pacman"
    elif command -v apk &>/dev/null; then
        PKG_CMD="sudo apk"
    else
        PKG_CMD=""
    fi
    info "Detected platform: Linux (package manager: ${PKG_CMD:-none})"
fi

EXT_DIR="$HOME/.pi/agent/extensions/voice-system"

echo ""
echo "╔══════════════════════════════════════════════╗"
echo "║     Computer Voice System - Setup           ║"
echo "║     Platform: $PLATFORM                         ║"
echo "╚══════════════════════════════════════════════╝"
echo ""

ERRORS=0

# ── Function: check command ──

check_cmd() {
    local name="$1"
    local required="${2:-true}"
    if command -v "$name" &>/dev/null; then
        ok "$name: $(command -v "$name")"
        return 0
    else
        if [ "$required" = "true" ]; then
            fail "$name: NOT FOUND (required)"
            ERRORS=$((ERRORS + 1))
        else
            warn "$name: NOT FOUND (optional)"
        fi
        return 1
    fi
}

# ── Function: install package ──

install_pkg() {
    local pkg="$1"
    info "Installing $pkg..."
    case "$PKG_CMD" in
        "pkg")          pkg install -y "$pkg" 2>/dev/null ;;
        "sudo apt-get") sudo apt-get install -y "$pkg" 2>/dev/null ;;
        "sudo dnf")     sudo dnf install -y "$pkg" 2>/dev/null ;;
        "sudo pacman")  sudo pacman -S --noconfirm "$pkg" 2>/dev/null ;;
        "sudo apk")     sudo apk add "$pkg" 2>/dev/null ;;
        *)              warn "No package manager detected. Install $pkg manually." ;;
    esac
}

echo "── Checking core dependencies ──"
echo ""

# ── Sox (play/rec) ──

if ! check_cmd "sox"; then
    info "Installing sox..."
    case "$PLATFORM" in
        termux) pkg install -y sox pulseaudio 2>/dev/null || true ;;
        *) install_pkg "sox" ;;
    esac
    check_cmd "sox"
fi

if ! check_cmd "play" false; then
    warn "play command not found (usually comes with sox)"
fi

if ! check_cmd "rec" false; then
    warn "rec command not found (usually comes with sox)"
fi

# ── espeak-ng ──

if ! check_cmd "espeak-ng"; then
    info "Installing espeak-ng..."
    case "$PLATFORM" in
        termux) pkg install -y espeak-ng 2>/dev/null || true ;;
        *) install_pkg "espeak-ng" ;;
    esac
    check_cmd "espeak-ng"
fi

# ── Python3 + webrtcvad ──

if ! check_cmd "python3"; then
    info "Installing python3..."
    case "$PLATFORM" in
        termux) pkg install -y python 2>/dev/null || true ;;
        *) install_pkg "python3" ;;
    esac
    check_cmd "python3"
fi

# Check webrtcvad
if python3 -c "import webrtcvad" 2>/dev/null; then
    ok "webrtcvad (python module)"
else
    fail "webrtcvad (python module): NOT FOUND"
    info "Installing webrtcvad..."
    pip3 install webrtcvad 2>/dev/null || pip install webrtcvad 2>/dev/null || \
        warn "Could not install webrtcvad. Run: pip3 install webrtcvad"
    if python3 -c "import webrtcvad" 2>/dev/null; then
        ok "webrtcvad installed successfully"
    else
        ERRORS=$((ERRORS + 1))
    fi
fi

# ── Whisper ──

WHISPER_BIN=""
WHISPER_SEARCH=(
    "$HOME/tmp/whisper.cpp/build/bin/whisper-cli"
    "$HOME/.local/bin/whisper-cli"
    "/usr/local/bin/whisper-cli"
)

for p in "${WHISPER_SEARCH[@]}"; do
    if [ -x "$p" ]; then
        WHISPER_BIN="$p"
        break
    fi
done

if [ -n "$WHISPER_BIN" ]; then
    ok "whisper-cli: $WHISPER_BIN"
else
    warn "whisper-cli: NOT FOUND (required for STT)"
    info "To build whisper.cpp:"
    info "  git clone https://github.com/ggerganov/whisper.cpp.git ~/tmp/whisper.cpp"
    info "  cd ~/tmp/whisper.cpp && make"
    info "  ./models/download-ggml-model.sh base.en"
    info "  ./models/download-ggml-model.sh tiny.en"
    ERRORS=$((ERRORS + 1))
fi

# Check whisper models
for model in "ggml-base.en.bin" "ggml-tiny.en.bin"; do
    model_path="$HOME/tmp/whisper.cpp/models/$model"
    if [ -f "$model_path" ]; then
        ok "Whisper model: $model"
    else
        warn "Whisper model: $model NOT FOUND"
    fi
done

# ── Sound Files ──

echo ""
echo "── Checking sound files ──"
echo ""

SOUNDS_DIR="$EXT_DIR/sounds"
ATOMS_DIR="$HOME/.pi/sounds/atoms"
SOUND_NAMES="ready done thinking listen success error"

for snd in $SOUND_NAMES; do
    if [ -f "$SOUNDS_DIR/${snd}.wav" ]; then
        ok "sound/${snd}.wav (bundled)"
    elif [ -f "$ATOMS_DIR/${snd}.wav" ]; then
        ok "sound/${snd}.wav (atoms fallback)"
    else
        warn "sound/${snd}.wav: NOT FOUND"
    fi
done

# ── Copy sound files to bundled dir ──

echo ""
echo "── Bundling sounds ──"
echo ""

mkdir -p "$SOUNDS_DIR"
for snd in $SOUND_NAMES; do
    if [ -f "$ATOMS_DIR/${snd}.wav" ] && [ ! -f "$SOUNDS_DIR/${snd}.wav" ]; then
        cp "$ATOMS_DIR/${snd}.wav" "$SOUNDS_DIR/${snd}.wav"
        info "Copied ${snd}.wav to extension"
    fi
done

# ── Test audio playback ──

echo ""
echo "── Testing audio ──"
echo ""

if command -v play &>/dev/null && [ -f "$SOUNDS_DIR/ready.wav" ]; then
    info "Playing test sound (ready.wav)..."
    if play -q -v 0.3 "$SOUNDS_DIR/ready.wav" 2>/dev/null; then
        ok "Audio playback works"
    else
        warn "Audio playback may not be working"
    fi
else
    warn "Skipping audio test (play or sound file missing)"
fi

# ── Test TTS ──

if command -v espeak-ng &>/dev/null; then
    info "Testing TTS..."
    if espeak-ng -s 150 -p 30 -a 50 -v en-gb-x-rp "Voice test" 2>/dev/null; then
        ok "TTS works"
    else
        warn "TTS may not be working"
    fi
fi

# ── Test recording ──

if command -v rec &>/dev/null; then
    info "Testing recording (2 second test)..."
    if timeout 2 rec -r 16000 -c 1 -t raw - 2>/dev/null | head -c 1 | grep -q .; then
        ok "Audio recording works"
    else
        warn "Audio recording test inconclusive (may need microphone permission)"
    fi
fi

# ── Summary ──

echo ""
echo "══════════════════════════════════════════════"
if [ "$ERRORS" -eq 0 ]; then
    echo -e "  ${GREEN}Setup complete! All dependencies satisfied.${NC}"
else
    echo -e "  ${YELLOW}Setup complete with $ERRORS issue(s).${NC}"
    echo -e "  ${YELLOW}See warnings above for missing components.${NC}"
fi
echo ""
echo "  Config file: $EXT_DIR/config.json"
echo "  Extension:   $EXT_DIR/index.ts"
echo ""
echo "  Commands:"
echo "    /voice-check   - Verify dependencies"
echo "    /voice-config  - View configuration"
echo "    /voice-profile - Switch voice (computer-en, computer-fr)"
echo "    /wake-start    - Start wake word daemon"
echo "    /wake-stop     - Stop wake word daemon"
echo "    /wake-status   - Check wake word status"
echo "══════════════════════════════════════════════"
echo ""
