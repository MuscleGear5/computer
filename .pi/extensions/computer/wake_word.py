#!/usr/bin/env python3
"""
Wake word daemon - VAD + Whisper hybrid

Bundled with the voice-system pi extension.
Step 1: webrtcvad detects speech (fast, always-on)
Step 2: On speech, record segment and run whisper tiny
Step 3: If whisper output contains the wake word, trigger wake

Usage:
  python3 wake_word.py [--foreground] [--word WORD] [--whisper-bin PATH] [--whisper-model PATH]
"""

import os, sys, io, wave, time, signal, subprocess, threading, argparse
from pathlib import Path

HOME = Path.home()
EXT_DIR = HOME / ".pi" / "agent" / "extensions" / "voice-system"

STATUS_FILE = HOME / ".pi" / "agent" / "tasks" / "wake_word.status"
PID_FILE = HOME / "tmp" / "wake_word.pid"
LOG_FILE = HOME / "tmp" / "wake_word.log"
CLIPS_DIR = HOME / "tmp" / "wake_word_clips"

SAMPLE_RATE = 16000
FRAME_MS = 30
FRAME_SIZE = int(SAMPLE_RATE * FRAME_MS / 1000) * 2  # bytes per frame
SILENCE_FRAMES = 50
MAX_SEGMENT_FRAMES = 200
MIN_SPEECH_FRAMES = 5

import webrtcvad

class WakeWordDaemon:
    def __init__(self, wake_word: str = "computer",
                 whisper_bin: str = "", whisper_model: str = ""):
        self.wake_word = wake_word.lower()
        self.whisper_bin = Path(whisper_bin) if whisper_bin else (
            HOME / "tmp" / "whisper.cpp" / "build" / "bin" / "whisper-cli"
        )
        self.whisper_model = Path(whisper_model) if whisper_model else (
            HOME / "tmp" / "whisper.cpp" / "models" / "ggml-tiny.en.bin"
        )
        self.vad = webrtcvad.Vad(2)
        self.running = False
        self.proc = None
        self.last_det = 0
        self.clip_seq = 0
        self.audio_buffer = bytearray()
        self.speech_frames = 0
        self.silence_count = 0

    def log(self, msg):
        ts = time.strftime("%H:%M:%S")
        line = f"{ts} {msg}"
        print(line, flush=True)
        try:
            with open(LOG_FILE, "a") as f:
                f.write(line + "\n")
        except OSError:
            pass

    def write_status(self, msg):
        STATUS_FILE.parent.mkdir(parents=True, exist_ok=True)
        STATUS_FILE.write_text(msg)
        self.log(f"STATUS: {msg}")

    def clear_status(self):
        if STATUS_FILE.exists():
            STATUS_FILE.unlink()

    def save_clip(self, pcm_data, filename):
        CLIPS_DIR.mkdir(parents=True, exist_ok=True)
        path = CLIPS_DIR / filename
        with wave.open(str(path), "wb") as wf:
            wf.setnchannels(1)
            wf.setsampwidth(2)
            wf.setframerate(SAMPLE_RATE)
            wf.writeframes(pcm_data)
        self.log(f"Clip saved: {path}")
        return path

    def transcribe(self, wav_path):
        if not self.whisper_bin.exists() or not self.whisper_model.exists():
            return ""
        try:
            result = subprocess.run(
                [str(self.whisper_bin), "-m", str(self.whisper_model),
                 "-t", "2", "--no-timestamps", "-np",
                 "-f", str(wav_path)],
                capture_output=True, text=True, timeout=15
            )
            lines = []
            for line in result.stdout.strip().split("\n"):
                line = line.strip()
                if line and not line.startswith("system_info") and not line.startswith("main:"):
                    lines.append(line)
            return " ".join(lines).strip()
        except subprocess.TimeoutExpired:
            return ""

    def on_wake(self, audio_data):
        now = time.time()
        if now - self.last_det < 5:
            return
        self.last_det = now
        self.clip_seq += 1
        stamp = int(now)
        clip_name = f"wake_{stamp}_{self.clip_seq}.wav"
        clip_path = self.save_clip(audio_data, clip_name)
        self.write_status(f"WAKE {clip_path}")
        self.log(f"*** WAKE WORD '{self.wake_word}' DETECTED ***")

    def process_audio(self, pcm_data):
        try:
            is_speech = self.vad.is_speech(pcm_data, SAMPLE_RATE)
        except Exception:
            return

        if is_speech:
            self.audio_buffer.extend(pcm_data)
            self.speech_frames += 1
            self.silence_count = 0
        else:
            if self.speech_frames > 0:
                self.silence_count += 1
                self.audio_buffer.extend(pcm_data)

                if self.silence_count >= SILENCE_FRAMES and self.speech_frames >= MIN_SPEECH_FRAMES:
                    self._process_segment()

            elif self.silence_count > 200:
                self.silence_count = 0

        if self.speech_frames >= MAX_SEGMENT_FRAMES:
            self._process_segment()

    def _process_segment(self):
        self.log(f"Speech segment: {self.speech_frames} frames, "
                 f"{len(self.audio_buffer)/(SAMPLE_RATE*2):.1f}s")

        tmp_wav = HOME / "tmp" / "wake_segment.wav"
        with wave.open(str(tmp_wav), "wb") as wf:
            wf.setnchannels(1)
            wf.setsampwidth(2)
            wf.setframerate(SAMPLE_RATE)
            wf.writeframes(bytes(self.audio_buffer))

        text = self.transcribe(tmp_wav)
        if text:
            self.log(f"Transcription: '{text}'")
            if self.wake_word in text.lower():
                self.on_wake(bytes(self.audio_buffer))
        else:
            self.log("Transcription: (empty)")

        self.audio_buffer = bytearray()
        self.speech_frames = 0
        self.silence_count = 0

    def run(self):
        self.running = True
        self.log(f"Wake word daemon starting (word='{self.wake_word}')")
        CLIPS_DIR.mkdir(parents=True, exist_ok=True)
        self.clear_status()

        signal.signal(signal.SIGTERM, self._stop)
        signal.signal(signal.SIGINT, self._stop)

        while self.running:
            try:
                self._audio_loop()
            except Exception as e:
                self.log(f"Error: {e} - reconnecting in 5s")
                self._kill_proc()
                if self.running:
                    time.sleep(5)

        self._shutdown()

    def _audio_loop(self):
        cmd = ["rec", "-r", str(SAMPLE_RATE), "-c", "1",
               "-e", "signed-integer", "-b", "16", "-t", "raw", "-"]
        self.log(f"Starting audio: {' '.join(cmd)}")
        self.proc = subprocess.Popen(cmd, stdout=subprocess.PIPE,
                                      stderr=subprocess.DEVNULL, bufsize=0)

        while self.running:
            data = self.proc.stdout.read(FRAME_SIZE)
            if not data:
                self.log("Audio stream ended")
                break
            if len(data) == FRAME_SIZE:
                self.process_audio(data)

    def _stop(self, signum, frame):
        self.log(f"Signal {signum} received")
        self.running = False
        self._kill_proc()

    def _kill_proc(self):
        if self.proc:
            try:
                self.proc.terminate()
                self.proc.wait(timeout=3)
            except Exception:
                try:
                    self.proc.kill()
                except Exception:
                    pass
            self.proc = None

    def _shutdown(self):
        self._kill_proc()
        self.clear_status()
        try:
            PID_FILE.unlink()
        except OSError:
            pass
        self.log("Daemon stopped")


