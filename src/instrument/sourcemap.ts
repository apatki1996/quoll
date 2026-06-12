import type { RawSourceMap } from "../../protocol/index.ts";

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const CHAR_TO_INT = new Map<string, number>([...B64].map((c, i) => [c, i]));

/** Decode one VLQ segment ("AAKA") into its delta fields. */
function decodeVlq(segment: string): number[] {
  const fields: number[] = [];
  let value = 0;
  let shift = 0;
  for (const char of segment) {
    const digit = CHAR_TO_INT.get(char);
    if (digit === undefined) throw new Error(`bad VLQ char: ${char}`);
    // arithmetic, not bitwise: column deltas can exceed 32-bit `<<`/`>>>` range
    value += (digit & 0x1f) * 2 ** shift;
    if (digit & 0x20) {
      shift += 5;
    } else {
      fields.push(value % 2 === 1 ? -Math.floor(value / 2) : value / 2);
      value = 0;
      shift = 0;
    }
  }
  return fields;
}

/**
 * generated line (1-based) -> original source line (1-based), using each
 * generated line's first mapped segment. Line-level is all phases 2–3 need;
 * column accuracy starts mattering with phase 4's expression-level sites.
 */
export function buildLineMap(map: RawSourceMap): Map<number, number> {
  const result = new Map<number, number>();
  let srcLine = 0;
  const genLines = map.mappings.split(";");
  for (let genLine = 0; genLine < genLines.length; genLine++) {
    const line = genLines[genLine];
    if (!line) continue;
    for (const segment of line.split(",")) {
      if (!segment) continue;
      const fields = decodeVlq(segment);
      if (fields.length >= 4) {
        srcLine += fields[2]!;
        if (!result.has(genLine + 1)) result.set(genLine + 1, srcLine + 1);
      }
    }
  }
  return result;
}
