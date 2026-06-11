#!/bin/bash
# listen.sh -- open mic, record fixed duration, transcribe with Google STT
# Usage: listen.sh [seconds]

DURATION="${1:-5}"
WAV="$TMPDIR/listen_rec.wav"

# Kill all TTS/playback first so mic only hears YOU
pkill -f "play.*\.mp3" 2>/dev/null
pkill -f "edge-tts" 2>/dev/null
sleep 1

# Speak prompt
edge-tts --voice en-US-GuyNeural --rate +25% --text "Listening. Speak now." --write-media "$TMPDIR/listen_prompt.mp3" 2>/dev/null
play "$TMPDIR/listen_prompt.mp3" 2>/dev/null
rm -f "$TMPDIR/listen_prompt.mp3"
sleep 1

# Chime: mic on
play ~/chimes/listen_start.wav vol -9 dB 2>/dev/null
termux-toast -s green "Listening for ${DURATION}s..."
sleep 1

# Record to wav file
rec -r 16000 -c 1 "$WAV" trim 0 "$DURATION" 2>/dev/null
REC_EXIT=$?
echo "rec exit code: $REC_EXIT"

# Check file
SIZE=$(stat -c%s "$WAV" 2>/dev/null || echo 0)
echo "wav size: $SIZE bytes"

if [ "$SIZE" -lt 2000 ]; then
    play ~/chimes/listen_fail.wav vol -9 dB 2>/dev/null
    termux-toast -s red "Recording failed"
    echo "LISTEN_ERROR: recording too small (${SIZE} bytes)"
    exit 1
fi

# Chime: stopped
play ~/chimes/listen_stop.wav vol -9 dB 2>/dev/null
termux-toast -s blue "Transcribing..."

# Transcribe
TEXT=$(python -u -c "
import speech_recognition as sr, traceback
r = sr.Recognizer()
with sr.AudioFile('$WAV') as src:
    audio = r.record(src)
try:
    result = r.recognize_google(audio)
    print(result)
except sr.UnknownValueError:
    print('LISTEN_ERROR: no speech could be understood')
except Exception as e:
    print(f'LISTEN_ERROR: {type(e).__name__}: {e}')
" 2>&1)

STT_EXIT=$?
echo "stt exit: $STT_EXIT"

if echo "$TEXT" | grep -q "LISTEN_ERROR"; then
    play ~/chimes/listen_fail.wav vol -9 dB 2>/dev/null
    termux-toast -s red "Transcription failed"
    echo "$TEXT"
    # Keep wav for debugging
    echo "WAV kept at: $WAV"
    exit 1
fi

rm -f "$WAV"

# Chime: done
play ~/chimes/listen_done.wav vol -9 dB 2>/dev/null
termux-toast -s green "Done"
echo "$TEXT"
