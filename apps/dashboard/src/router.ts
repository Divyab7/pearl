import { useEffect, useState } from "react";

/** Hash routes: #/, #/robot/<tab>/<run>, #/insurer/<claim>, #/verify/<run>. */
export function useRoute(): string[] {
  const [h, setH] = useState(location.hash);
  useEffect(() => {
    const f = () => setH(location.hash);
    addEventListener("hashchange", f);
    return () => removeEventListener("hashchange", f);
  }, []);
  return h.replace(/^#\/?/, "").split("/").filter(Boolean).map(decodeURIComponent);
}

export const href = (...parts: (string | null | undefined)[]) => `#/${parts.filter(Boolean).map((p) => encodeURIComponent(p!)).join("/")}`;
export const go = (...parts: (string | null | undefined)[]) => {
  location.hash = href(...parts);
};
