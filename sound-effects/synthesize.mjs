#!/usr/bin/env node
/**
 * WAV Synthesizer for pi-agent event sounds
 * Generates small, pleasant chimes/dings/buzzes using pure waveform math.
 * All output: 16-bit PCM WAV, 44100Hz, mono.
 */

import { writeFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SAMPLE_RATE = 44100;
const OUT_DIR = __dirname;

// --- Waveform generators ---

function sine(freq, t) {
  return Math.sin(2 * Math.PI * freq * t);
}

function triangle(freq, t) {
  const p = (t * freq) % 1;
  return 4 * Math.abs(p - 0.5) - 1;
}

function square(freq, t, duty = 0.5) {
  return ((t * freq) % 1 < duty) ? 0.6 : -0.6;
}

function sawtooth(freq, t) {
  return 2 * ((t * freq) % 1) - 1;
}

function noise(t, seed = 0) {
  const x = Math.sin(seed * 127.1 + t * 43758.5453123) * 43758.5453123;
  return x - Math.floor(x);
}

// --- Envelope shapes ---

function envelopeADSR(t, duration, a, d, s, r) {
  if (t < a) return t / a;
  if (t < a + d) return 1 - (1 - s) * ((t - a) / d);
  if (t < duration - r) return s;
  return s * ((duration - t) / r);
}

function envelopeBell(t, duration) {
  // Fast attack, exponential decay
  return Math.exp(-t * 8) * (1 - Math.exp(-t * 200));
}

function envelopeShort(t, duration) {
  return Math.exp(-t * 15) * (1 - Math.exp(-t * 500));
}

function envelopePing(t, duration) {
  return Math.exp(-t * 6) * (1 - Math.exp(-t * 300));
}

function envelopeSwell(t, duration) {
  const a = duration * 0.2;
  const r = duration * 0.4;
  if (t < a) return t / a;
  if (t < duration - r) return 1;
  return (duration - t) / r;
}

// --- Utility ---

function normalize(samples, target = 0.85) {
  const max = Math.max(...samples.map(Math.abs), 0.001);
  return samples.map(s => (s / max) * target);
}

function mix(...signalPairs) {
  const len = Math.max(...signalPairs.map(([s]) => s.length));
  const out = new Float32Array(len);
  for (const [sig, vol = 1] of signalPairs) {
    for (let i = 0; i < sig.length; i++) {
      out[i] += sig[i] * vol;
    }
  }
  return out;
}

function render(durationSec, fn) {
  const n = Math.floor(SAMPLE_RATE * durationSec);
  const samples = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / SAMPLE_RATE;
    samples[i] = fn(t, durationSec);
  }
  return samples;
}

// --- WAV writer ---

function writeWav(filename, samples) {
  const normalized = normalize(samples);
  const numSamples = normalized.length;
  const dataSize = numSamples * 2; // 16-bit
  const buffer = Buffer.alloc(44 + dataSize);

  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write("WAVE", 8);
  buffer.write("fmt ", 12);
  buffer.writeUInt32LE(16, 16);       // fmt chunk size
  buffer.writeUInt16LE(1, 20);        // PCM
  buffer.writeUInt16LE(1, 22);        // mono
  buffer.writeUInt32LE(SAMPLE_RATE, 24);
  buffer.writeUInt32LE(SAMPLE_RATE * 2, 28); // byte rate
  buffer.writeUInt16LE(2, 32);        // block align
  buffer.writeUInt16LE(16, 34);       // bits per sample
  buffer.write("data", 36);
  buffer.writeUInt32LE(dataSize, 40);

  for (let i = 0; i < numSamples; i++) {
    const s = Math.max(-1, Math.min(1, normalized[i]));
    const val = s < 0 ? s * 0x8000 : s * 0x7FFF;
    buffer.writeInt16LE(val, 44 + i * 2);
  }

  writeFileSync(filename, buffer);
  const sizeKB = (buffer.length / 1024).toFixed(1);
  console.log(`  ${filename} (${sizeKB} KB, ${numSamples / SAMPLE_RATE.toFixed(2)}s)`);
}

// --- Sound definitions ---

