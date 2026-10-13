// src/gesture/recognizer.ts
import { Direction, GesturePattern } from '../types/gesture';

export interface RecognizerOptions {
  thresholdPx?: number;   // Minimum segment length in pixels
  maxSegments?: number;   // Maximum number of direction segments
  enableDiagonals?: boolean; // Opt-in straight diagonal recognition
}

/** Computes gesture patterns from mouse trajectories */
export class GestureRecognizer {
  private segments: Direction[] = [];
  private lastPoint = { x: 0, y: 0 };
  private readonly THRESH: number;
  private readonly MAX_SEG: number;
  private readonly enableDiagonals: boolean;
  private canceled = false;

  constructor(opts: RecognizerOptions = {}) {
    this.THRESH   = opts.thresholdPx ?? 60;
    this.MAX_SEG  = opts.maxSegments ?? 4;
    this.enableDiagonals = opts.enableDiagonals ?? false;
  }

  /** Called on mousedown */
  start(x: number, y: number) {
    this.segments = [];
    this.canceled = false;
    this.lastPoint = { x, y };
  }

  /** Called on mousemove */
  track(x: number, y: number, onChange?: (segments: Direction[]) => void) {
    if (this.enableDiagonals) {
      this.trackWithDiagonals(x, y, onChange);
      return;
    }
    const dx = x - this.lastPoint.x;
    const dy = y - this.lastPoint.y;
    const dir = this.calcDirection(dx, dy);
    if (
      dir &&
      dir !== this.segments[this.segments.length - 1] &&
      this.segments.length < this.MAX_SEG
    ) {
      this.segments.push(dir);
      this.lastPoint = { x, y };
      onChange?.([...this.segments]); // Real-time feedback
    }
  }

  /** Called on mouseup → returns final pattern */
  finish(): GesturePattern {
    return this.canceled ? [] : this.normalize(this.segments);
  }

  isCanceled() {
    return this.canceled;
  }

  getThresholdPx() {
    return this.THRESH;
  }

  // ──────────────────────────────────────────── private

  private trackWithDiagonals(x: number, y: number, onChange?: (segments: Direction[]) => void) {
    if (this.canceled) return;
    const dx = x - this.lastPoint.x;
    const dy = y - this.lastPoint.y;
    const distance = Math.max(Math.abs(dx), Math.abs(dy));
    const previous = this.segments[this.segments.length - 1];
    if (distance <= (previous ? this.THRESH / 4 : this.THRESH)) return;

    const dir = this.calcDiagonalDirection(dx, dy, previous);
    if (dir === previous) {
      // Follow the stroke in short increments so a long first leg cannot
      // dominate the next turn. Small samples accumulate to filter jitter.
      this.lastPoint = { x, y };
      return;
    }
    if (distance <= this.THRESH) return;

    // Only straight diagonals are supported. Never execute a diagonal prefix
    // (notably app reload) after the user continues into a different direction.
    if (previous && (previous.includes('-') || dir.includes('-'))) {
      this.canceled = true;
      this.segments = [];
      onChange?.([]);
      return;
    }
    if (this.segments.length < this.MAX_SEG) {
      this.segments.push(dir);
      this.lastPoint = { x, y };
      onChange?.([...this.segments]);
    }
  }

  private calcDiagonalDirection(dx: number, dy: number, previous?: Direction): Direction {
    const ax = Math.abs(dx);
    const ay = Math.abs(dy);
    // Eight equal sectors initially; retain the current cardinal/diagonal
    // near sector boundaries with five degrees of angular hysteresis.
    const boundary = 22.5 + (previous ? (previous.includes('-') ? -5 : 5) : 0);
    if (Math.min(ax, ay) > Math.max(ax, ay) * Math.tan(boundary * Math.PI / 180)) {
      if (dy < 0) return dx > 0 ? 'up-right' : 'up-left';
      return dx > 0 ? 'down-right' : 'down-left';
    }
    if (ax > ay) return dx > 0 ? 'right' : 'left';
    return dy > 0 ? 'down' : 'up';
  }

  private calcDirection(dx: number, dy: number): Direction | null {
    if (Math.abs(dx) > Math.abs(dy)) {
      if (Math.abs(dx) > this.THRESH) return dx > 0 ? 'right' : 'left';
    } else {
      if (Math.abs(dy) > this.THRESH) return dy > 0 ? 'down' : 'up';
    }
    return null;
  }

  /** Deduplicate consecutive directions, normalize alternating patterns */
  private normalize(seg: Direction[]): GesturePattern {
    const condensed = seg.filter((d, i, a) => i === 0 || d !== a[i - 1]);

    // Single horizontal/vertical alternation (2-step) → special token
    if (condensed.length === 2 && condensed[0] !== condensed[1]) {
      const pair = new Set([condensed[0], condensed[1]]);
      if (pair.has('left') && pair.has('right')) return ['LR-LR'];
      if (pair.has('up') && pair.has('down')) return ['UD-UD'];
    }

    // 4-step alternating patterns are no longer used
    return condensed.slice(0, 2); // Max 2-step
  }
}
