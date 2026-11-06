// Schematic side view of the arm (shoulder + elbow as a 2-link arm, a palm with two fingers that open with the
// gripper angle) on a full-width table, with the slots and the bin. Joint readouts sit in a caption row, not in the
// drawing, so every label uses the UI type scale.
const L1 = 70;
const L2 = 60;

export function ArmView({ joints, scene, ring, label, showAngles = true }: { joints?: number[] | null; scene?: any; ring?: string; label?: string; showAngles?: boolean }) {
  const [base, shoulder, elbow, grip] = joints ?? [90, 90, 90, 10];
  // schematic mapping: shoulder 90° = upright, larger = leaning toward the table; elbow 90° = right angle
  const t1 = ((180 - shoulder!) * Math.PI) / 180;
  const t2 = t1 - ((180 - elbow!) * Math.PI) / 180;
  const sx = 80, sy = 148;
  const ex = sx + L1 * Math.cos(t1), ey = sy - L1 * Math.sin(t1);
  const wx = ex + L2 * Math.cos(t2), wy = ey - L2 * Math.sin(t2);
  const ux = Math.cos(t2), uy = -Math.sin(t2); // along the forearm
  const nx = Math.cos(t2 - Math.PI / 2), ny = -Math.sin(t2 - Math.PI / 2); // across it
  const open = Math.max(3, 11 - ((grip! - 10) / 70) * 8); // finger half-gap
  const palm = 9;
  const finger = 13;
  const p1 = { x: wx + nx * palm, y: wy + ny * palm };
  const p2 = { x: wx - nx * palm, y: wy - ny * palm };
  const f1 = { x: wx + nx * open, y: wy + ny * open };
  const f2 = { x: wx - nx * open, y: wy - ny * open };
  const slots = scene ? ["A1", "A2", "A3"] : [];
  return (
    <figure className="armfig">
      <figcaption className="armcap">
        <span>{label}</span>
        {showAngles && <span className="tabular">Base {base}° · Shoulder {shoulder}° · Elbow {elbow}° · Gripper {grip}°</span>}
      </figcaption>
      <svg viewBox="0 0 320 175" className="armview" role="img" aria-label={`Arm: base ${base}°, shoulder ${shoulder}°, elbow ${elbow}°, gripper ${grip}°`} preserveAspectRatio="xMidYMax meet">
        <rect x="0" y="158" width="320" height="17" className="table" />
        <rect x={sx - 20} y={sy} width="40" height="10" rx="3" className="base" />
        {ring && <rect x={sx - 20} y={sy + 7} width="40" height="3" rx="1.5" className={`ringbar ${ring}`} />}
        <line x1={sx} y1={sy} x2={ex} y2={ey} className="link" />
        <line x1={ex} y1={ey} x2={wx} y2={wy} className="link" />
        <line x1={p1.x} y1={p1.y} x2={p2.x} y2={p2.y} className="palm" />
        <polyline points={`${p1.x},${p1.y} ${f1.x + ux * 3},${f1.y + uy * 3} ${f1.x + ux * finger},${f1.y + uy * finger}`} className="finger" />
        <polyline points={`${p2.x},${p2.y} ${f2.x + ux * 3},${f2.y + uy * 3} ${f2.x + ux * finger},${f2.y + uy * finger}`} className="finger" />
        <circle cx={sx} cy={sy} r="6" className="jointdot" />
        <circle cx={ex} cy={ey} r="5" className="jointdot" />
        <circle cx={wx} cy={wy} r="3.5" className="jointdot" />
        {scene?.holding && <rect x={wx + ux * 9 - 6} y={wy + uy * 9 - 6} width="12" height="12" rx="1.5" className={`cube ${scene.holding}`} />}
        {slots.map((id, i) => (
          <g key={id} transform={`translate(${178 + i * 34}, 158)`}>
            <rect x="-12" y="-3" width="24" height="3" className="slot" />
            {scene.slots[id] && <rect x="-8" y="-19" width="16" height="16" rx="1.5" className={`cube ${scene.slots[id]}`} />}
            <text y="13" className="tiny">{id}</text>
          </g>
        ))}
        {scene && (
          <g transform="translate(290, 158)">
            <path d="M-17 -28 L-13 0 L13 0 L17 -28" className="bin" />
            {scene.bin.map((c: string, i: number) => <rect key={i} x={-8 + (i % 2) * 6} y={-14 - Math.floor(i / 2) * 9} width="11" height="10" rx="1.5" className={`cube ${c}`} />)}
            <text y="13" className="tiny">BIN</text>
          </g>
        )}
      </svg>
    </figure>
  );
}

/** Ring state → CSS class for the status light mirror. */
export function ringClass(ring?: string) {
  if (!ring) return "";
  return ring.split(" ")[0];
}