const SOUNDS = {
  // SUCCESS (pleasant, confirming)
  "success/tool-complete": {
    desc: "Tool finished successfully - bright ascending chime",
    dir: "success",
    generate: () => {
      const s1 = render(0.4, (t) => sine(880, t) * envelopeBell(t, 0.4));
      const s2 = render(0.4, (t, d) => sine(1100, t) * envelopeBell(t - 0.08, d - 0.08));
      return mix(s1, [s2, 0.7]);
    }
  },
  "success/agent-response-done": {
    desc: "Agent finished response - warm descending resolution",
    dir: "success",
    generate: () => {
      const s1 = render(0.35, (t) => sine(1047, t) * envelopeBell(t, 0.35));
      const s2 = render(0.35, (t, d) => sine(880, t) * envelopeBell(t - 0.06, d - 0.06));
      const s3 = render(0.35, (t, d) => sine(660, t) * envelopeBell(t - 0.12, d - 0.12));
      return mix([s1, 0.6], [s2, 0.5], [s3, 0.4]);
    }
  },
  "success/review-loop-pass": {
    desc: "Review passed - clean two-tone ding",
    dir: "success",
    generate: () => {
      const s1 = render(0.2, (t) => sine(1319, t) * envelopeShort(t, 0.2));
      const s2 = render(0.2, (t, d) => sine(1568, t) * envelopeShort(t - 0.1, d - 0.1));
      return mix([s1, 0.8], [s2, 0.8]);
    }
  },
  "success/auto-save": {
    desc: "Auto-saved - subtle soft click",
    dir: "success",
    generate: () => {
      const click = render(0.08, (t) => noise(t, 42) * envelopeShort(t, 0.08));
      const tone = render(0.15, (t) => sine(440, t) * envelopeShort(t, 0.15));
      return mix([click, 0.2], [tone, 0.15]);
    }
  },

  // ERROR (attention-getting but not harsh)
  "error/tool-failed": {
    desc: "Tool error - low dissonant buzz",
    dir: "error",
    generate: () => {
      const s1 = render(0.35, (t) => square(180, t, 0.4) * envelopeADSR(t, 0.35, 0.005, 0.05, 0.5, 0.1));
      const s2 = render(0.35, (t) => square(190, t, 0.4) * envelopeADSR(t, 0.35, 0.005, 0.05, 0.5, 0.1));
      const s3 = render(0.35, (t) => triangle(120, t) * envelopeADSR(t, 0.35, 0.005, 0.1, 0.3, 0.1));
      return mix([s1, 0.3], [s2, 0.3], [s3, 0.2]);
    }
  },
  "error/network-error": {
    desc: "Network error - stuttered static burst",
    dir: "error",
    generate: () => {
      const static1 = render(0.15, (t) => (noise(t, 1) * 2 - 1) * envelopeADSR(t, 0.15, 0.003, 0.02, 0.6, 0.05));
      const static2 = render(0.15, (t, d) => (noise(t + 0.5, 2) * 2 - 1) * envelopeADSR(t - 0.2, d - 0.2, 0.003, 0.02, 0.5, 0.05));
      const static3 = render(0.15, (t, d) => (noise(t + 1, 3) * 2 - 1) * envelopeADSR(t - 0.4, d - 0.4, 0.003, 0.02, 0.3, 0.05));
      return mix([static1, 0.25], [static2, 0.2], [static3, 0.15]);
    }
  },
  "error/cost-threshold": {
    desc: "Cost warning - descending urgent tone",
    dir: "error",
    generate: () => {
      const s1 = render(0.3, (t) => triangle(660, t) * envelopePing(t, 0.3));
      const s2 = render(0.3, (t, d) => triangle(440, t) * envelopePing(t - 0.1, d - 0.1));
      return mix([s1, 0.4], [s2, 0.4]);
    }
  },
  "error/agent-gives-up": {
    desc: "Agent gives up - sad descending three-note",
    dir: "error",
    generate: () => {
      const s1 = render(0.25, (t) => triangle(523, t) * envelopeBell(t, 0.25));
      const s2 = render(0.25, (t, d) => triangle(392, t) * envelopeBell(t - 0.12, d - 0.12));
      const s3 = render(0.25, (t, d) => triangle(330, t) * envelopeBell(t - 0.24, d - 0.24));
      return mix([s1, 0.35], [s2, 0.35], [s3, 0.35]);
    }
  },

  // START (initiating, attention)
  "start/tool-start": {
    desc: "Tool starts - quick rising blip",
    dir: "start",
    generate: () => {
      const osc = render(0.12, (t) => {
        const freq = 600 + 400 * (t / 0.12);
        return sine(freq, t);
      });
      return render(0.12, (t) => osc[Math.floor(t * SAMPLE_RATE)] * envelopeShort(t, 0.12));
    }
  },
  "start/session-start": {
    desc: "Session welcome - friendly ascending arpeggio",
    dir: "start",
    generate: () => {
      const s1 = render(0.7, (t) => sine(523, t) * envelopeBell(t, 0.7));
      const s2 = render(0.7, (t, d) => sine(659, t) * envelopeBell(t - 0.1, d - 0.1));
      const s3 = render(0.7, (t, d) => sine(784, t) * envelopeBell(t - 0.2, d - 0.2));
      const s4 = render(0.7, (t, d) => sine(1047, t) * envelopeBell(t - 0.3, d - 0.3));
      return mix([s1, 0.4], [s2, 0.4], [s3, 0.4], [s4, 0.5]);
    }
  },
  "start/streaming-start": {
    desc: "Streaming begins - soft whoosh",
    dir: "start",
    generate: () => {
      const noiseSig = render(0.25, (t) => (noise(t, 7) * 2 - 1) * envelopeSwell(t, 0.25));
      const tone = render(0.25, (t) => sine(220, t) * envelopeSwell(t, 0.25));
      return mix([noiseSig, 0.1], [tone, 0.08]);
    }
  },
  "start/mode-switch": {
    desc: "Mode changed - crisp click-pop",
    dir: "start",
    generate: () => {
      const click = render(0.06, (t) => {
        const n = (noise(t, 99) * 2 - 1);
        const t2 = sine(1200, t);
        return (n + t2) * envelopeShort(t, 0.06);
      });
      return mix([click, 0.8]);
    }
  },

  // NOTIFICATION (alerts, but pleasant)
  "notification/user-message-sent": {
    desc: "Message sent - soft pop",
    dir: "notification",
    generate: () => {
      const pop = render(0.1, (t) => {
        const freq = 300 + 200 * Math.exp(-t * 30);
        return sine(freq, t) * envelopeShort(t, 0.1);
      });
      return mix([pop, 0.6]);
    }
  },
  "notification/new-dependency": {
    desc: "New dependency detected - curious two-note",
    dir: "notification",
    generate: () => {
      const s1 = render(0.15, (t) => triangle(587, t) * envelopePing(t, 0.15));
      const s2 = render(0.15, (t, d) => triangle(698, t) * envelopePing(t - 0.08, d - 0.08));
      return mix([s1, 0.4], [s2, 0.4]);
    }
  },
  "notification/mistake-correction": {
    desc: "Mistake corrected - redeeming up-sweep",
    dir: "notification",
    generate: () => {
      const sweep = render(0.25, (t) => {
        const freq = 400 + 600 * (t / 0.25);
        return sine(freq, t) * envelopePing(t, 0.25);
      });
      return mix([sweep, 0.4]);
    }
  },
  "notification/background-interrupt": {
    desc: "Background agent interrupt - double ping",
    dir: "notification",
    generate: () => {
      const p1 = render(0.15, (t) => sine(880, t) * envelopeShort(t, 0.15));
      const p2 = render(0.15, (t, d) => sine(1047, t) * envelopeShort(t - 0.18, d - 0.18));
      return mix([p1, 0.35], [p2, 0.4]);
    }
  },
  "notification/idle-timeout": {
    desc: "Idle timeout - gentle reminder chime",
    dir: "notification",
    generate: () => {
      const s1 = render(0.4, (t) => sine(698, t) * envelopeBell(t, 0.4));
      const s2 = render(0.4, (t, d) => sine(880, t) * envelopeBell(t - 0.15, d - 0.15));
      return mix([s1, 0.3], [s2, 0.25]);
    }
  },

  // MILESTONE (achievements, progress)
  "milestone/clipboard-action": {
    desc: "Clipboard copied - camera shutter click",
    dir: "milestone",
    generate: () => {
      const click1 = render(0.03, (t) => noise(t, 50) * envelopeShort(t, 0.03));
      const click2 = render(0.02, (t) => noise(t, 51) * envelopeShort(t, 0.02));
      return mix([click1, 0.5], [click2, 0.3]);
    }
  },
  "milestone/file-upload": {
    desc: "File uploaded - ascending sparkle",
    dir: "milestone",
    generate: () => {
      const s1 = render(0.3, (t) => sine(1200, t) * envelopeBell(t, 0.3));
      const s2 = render(0.3, (t, d) => sine(1500, t) * envelopeBell(t - 0.05, d - 0.05));
      const s3 = render(0.3, (t, d) => sine(1800, t) * envelopeBell(t - 0.1, d - 0.1));
      return mix([s1, 0.2], [s2, 0.2], [s3, 0.25]);
    }
  },
  "milestone/thinking": {
    desc: "Agent thinking - soft contemplative hum",
    dir: "milestone",
    generate: () => {
      const hum = render(0.5, (t) => {
        const vibrato = 1 + 0.005 * sine(5, t);
        return sine(220 * vibrato, t) * envelopeSwell(t, 0.5);
      });
      return mix([hum, 0.15]);
    }
  },
  "milestone/context-window-warning": {
    desc: "Context window filling - tension rising",
    dir: "milestone",
    generate: () => {
      const s1 = render(0.4, (t) => {
        const freq = 300 + 100 * (t / 0.4);
        return sawtooth(freq, t) * envelopeADSR(t, 0.4, 0.01, 0.1, 0.6, 0.15);
      });
      return mix([s1, 0.2]);
    }
  },

  // SYSTEM (utility, neutral)
  "system/user-cancel": {
    desc: "User cancelled - descending dismiss",
    dir: "system",
    generate: () => {
      const s1 = render(0.2, (t) => {
        const freq = 800 - 300 * (t / 0.2);
        return triangle(freq, t) * envelopeShort(t, 0.2);
      });
      return mix([s1, 0.4]);
    }
  },
  "system/error-recovery": {
    desc: "Error recovery initiated - hopeful ascending",
    dir: "system",
    generate: () => {
      const s1 = render(0.3, (t) => triangle(392, t) * envelopeBell(t, 0.3));
      const s2 = render(0.3, (t, d) => triangle(523, t) * envelopeBell(t - 0.1, d - 0.1));
      const s3 = render(0.3, (t, d) => triangle(659, t) * envelopeBell(t - 0.2, d - 0.2));
      return mix([s1, 0.35], [s2, 0.35], [s3, 0.35]);
    }
  },
  "system/permission-request": {
    desc: "Permission needed - inquisitive rise",
    dir: "system",
    generate: () => {
      const s = render(0.25, (t) => {
        const freq = 500 + 200 * (t / 0.25);
        return triangle(freq, t) * envelopePing(t, 0.25);
      });
      return mix([s, 0.35]);
    }
  },

  // WARNING (caution, not error)
  "warning/general-warning": {
    desc: "General warning - two-tone caution",
    dir: "warning",
    generate: () => {
      const s1 = render(0.15, (t) => square(440, t, 0.3) * envelopePing(t, 0.15));
      const s2 = render(0.15, (t, d) => square(520, t, 0.3) * envelopePing(t - 0.18, d - 0.18));
      return mix([s1, 0.2], [s2, 0.2]);
    }
  },

  // VOICE (speech-related)
  "voice/tts-start": {
    desc: "TTS begins - subtle ear-con",
    dir: "voice",
    generate: () => {
      const s = render(0.08, (t) => sine(1000, t) * envelopeShort(t, 0.08));
      return mix([s, 0.25]);
    }
  },
  "voice/tts-end": {
    desc: "TTS ends - subtle ear-con down",
    dir: "voice",
    generate: () => {
      const s = render(0.08, (t) => sine(800, t) * envelopeShort(t, 0.08));
      return mix([s, 0.2]);
    }
  },
};

// --- Generate all ---

console.log("Generating pi-agent soundboard...\n");

for (const [name, sound] of Object.entries(SOUNDS)) {
  const dir = join(OUT_DIR, sound.dir);
  mkdirSync(dir, { recursive: true });
  const filename = join(dir, `${name.split("/")[1]}.wav`);
  const samples = sound.generate();
  writeWav(filename, samples);
}

console.log(`\nDone! Generated ${Object.keys(SOUNDS).length} sounds across ${new Set(Object.values(SOUNDS).map(s => s.dir)).size} categories.`);
