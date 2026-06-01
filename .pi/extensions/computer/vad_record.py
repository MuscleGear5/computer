#!/usr/bin/env python3
"""Record audio with voice activity detection. Stops after silence following speech.

Bundled with the voice-system pi extension.
Usage: rec -r 16000 -c 1 -e signed-integer -b 16 -t raw - | python3 vad_record.py <out.wav> [aggressiveness] [max_sec] [silence_frames]
"""

import sys, os, struct, wave, tempfile
import webrtcvad

def main():
    if len(sys.argv) < 2:
        print("Usage: vad_record.py <out.wav> [aggressiveness] [max_sec] [silence_frames]", file=sys.stderr)
        sys.exit(1)

    out_path = sys.argv[1]
    aggressiveness = int(sys.argv[2]) if len(sys.argv) > 2 else 3
    max_record_sec = int(sys.argv[3]) if len(sys.argv) > 3 else 30
    silence_frames_target = int(sys.argv[4]) if len(sys.argv) > 4 else 70

    SAMPLE_RATE = 16000
    FRAME_MS = 30
    FRAME_SIZE = int(SAMPLE_RATE * FRAME_MS / 1000)  # 480 samples
    BYTES_PER_FRAME = FRAME_SIZE * 2  # 16-bit
    MIN_SPEECH_FRAMES = 3  # minimum speech frames before considering silence
    max_frames = int(max_record_sec * 1000 / FRAME_MS)

    vad = webrtcvad.Vad(aggressiveness)

    audio = b""
    frames_spoken = 0
    silence_count = 0
    speech_started = False
    frame_count = 0
    initial_silence_count = 0
    # No timeout for initial silence - wait indefinitely for user to start speaking

    while True:
        raw = sys.stdin.buffer.read(BYTES_PER_FRAME)
        if len(raw) < BYTES_PER_FRAME:
            break
        frame_count += 1

        is_speech = vad.is_speech(raw, SAMPLE_RATE)

        if is_speech:
            frames_spoken += 1
            silence_count = 0
            if frames_spoken >= MIN_SPEECH_FRAMES:
                speech_started = True
        elif speech_started:
            silence_count += 1
            if silence_count >= silence_frames_target:
                break
        # No initial silence timeout - wait as long as needed for first word

        audio += raw

        if frame_count >= max_frames:
            break

    # Write wav
    with wave.open(out_path, "w") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(SAMPLE_RATE)
        wf.writeframes(audio)

    print(f"OK {frame_count} {frames_spoken}", file=sys.stderr)

if __name__ == "__main__":
    main()