def daemonize():
    if os.fork() > 0:
        os._exit(0)
    os.setsid()
    if os.fork() > 0:
        os._exit(0)
    os.close(0)
    os.close(1)
    os.close(2)


def main():
    ap = argparse.ArgumentParser(description="Wake word daemon (VAD + Whisper)")
    ap.add_argument("-f", "--foreground", action="store_true",
                    help="Run in foreground (don't daemonize)")
    ap.add_argument("-w", "--word", default="computer",
                    help="Wake word to listen for (default: computer)")
    ap.add_argument("--whisper-bin", default="",
                    help="Path to whisper-cli binary")
    ap.add_argument("--whisper-model", default="",
                    help="Path to whisper model file")
    ap.add_argument("--stop", action="store_true",
                    help="Stop a running daemon")
    args = ap.parse_args()

    if args.stop:
        if PID_FILE.exists():
            try:
                pid = int(PID_FILE.read_text().strip())
                os.kill(pid, signal.SIGTERM)
                print(f"Sent SIGTERM to {pid}")
            except Exception as e:
                print(f"Failed to stop: {e}")
                try:
                    PID_FILE.unlink()
                except OSError:
                    pass
        else:
            print("No PID file found")
        return

    if not args.foreground:
        if PID_FILE.exists():
            try:
                old = int(PID_FILE.read_text().strip())
                os.kill(old, 0)
                print("Already running (PID file exists and process is alive)")
                sys.exit(1)
            except ProcessLookupError:
                PID_FILE.unlink()
            except PermissionError:
                print("Already running (can't check PID)")
                sys.exit(1)

        daemonize()
        PID_FILE.parent.mkdir(parents=True, exist_ok=True)
        PID_FILE.write_text(str(os.getpid()))
        LOG_FILE.parent.mkdir(parents=True, exist_ok=True)

    daemon = WakeWordDaemon(
        wake_word=args.word,
        whisper_bin=args.whisper_bin,
        whisper_model=args.whisper_model,
    )
    daemon.run()


if __name__ == "__main__":
    main()
