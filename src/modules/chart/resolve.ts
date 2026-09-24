import { STD_BY_CODE } from "./standard";

type A = { code: string; stdKey: string | null; postable: boolean; active: boolean };

/** Translate a STANDARD code into this file's account (identity for the standard tree, std_key for a client tree). */
export function resolveStd<T extends A>(chart: T[], stdCode: string): T | undefined {
  const key = STD_BY_CODE.get(stdCode)?.std_key ?? null;
  const direct = chart.find((a) => a.code === stdCode && a.postable && (a.stdKey === key || a.stdKey === null && key === null));
  if (direct) return direct;
  if (!key) return undefined;
  return chart.filter((a) => a.stdKey === key && a.postable && a.active).sort((x, y) => x.code.localeCompare(y.code))[0];
}
