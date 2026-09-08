/** Small inline SVG icons for the Stroke panel (caps, joins, alignment, arrowheads, profiles). */
import React from 'react';
import type { Arrowhead } from '@/model/types';
import { ARROWHEAD_SHAPES, profilePreviewPath } from '@/color/stroke';

const S = 16;

export function CapIcon({ kind }: { kind: 'butt' | 'round' | 'square' }) {
  return (
    <svg width={S} height={S} viewBox="0 0 16 16" aria-hidden>
      <line x1={7} y1={8} x2={15} y2={8} stroke="currentColor" strokeWidth={6} strokeLinecap={kind} />
      <line x1={7} y1={2} x2={7} y2={14} stroke="currentColor" strokeWidth={1} strokeDasharray="1 1" opacity={0.8} />
    </svg>
  );
}

export function JoinIcon({ kind }: { kind: 'miter' | 'round' | 'bevel' }) {
  return (
    <svg width={S} height={S} viewBox="0 0 16 16" aria-hidden>
      <path d="M2 14 L8 4 L14 14" fill="none" stroke="currentColor" strokeWidth={5} strokeLinejoin={kind} strokeLinecap="butt" strokeMiterlimit={10} />
    </svg>
  );
}

export function AlignIcon({ kind }: { kind: 'center' | 'inside' | 'outside' }) {
  const off = kind === 'center' ? 0 : kind === 'inside' ? 1.5 : -1.5;
  return (
    <svg width={S} height={S} viewBox="0 0 16 16" aria-hidden>
      <rect x={3} y={3} width={10} height={10} fill="none" stroke="currentColor" strokeWidth={1} strokeDasharray="1.5 1" opacity={0.7} />
      <rect x={3 + off} y={3 + off} width={10 - off * 2} height={10 - off * 2} fill="none" stroke="currentColor" strokeWidth={3} />
    </svg>
  );
}

/** Preview of an arrowhead on a short line (pointing right; `start` mirrors it). */
export function ArrowheadPreview({ kind, start, width = 44, height = 14 }: { kind: Arrowhead; start?: boolean; width?: number; height?: number }) {
  const shape = kind === 'none' ? null : ARROWHEAD_SHAPES[kind];
  const size = 10;
  const cy = height / 2;
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden style={{ transform: start ? 'scaleX(-1)' : undefined }}>
      <line x1={2} y1={cy} x2={shape ? width - size + 2 : width - 2} y2={cy} stroke="currentColor" strokeWidth={2} />
      {shape && (
        <g transform={`translate(${width - size - 1} ${cy - size / 2})`}>
          <path d={shape.d} fill={shape.fill ? 'currentColor' : 'none'} stroke={shape.fill ? 'none' : 'currentColor'} strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" />
        </g>
      )}
    </svg>
  );
}

export function ProfilePreview({ points, width = 72, height = 18 }: { points: Array<[number, number]>; width?: number; height?: number }) {
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden>
      <path d={profilePreviewPath(points, width, height)} fill="currentColor" />
    </svg>
  );
}
