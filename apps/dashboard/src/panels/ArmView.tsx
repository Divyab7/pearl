// Schematic side view of the arm (shoulder + elbow as a 2-link arm, base as a dial, gripper as jaws) and the table.
const L1 = 70;
const L2 = 60;

export function ArmView({ joints, scene, ring, label }) {
  const [base, shoulder, elbow, grip] = joints ?? [90, 90, 90, 10];
  // schematic mapping: shoulder 90° = upright, larger = leaning toward the table; elbow 90° = right angle
  const t1 = ((180 - shoulder) * Math.PI) / 180;
  const t2 = t1 - ((180 - elbow) * Math.PI) / 180;
  const sx = 70, sy = 150;
  const ex = sx + L1 * Math.cos(t1), ey = sy - L1 * Math.sin(t1);
  const wx = ex + L2 * Math.cos(t2), wy = ey - L2 * Math.sin(t2);
  const open = Math.max(2, 12 - ((grip - 10) / 70) * 10);
  const nx = Math.cos(t2 - Math.PI / 2), ny = -Math.sin(t2 - Math.PI / 2);
  const baseRad = ((base - 90) * Math.PI) / 180;
  const slots = scene ? ["A1", "A2", "A3"] : [];
  return (
    <svg viewBox="0 0 320 190" className="armview" role="img" aria-label={`arm joints ${joints?.join(", ")}`}>
      <rect x="0" y="160" width="320" height="30" className="table" />
      <rect x={sx - 18} y={sy} width="36" height="12" rx="3" className="base" />
      <line x1={sx} y1={sy} x2={ex} y2={ey} className="link" />
      <line x1={ex} y1={ey} x2={wx} y2={wy} className="link" />
      <circle cx={sx} cy={sy} r="6" className="jointdot" />
      <circle cx={ex} cy={ey} r="5" className="jointdot" />
      <line x1={wx + nx * open} y1={wy + ny * open} x2={wx + nx * open + 10 * Math.cos(t2)} y2={wy + ny * open - 10 * Math.sin(t2)} className="jaw" />
      <line x1={wx - nx * open} y1={wy - ny * open} x2={wx - nx * open + 10 * Math.cos(t2)} y2={wy - ny * open - 10 * Math.sin(t2)} className="jaw" />
      {scene?.holding && <rect x={wx + 8 * Math.cos(t2) - 6} y={wy - 8 * Math.sin(t2) - 6} width="12" height="12" className={`cube ${scene.holding}`} />}
      {slots.map((id, i) => (
        <g key={id} transform={`translate(${170 + i * 34}, 160)`}>
          <rect x="-13" y="-2" width="26" height="4" className="slot" />
          {scene.slots[id] && <rect x="-8" y="-17" width="16" height="15" className={`cube ${scene.slots[id]}`} />}
          <text y="22" className="tiny">{id}</text>
        </g>
      ))}
      {scene && (
        <g transform="translate(285, 160)">
          <path d="M-16 -26 L-12 0 L12 0 L16 -26" className="bin" />
          {scene.bin.map((c, i) => <rect key={i} x={-8 + (i % 2) * 6} y={-14 - Math.floor(i / 2) * 9} width="10" height="9" className={`cube ${c}`} />)}
          <text y="22" className="tiny">BIN</text>
        </g>
      )}
      <g transform="translate(28, 28)">
        <circle r="18" className={`ring ${ring ?? ""}`} />
        <line x1="0" y1="0" x2={14 * Math.sin(baseRad)} y2={-14 * Math.cos(baseRad)} className="dial" />
        <text y="32" className="tiny">base {base}°</text>
      </g>
      {label && <text x="316" y="14" className="tiny" textAnchor="end">{label}</text>}
    </svg>
  );
}

/** Ring state → CSS class for the status light mirror. */
export function ringClass(ring) {
  if (!ring) return "";
  return ring.split(" ")[0];
}
