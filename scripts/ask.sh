#!/bin/bash
# ask.sh -- Computer's voice input tool
# Usage: ask.sh [seconds]
# Waits for TTS to finish, chimes, records, transcribes, outputs text

DURATION="${1:-10}"
RAW="$TMPDIR/ask_rec_raw.wav"
WAV="$TMPDIR/ask_rec.wav"

# Wait for any audio playback to finish
# speak.sh runs: timeout 22 play /path/file.mp3 vol -9 dB
# pgrep -x play misses it (process name is timeout)
# pgrep -x timeout catches everything
# So: check if any timeout process has "play" in its command line
_wait_for_audio() {
    local tries=0
    while [ "$tries" -lt 100 ]; do
        if pgrep -af "timeout.*play" >/dev/null 2>&1; then
            sleep 0.3
            tries=$((tries + 1))
        else
            break
        fi
    done
}
_wait_for_audio
sleep 0.5

# Mute plugin while recording
echo $$ > "$TMPDIR/.ask_recording"

# Chime: mic on
play ~/chimes/listen_start.wav vol -9 dB 2>/dev/null
termux-toast -s green "Speak now (${DURATION}s)..."
sleep 1

# Record via termux-api
rm -f "$RAW"
termux-microphone-record -l "$DURATION" -f "$RAW" 2>/dev/null

# Wait for recording to finish
sleep "$((DURATION + 2))"

# Kill recording if still going
termux-microphone-record -q 2>/dev/null

# Check file
SIZE=$(stat -c%s "$RAW" 2>/dev/null || echo 0)

if [ "$SIZE" -lt 2000 ]; then
    play ~/chimes/listen_fail.wav vol -9 dB 2>/dev/null
    termux-toast -s red "Recording failed"
    rm -f "$TMPDIR/.ask_recording"
    echo "ASK_ERROR: recording too small"
    exit 1
fi

# Chime: stopped
play ~/chimes/listen_stop.wav vol -9 dB 2>/dev/null
termux-toast -s blue "Transcribing..."

# Convert MP4 to WAV (16kHz mono)
ffmpeg -y -i "$RAW" -ar 16000 -ac 1 "$WAV" 2>/dev/null
rm -f "$RAW"

if [ ! -f "$WAV" ]; then
    play ~/chimes/listen_fail.wav vol -9 dB 2>/dev/null
    termux-toast -s red "Conversion failed"
    rm -f "$TMPDIR/.ask_recording"
    echo "ASK_ERROR: ffmpeg failed"
    exit 1
fi

# Transcribe
TEXT=$(python -u -c "
import speech_recognition as sr
r = sr.Recognizer()
with sr.AudioFile('$WAV') as src:
    audio = r.record(src)
try:
    result = r.recognize_google(audio)
    print(result)
except sr.UnknownValueError:
    print('ASK_ERROR: no speech understood')
except Exception as e:
    print(f'ASK_ERROR: {type(e).__name__}: {e}')
" 2>&1)

if echo "$TEXT" | grep -q "ASK_ERROR"; then
    play ~/chimes/listen_fail.wav vol -9 dB 2>/dev/null
    termux-toast -s red "Could not understand"
    rm -f "$WAV" "$TMPDIR/.ask_recording"
    echo "$TEXT"
    exit 1
fi

rm -f "$WAV" "$TMPDIR/.ask_recording"

# Chime: done
play ~/chimes/listen_done.wav vol -9 dB 2>/dev/null
termux-toast -s green "Done"
echo "$TEXT"
