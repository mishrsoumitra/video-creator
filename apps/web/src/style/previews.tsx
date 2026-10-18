import { easingFunction, type Easing, type SpringConfig } from '@vc/config';
import { useMemo } from 'react';
import { spring } from 'remotion';

const W = 160;
const H = 80;
const PAD = 8;

const Curve = ({
  points,
  label,
  min,
  max,
}: {
  points: number[];
  label: string;
  min: number;
  max: number;
}) => {
  const span = max - min || 1;
  const d = points
    .map((v, i) => {
      const x = PAD + (i / (points.length - 1)) * (W - 2 * PAD);
      const y = H - PAD - ((v - min) / span) * (H - 2 * PAD);
      return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');
  const targetY = H - PAD - ((1 - min) / span) * (H - 2 * PAD);
  return (
    <svg
      className="curve"
      role="img"
      aria-label={label}
      viewBox={`0 0 ${W} ${H}`}
      width={W}
      height={H}
    >
      <line x1={PAD} x2={W - PAD} y1={targetY} y2={targetY} className="curve-target" />
      <path d={d} className="curve-line" />
    </svg>
  );
};

export const EasingPreview = ({ easing }: { easing: Easing }) => {
  const points = useMemo(() => {
    try {
      const fn = easingFunction(easing);
      return Array.from({ length: 61 }, (_, i) => fn(i / 60));
    } catch {
      return [0, 1];
    }
  }, [easing]);
  return (
    <Curve
      points={points}
      label="Easing curve preview"
      min={Math.min(0, ...points)}
      max={Math.max(1, ...points)}
    />
  );
};

/** The caption-word spring over two seconds at 30 fps, recomputed as the settings change. */
export const SpringPreview = ({ config }: { config: SpringConfig }) => {
  const points = useMemo(() => {
    if (!(config.mass > 0 && config.damping > 0 && config.stiffness > 0)) return [0, 0];
    return Array.from({ length: 61 }, (_, frame) => spring({ frame, fps: 30, config }));
  }, [config]);
  return (
    <Curve
      points={points}
      label="Spring curve preview"
      min={Math.min(0, ...points)}
      max={Math.max(1, ...points)}
    />
  );
};
