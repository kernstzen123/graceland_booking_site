'use client';

// ---------------------------------------------------------------------------
// Web Audio API feedback tones for the ticket scanner.
// Generates short synthesized sounds — no external audio files needed.
// The AudioContext is created on the first user interaction to comply with
// browser autoplay policies.
// ---------------------------------------------------------------------------

let audioCtx: AudioContext | null = null;

function getContext(): AudioContext {
  if (!audioCtx) {
    audioCtx = new AudioContext();
  }
  // Resume if the context was suspended (autoplay policy).
  if (audioCtx.state === 'suspended') {
    audioCtx.resume();
  }
  return audioCtx;
}

function playTone(frequency: number, duration: number, type: OscillatorType = 'sine', startTime?: number, gainValue = 0.35): { osc: OscillatorNode; gain: GainNode } {
  const ctx = getContext();
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = type;
  osc.frequency.value = frequency;
  gain.gain.value = gainValue;
  osc.connect(gain);
  gain.connect(ctx.destination);
  const t = startTime ?? ctx.currentTime;
  osc.start(t);
  // Smooth fade-out to avoid clicks
  gain.gain.setValueAtTime(gainValue, t + duration - 0.02);
  gain.gain.linearRampToValueAtTime(0, t + duration);
  osc.stop(t + duration);
  return { osc, gain };
}

/**
 * Ascending two-note chime: C5 → E5 (success).
 * Duration: ~300ms total.
 */
export function playSuccess(): void {
  try {
    const ctx = getContext();
    const now = ctx.currentTime;
    playTone(523.25, 0.15, 'sine', now, 0.3);       // C5
    playTone(659.25, 0.18, 'sine', now + 0.13, 0.3); // E5
  } catch { /* Audio API not available */ }
}

/**
 * Low buzz (duplicate / already scanned).
 * Duration: ~400ms. Also triggers device vibration if available.
 */
export function playDuplicate(): void {
  try {
    const ctx = getContext();
    const now = ctx.currentTime;
    playTone(150, 0.4, 'sawtooth', now, 0.25);
    // Vibrate if the Vibration API is available
    if (navigator.vibrate) {
      navigator.vibrate([200, 50, 200]);
    }
  } catch { /* Audio API not available */ }
}

/**
 * Double beep (invalid / error).
 * Duration: ~350ms total.
 */
export function playError(): void {
  try {
    const ctx = getContext();
    const now = ctx.currentTime;
    playTone(440, 0.1, 'square', now, 0.2);
    playTone(440, 0.1, 'square', now + 0.15, 0.2);
  } catch { /* Audio API not available */ }
}

/**
 * Subtle click for camera scan detection (acknowledgment).
 * Duration: ~50ms.
 */
export function playClick(): void {
  try {
    const ctx = getContext();
    playTone(1000, 0.05, 'sine', ctx.currentTime, 0.15);
  } catch { /* Audio API not available */ }
}

/**
 * Warm up the AudioContext on a user gesture (e.g. button tap).
 * Call this early to avoid the first real sound being delayed.
 */
export function warmUpAudio(): void {
  try {
    getContext();
  } catch { /* Audio API not available */ }
}
