'use client';

import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import type { DetectedBarcode } from 'barcode-detector/ponyfill';

export type { DetectedBarcode };
export type DetectorKind = 'native' | 'polyfill';

type Detector = { detect(source: HTMLVideoElement): Promise<DetectedBarcode[]> };
type NativeDetectorCtor = {
  new (options: { formats: string[] }): Detector;
  getSupportedFormats(): Promise<string[]>;
};

// Ticket QR codes are the only thing this app scans; restricting formats
// speeds up detection and avoids false positives from other barcodes.
const FORMATS = ['qr_code'] as const;

let detectorPromise: Promise<{ detector: Detector; kind: DetectorKind }> | null = null;

async function createDetector(): Promise<{ detector: Detector; kind: DetectorKind }> {
  const Native = (window as Window & { BarcodeDetector?: NativeDetectorCtor }).BarcodeDetector;
  if (Native) {
    try {
      // Some desktop Chromes expose BarcodeDetector but support no formats.
      if ((await Native.getSupportedFormats()).includes('qr_code')) {
        return { detector: new Native({ formats: [...FORMATS] }), kind: 'native' };
      }
    } catch { /* fall through to the polyfill */ }
  }

  const { BarcodeDetector, prepareZXingModule, ZXING_WASM_VERSION } = await import('barcode-detector/ponyfill');
  // Serve the wasm from our own origin (copied by scripts/copy-zxing-wasm.mjs)
  // instead of the default CDN, so the backup path works offline once cached.
  await prepareZXingModule({
    overrides: {
      locateFile: (path: string, prefix: string) => (path.endsWith('.wasm') ? `/zxing/${ZXING_WASM_VERSION}/${path}` : prefix + path),
    },
    fireImmediately: true,
  });
  return { detector: new BarcodeDetector({ formats: [...FORMATS] }), kind: 'polyfill' };
}

function getDetector() {
  detectorPromise ??= createDetector().catch(error => {
    detectorPromise = null;
    throw error;
  });
  return detectorPromise;
}

function releaseStream(video: HTMLVideoElement | null, stream: MediaStream | null) {
  stream?.getTracks().forEach(track => track.stop());
  if (video && video.srcObject === stream) video.srcObject = null;
}

/**
 * Streams the rear camera into `videoRef` and, once started, reports the QR
 * codes visible in every frame to `onFrame`. Ticket handling is left entirely
 * to the caller.
 */
export function useLiveBarcodeScanner(videoRef: RefObject<HTMLVideoElement | null>) {
  const [detectorKind, setDetectorKind] = useState<DetectorKind | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const running = useRef(false);
  const frameHandle = useRef<{ id: number; video: HTMLVideoElement | null } | null>(null);
  // Bumped on pause and unmount so in-flight starts/detections can't act late.
  const generation = useRef(0);

  const cancelFrame = useCallback(() => {
    const handle = frameHandle.current;
    frameHandle.current = null;
    if (!handle) return;
    if (handle.video) handle.video.cancelVideoFrameCallback(handle.id);
    else cancelAnimationFrame(handle.id);
  }, []);

  const pause = useCallback(() => {
    generation.current += 1;
    running.current = false;
    cancelFrame();
    // Freezes on the last frame; the stream stays open so resuming is instant.
    videoRef.current?.pause();
  }, [cancelFrame, videoRef]);

  /**
   * Starts (or resumes) the camera and detection loop. Resolves with the video
   * track, or null if superseded by a later start/pause/unmount.
   */
  const start = useCallback(async (onFrame: (codes: DetectedBarcode[]) => void): Promise<MediaStreamTrack | null> => {
    const myGeneration = ++generation.current;
    running.current = false;
    cancelFrame();

    const video = videoRef.current;
    if (!video) throw new Error('Video element is not mounted');

    const { detector, kind } = await getDetector();
    if (myGeneration !== generation.current) return null;
    setDetectorKind(kind);

    const liveTrack = stream.current?.getVideoTracks()[0];
    if (!liveTrack || liveTrack.readyState === 'ended') {
      releaseStream(video, stream.current);
      stream.current = null;
      const newStream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          facingMode: 'environment',
          width: { ideal: 1920 },
          height: { ideal: 1080 },
          // @ts-expect-error -- focusMode is valid but not in all TS definitions
          focusMode: 'continuous',
        },
      });
      if (myGeneration !== generation.current) {
        releaseStream(null, newStream);
        return null;
      }
      stream.current = newStream;
      video.srcObject = newStream;
    }

    try {
      await video.play();
    } catch (error) {
      // A pause()/unmount during play() rejects it with AbortError; that's not a camera failure.
      if (myGeneration !== generation.current) return null;
      throw error;
    }
    if (myGeneration !== generation.current) return null;

    running.current = true;
    let detecting = false;
    const useVideoFrames = 'requestVideoFrameCallback' in HTMLVideoElement.prototype;

    const schedule = () => {
      frameHandle.current = useVideoFrames
        ? { id: video.requestVideoFrameCallback(tick), video }
        : { id: requestAnimationFrame(tick), video: null };
    };

    const tick = () => {
      if (!running.current || myGeneration !== generation.current) return;
      // Skip frames while a detection is still in flight (the wasm path can take longer than one frame).
      if (!detecting && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
        detecting = true;
        detector.detect(video)
          .then(codes => {
            if (running.current && myGeneration === generation.current) onFrame(codes);
          })
          .catch(() => { /* transient decode errors are expected; keep scanning */ })
          .finally(() => { detecting = false; });
      }
      schedule();
    };

    schedule();
    return stream.current?.getVideoTracks()[0] ?? null;
  }, [cancelFrame, videoRef]);

  useEffect(() => {
    const video = videoRef.current;
    return () => {
      generation.current += 1;
      running.current = false;
      cancelFrame();
      releaseStream(video, stream.current);
      stream.current = null;
    };
  }, [cancelFrame, videoRef]);

  return { start, pause, detectorKind };
}
