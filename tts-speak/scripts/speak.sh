#!/bin/bash
# Speaks text via edge-tts (Guy voice) and plays it with the play command.
# - Uses flock to queue multiple speak calls so they don't fight each other.
# - Uses timeout to kill play() if it hangs (audio should never take > 60s).

# --- Dependency check & auto-install ---
install_if_missing() {
    local cmd="$1" check="$2" install_cmd="$3"
    if ! command -v "$check" &>/dev/null; then
        echo "[speak] Downloading $cmd..."
        eval "$install_cmd" &>/dev/null
        if command -v "$check" &>/dev/null; then
            echo "[speak] $cmd installed."
        else
            echo "[speak] Failed to install $cmd. Aborting."
            exit 1
        fi
    fi
}

install_if_missing "edge-tts" "edge-tts" "pip install edge-tts"
install_if_missing "ffmpeg"  "ffprobe"  "pkg install -y ffmpeg"
install_if_missing "sox"     "play"     "pkg install -y sox"

TEXT="$1"

if [ -n "$TEXT" ]; then
    TMP_MP3="$HOME/tts_speak_$$.mp3"
    # Generate TTS to a unique file first (no race with other instances)
    timeout 30 edge-tts --voice en-US-GuyNeural --rate +25% --text "$TEXT" --write-media "$TMP_MP3" 2>/dev/null
    if [ -f "$TMP_MP3" ]; then
        # Get audio duration in seconds (rounded up + 2s buffer)
        DUR=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$TMP_MP3" 2>/dev/null)
        DUR=${DUR%.*}
        [ -z "$DUR" ] && DUR=5
        TIMEOUT_S=$((DUR + 3))
        [ "$TIMEOUT_S" -lt 5 ] && TIMEOUT_S=5
        [ "$TIMEOUT_S" -gt 60 ] && TIMEOUT_S=60
        # Queue playback through a lock so instances play one at a time
        LOCKFILE="$HOME/.tts_speak.lock"
        (
            flock -x 200
            pkill -f "speak_inline_" 2>/dev/null
            timeout "$TIMEOUT_S" play "$TMP_MP3" 2>/dev/null
        ) 200>"$LOCKFILE"
        rm -f "$TMP_MP3"
    fi
fi
