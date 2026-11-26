'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useLiveBarcodeScanner, type DetectedBarcode } from '@/lib/qr-scanner';

/**
 * The phone or tablet camera as a QR scanner, for when the handheld scanner is
 * not in use. Only mounted in camera mode, so the camera is fully off
 * otherwise. `paused` stops detection while a booking is on screen; a code is
 * passed on at most once every 2 seconds.
 */

type Point = { x: number; y: number };

const OVERLAY_COLOR = '#10b981';
const FLASH_HOLD_MS = 300;
const FLASH_FADE_MS = 200;

function traceRoundedPolygon(ctx: CanvasRenderingContext2D, points: Point[], radius: number) {
  const last = points[points.length - 1];
  ctx.beginPath();
  ctx.moveTo((last.x + points[0].x) / 2, (last.y + points[0].y) / 2);
  points.forEach((point, index) => {
    const next = points[(index + 1) % points.length];
    ctx.arcTo(point.x, point.y, next.x, next.y, radius);
  });
  ctx.closePath();
}

export function CameraScanner({ paused, onCode, onStatus }: { paused: boolean; onCode: (value: string) => void; onStatus: (message: string) => void }) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const overlayCodes = useRef<DetectedBarcode[]>([]);
  const flash = useRef<{ points: Point[]; startedAt: number } | null>(null);
  const flashFrame = useRef<number | null>(null);
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pausedRef = useRef(paused);
  const onCodeRef = useRef(onCode);
  const onStatusRef = useRef(onStatus);
  const { start, pause, detectorKind } = useLiveBarcodeScanner(videoRef);
  const [torchOn, setTorchOn] = useState(false);
  const [torchSupported, setTorchSupported] = useState(false);
  const videoTrack = useRef<MediaStreamTrack | null>(null);

  useEffect(() => { pausedRef.current = paused; onCodeRef.current = onCode; onStatusRef.current = onStatus; });

  const drawOverlay = useCallback(() => {
    const canvas = canvasRef.current;
    const video = videoRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !video || !ctx) return;
    const dpr = window.devicePixelRatio || 1;
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    const { videoWidth, videoHeight } = video;
    if (!videoWidth || !videoHeight) return;
    // Map video pixels to the on-screen box, matching the video's object-fit: cover crop.
    const scale = Math.max(width / videoWidth, height / videoHeight);
    const offsetX = (width - videoWidth * scale) / 2;
    const offsetY = (height - videoHeight * scale) / 2;
    const toScreen = (point: Point) => ({ x: offsetX + point.x * scale, y: offsetY + point.y * scale });
    ctx.lineJoin = 'round';
    ctx.lineWidth = 4;
    ctx.strokeStyle = OVERLAY_COLOR;
    ctx.fillStyle = 'rgba(16, 185, 129, 0.15)';
    for (const code of overlayCodes.current) {
      traceRoundedPolygon(ctx, code.cornerPoints.map(toScreen), 10);
      ctx.fill();
      ctx.stroke();
    }
    if (flash.current) {
      const elapsed = performance.now() - flash.current.startedAt;
      const alpha = elapsed <= FLASH_HOLD_MS ? 0.85 : Math.max(0, 0.85 * (1 - (elapsed - FLASH_HOLD_MS) / FLASH_FADE_MS));
      traceRoundedPolygon(ctx, flash.current.points.map(toScreen), 10);
      ctx.fillStyle = `rgba(16, 185, 129, ${alpha})`;
      ctx.fill();
      ctx.globalAlpha = Math.min(1, alpha / 0.85);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
  }, []);

  const startFlash = useCallback((points: Point[]) => {
    flash.current = { points, startedAt: performance.now() };
    if (flashFrame.current !== null) cancelAnimationFrame(flashFrame.current);
    // Runs on its own frames so the flash still fades after the camera pauses.
    const step = () => {
      drawOverlay();
      if (flash.current && performance.now() - flash.current.startedAt < FLASH_HOLD_MS + FLASH_FADE_MS) {
        flashFrame.current = requestAnimationFrame(step);
      } else {
        flash.current = null;
        flashFrame.current = null;
        drawOverlay();
      }
    };
    flashFrame.current = requestAnimationFrame(step);
  }, [drawOverlay]);

  // Runs every camera frame: only the overlay redraw happens per frame; a code is passed on at most once per 2 seconds.
  const handleFrame = useCallback((codes: DetectedBarcode[]) => {
    if (codes.length > 0 || overlayCodes.current.length > 0) {
      overlayCodes.current = codes;
      drawOverlay();
    }
    const code = codes.find(candidate => candidate.rawValue);
    if (!code || pausedRef.current || debounceTimer.current) return;
    debounceTimer.current = setTimeout(() => { debounceTimer.current = null; }, 2000);
    if (typeof navigator.vibrate === 'function') navigator.vibrate(100);
    startFlash(code.cornerPoints);
    onCodeRef.current(code.rawValue);
  }, [drawOverlay, startFlash]);

  useEffect(() => {
    let cancelled = false;
    if (paused) {
      pause();
      overlayCodes.current = [];
      if (!flash.current) drawOverlay();
      return;
    }
    onStatusRef.current('Starting camera…');
    start(handleFrame).then(track => {
      if (cancelled || !track) return;
      onStatusRef.current('Point the camera at the booking QR code');
      videoTrack.current = track;
      try {
        const capabilities = track.getCapabilities?.();
        if (capabilities && 'torch' in capabilities) setTorchSupported(true);
      } catch { /* torch detection failed */ }
    }).catch(() => { if (!cancelled) onStatusRef.current('Camera unavailable. Use the handheld scanner or search below.'); });
    return () => { cancelled = true; };
  }, [paused, start, pause, handleFrame, drawOverlay]);

  useEffect(() => () => {
    if (flashFrame.current !== null) cancelAnimationFrame(flashFrame.current);
    if (debounceTimer.current) clearTimeout(debounceTimer.current);
  }, []);

  const toggleTorch = async () => {
    if (!videoTrack.current) return;
    try {
      const next = !torchOn;
      await videoTrack.current.applyConstraints({ advanced: [{ torch: next } as MediaTrackConstraintSet] });
      setTorchOn(next);
    } catch {
      onStatusRef.current('Flashlight not available on this device');
    }
  };

  return (
    <div style={{ position: 'relative', marginTop: '1rem' }}>
      <div style={{ position: 'relative', overflow: 'hidden', borderRadius: 16, background: '#020617', aspectRatio: '1 / 1' }}>
        <video ref={videoRef} autoPlay muted playsInline style={{ display: 'block', width: '100%', height: '100%', objectFit: 'cover' }} />
        <canvas ref={canvasRef} aria-hidden="true" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none' }} />
        {detectorKind === 'polyfill' && (
          <span style={{ position: 'absolute', left: 10, bottom: 8, padding: '2px 8px', borderRadius: 999, fontSize: '0.7rem', color: 'rgba(255,255,255,0.75)', background: 'rgba(2, 6, 23, 0.55)', pointerEvents: 'none' }}>
            Backup scanner
          </span>
        )}
      </div>
      {torchSupported && (
        <button
          onClick={toggleTorch}
          style={{ position: 'absolute', top: 12, right: 12, zIndex: 10, width: 44, height: 44, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', background: torchOn ? '#f59e0b' : 'rgba(255,255,255,0.15)', border: 'none', cursor: 'pointer', fontSize: '1.4rem' }}
          aria-label={torchOn ? 'Turn off flashlight' : 'Turn on flashlight'}
        >
          {torchOn ? '🔦' : '💡'}
        </button>
      )}
    </div>
  );
}
