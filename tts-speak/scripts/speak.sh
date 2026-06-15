#!/bin/bash
# Speaks text via MiniMax TTS. Reads voice/lang from ~/.hermes/tts_voice.conf
# - Uses flock to queue multiple speak calls so they don't fight each other.

# --- Dependency check & auto-install ---
install_if_missing() {
    local cmd="$1" check="$2" install_cmd="$3"
    if ! command -v "$check" &>/dev/null; then
        echo "[speak] Downloading $cmd..."
        eval "$install_cmd" 2>&1 | head -5
        if command -v "$check" &>/dev/null; then
            echo "[speak] $cmd installed."
        else
            echo "[speak] Failed to install $cmd. Aborting."
            exit 1
        fi
    fi
}

install_if_missing "ffmpeg" "ffprobe" "pkg install -y ffmpeg"
install_if_missing "sox"    "play"    "pkg install -y sox"

TEXT="$1"

if [ -n "$TEXT" ]; then
    TMP_MP3="$TMPDIR/tts_speak_$$.mp3"
    trap 'rm -f "$TMP_MP3"' EXIT

    # Load voice config (line 1 = voice_id, line 2 = language_boost)
    CONF="$HOME/.hermes/tts_voice.conf"
    VOICE_ID="English_expressive_narrator"
    LANG_BOOST="auto"
    if [ -f "$CONF" ]; then
        VOICE_ID=$(sed -n '1p' "$CONF" 2>/dev/null)
        LANG_BOOST=$(sed -n '2p' "$CONF" 2>/dev/null)
    fi

    # Load API key
    API_KEY=""
    if [ -f "$HOME/.hermes/.env" ]; then
        API_KEY=$(grep '^MINIMAX_API_KEY=' "$HOME/.hermes/.env" | cut -d= -f2-)
    fi

    if [ -z "$API_KEY" ]; then
        # Fallback to edge-tts
        if command -v edge-tts &>/dev/null; then
            timeout 30 edge-tts --voice en-US-GuyNeural --rate +25% --text "$TEXT" --write-media "$TMP_MP3" 2>/dev/null
        else
            exit 1
        fi
    else
        # MiniMax TTS
        python3 - "$TEXT" "$API_KEY" "$TMP_MP3" "$VOICE_ID" "$LANG_BOOST" <<'PYEOF'
import json, sys, urllib.request
text, key, dest, voice, lang = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4], sys.argv[5]
payload = json.dumps({
    "model": "speech-2.8-hd",
    "text": text,
    "stream": False,
    "language_boost": lang,
    "output_format": "hex",
    "voice_setting": {
        "voice_id": voice,
        "speed": 1.4,
        "vol": 1,
        "pitch": 0
    },
    "audio_setting": {
        "sample_rate": 32000,
        "bitrate": 128000,
        "format": "mp3",
        "channel": 1
    }
}).encode()
req = urllib.request.Request(
    "https://api.minimax.io/v1/t2a_v2",
    data=payload,
    headers={"Authorization": "Bearer " + key, "Content-Type": "application/json"}
)
try:
    with urllib.request.urlopen(req, timeout=30) as resp:
        result = json.loads(resp.read().decode())
except Exception as e:
    sys.exit(1)
audio_hex = result.get("data", {}).get("audio", "")
if not audio_hex:
    sys.exit(1)
with open(dest, "wb") as f:
    f.write(bytes.fromhex(audio_hex))
PYEOF
    fi

    if [ -f "$TMP_MP3" ]; then
        DUR=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$TMP_MP3" 2>/dev/null)
        DUR=${DUR%.*}
        [ -z "$DUR" ] && DUR=5
        TIMEOUT_S=$((DUR + 3))
        [ "$TIMEOUT_S" -lt 5 ] && TIMEOUT_S=5
        [ "$TIMEOUT_S" -gt 60 ] && TIMEOUT_S=60
        LOCKFILE="$HOME/.tts_speak.lock"
        (
            flock -x 200
            pkill -f "play.*\.mp3" 2>/dev/null
            sleep 0.1
            timeout "$TIMEOUT_S" play "$TMP_MP3" 2>/dev/null
        ) 200>"$LOCKFILE"
        rm -f "$TMP_MP3"
    fi
fi
