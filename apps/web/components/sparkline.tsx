"use client";

/**
 * A small inline chart. Hand-drawn SVG rather than a charting library: this is
 * one shape on one scale, and a dependency for it would cost more than it saves.
 */
export function Sparkline({
  points,
  height = 44,
  className = "",
}: {
  points: { date: string; value: number }[];
  height?: number;
  className?: string;
}) {
  if (points.length < 2) {
    return (
      <div
        className={`flex items-center text-xs opacity-40 ${className}`}
        style={{ height }}
      >
        Not enough data yet
      </div>
    );
  }

  const values = points.map((p) => p.value);
  const max = Math.max(...values);
  const min = Math.min(...values);
  const span = max - min || 1;
  const width = 100;

  const coords = points.map((point, index) => {
    const x = (index / (points.length - 1)) * width;
    // SVG y grows downward, so invert; inset by 2 to keep the stroke visible.
    const y = height - 2 - ((point.value - min) / span) * (height - 4);
    return `${x.toFixed(2)},${y.toFixed(2)}`;
  });

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      className={`w-full ${className}`}
      style={{ height }}
      role="img"
      aria-label={`Trend from ${min} to ${max}`}
    >
      <polyline
        points={`0,${height} ${coords.join(" ")} ${width},${height}`}
        fill="currentColor"
        opacity={0.08}
      />
      <polyline
        points={coords.join(" ")}
        fill="none"
        stroke="currentColor"
        strokeWidth={1.5}
        vectorEffect="non-scaling-stroke"
        strokeLinejoin="round"
      />
    </svg>
  );
}
