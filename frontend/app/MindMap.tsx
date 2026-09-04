"use client";

import React from "react";

export interface MindMapBranch {
  label: string;
  children?: string[];
}

export interface MindMapData {
  central: string;
  branches: MindMapBranch[];
}

// Bigger canvas + bigger radii than before. The old fixed values (860x560,
// radius 188/82) were tuned for single-line labels only — as soon as a
// child label wrapped to two lines, or a branch had only 2 children instead
// of 3, the fixed angular gap (0.42 rad regardless of branch/child count)
// put boxes closer together than their own rendered height, so they
// visually merged into each other.
const VIEW_W = 1100;
const VIEW_H = 1000;
const CX = VIEW_W / 2;
const CY = VIEW_H / 2;
const BRANCH_RADIUS = 240;
const CHILD_RADIUS = 225;
// Upper bound on how far a child can swing away from its branch's own
// outward direction, in radians. The real value used is also capped by
// how many branches share the circle (see `safeSpread` below), so children
// can never swing far enough to land in a neighboring branch's lane.
const MAX_CHILD_SPREAD = 0.62;

function polar(cx: number, cy: number, radius: number, angleRad: number) {
  return {
    x: cx + radius * Math.cos(angleRad),
    y: cy + radius * Math.sin(angleRad),
  };
}

function NodeBox({
  x,
  y,
  label,
  variant,
}: {
  x: number;
  y: number;
  label: string;
  variant: "central" | "branch" | "child";
}) {
  const styles =
    variant === "central"
      ? "bg-darkCard border-accent text-accent shadow-glow font-bold text-sm px-4 py-2.5 max-w-[180px]"
      : variant === "branch"
      ? "bg-darkCard border-teal-500/50 text-slate-100 text-xs font-semibold px-3 py-2 max-w-[150px]"
      : "bg-darkSurface border-borderColor text-slate-300 text-[11px] px-2.5 py-1.5 max-w-[130px]";

  return (
    <div
      className="absolute -translate-x-1/2 -translate-y-1/2 pointer-events-none"
      style={{ left: `${(x / VIEW_W) * 100}%`, top: `${(y / VIEW_H) * 100}%` }}
    >
      <div className={`rounded-xl border text-center leading-snug ${styles}`}>
        {label}
      </div>
    </div>
  );
}

export default function MindMap({ data }: { data: MindMapData }) {
  const branches = (data.branches || []).slice(0, 6);
  const n = Math.max(branches.length, 1);

  // With 5-6 branches on screen at once, showing 3 children on every one of
  // them packs ~15-18 boxes into the same circle — there just isn't enough
  // room to keep all of them apart, no matter the spacing math. Once there
  // are that many branches, cap each one to its 2 most important children
  // instead of silently letting them overlap.
  const maxKidsPerBranch = n >= 5 ? 2 : 3;

  // Each branch owns an angular "lane" of 360/n degrees. Keeping child
  // spread within a fraction of that lane guarantees children never reach
  // into a neighboring branch's lane, regardless of how many branches
  // are on screen.
  const angleSlot = (2 * Math.PI) / n;
  const safeSpread = Math.min(MAX_CHILD_SPREAD, angleSlot * 0.42);

  const placed = branches.map((branch, i) => {
    const angle = (2 * Math.PI * i) / n - Math.PI / 2;
    const pos = polar(CX, CY, BRANCH_RADIUS, angle);
    const kids = (branch.children || []).slice(0, maxKidsPerBranch);
    const step = kids.length > 1 ? (2 * safeSpread) / (kids.length - 1) : 0;
    const children = kids.map((label, j) => {
      const offset = kids.length > 1 ? -safeSpread + step * j : 0;
      const childPos = polar(pos.x, pos.y, CHILD_RADIUS, angle + offset);
      return { label, ...childPos };
    });
    return { ...branch, angle, ...pos, children };
  });

  return (
    <div className="relative w-full min-h-[280px] select-none">
      <svg
        viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
        className="w-full h-auto"
        aria-hidden="true"
      >
        {placed.map((branch, i) => (
          <g key={`line-${i}`}>
            <line
              x1={CX}
              y1={CY}
              x2={branch.x}
              y2={branch.y}
              stroke="#2DD4BF"
              strokeOpacity="0.45"
              strokeWidth="1.75"
            />
            {branch.children.map((child, j) => (
              <line
                key={`child-line-${i}-${j}`}
                x1={branch.x}
                y1={branch.y}
                x2={child.x}
                y2={child.y}
                stroke="#10B981"
                strokeOpacity="0.35"
                strokeWidth="1.25"
              />
            ))}
          </g>
        ))}
      </svg>

      <NodeBox x={CX} y={CY} label={data.central || "Topic"} variant="central" />

      {placed.map((branch, i) => (
        <React.Fragment key={`node-${i}`}>
          <NodeBox x={branch.x} y={branch.y} label={branch.label} variant="branch" />
          {branch.children.map((child, j) => (
            <NodeBox
              key={`child-${i}-${j}`}
              x={child.x}
              y={child.y}
              label={child.label}
              variant="child"
            />
          ))}
        </React.Fragment>
      ))}
    </div>
  );
}