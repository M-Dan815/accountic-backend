import { normalizeText } from "@/lib/arabic";
import type { Role } from "./types";

const has = (n: string, re: RegExp) => re.test(n);
const DEBIT = /(^|\s)(مدين|المدين|DEBIT|DEBITS|DR)(\s|$)/;
const CREDIT = /(^|\s)(داين|الداين|CREDIT|CREDITS|CR)(\s|$)/; // NB: patterns run on NORMALISED text (ئ→ي)
const OPEN = /افتتاح|OPENING|BEGINNING|INITIAL|BROUGHT|BAL B\/F|بدايه/;
const CLOSE = /ختامي|ختام|اقفال|نهايه|CLOSING|ENDING|END BAL|BAL C\/D|END OF/;
const MOVE = /حركه|حركات|MOVEMENT|ACTIVITY|TRANSACTIONS|DURING|PERIOD/;
const NET = /صافي الحركه|صافي الحركات|NET MOVEMENT|NET CHANGE|NET ACTIVITY/;
const CODE = /رقم الحساب|رمز الحساب|كود الحساب|رمز|كود|الرقم|ACCOUNT (NUMBER|NO|ID|CODE)|^CODE$|^ACCT|^NO\.?$|^#$|^ID$|A\/C (NO|CODE)/;
const NAME = /اسم الحساب|اسم|البيان|الحساب|ACCOUNT NAME|^ACCOUNT$|^NAME$|DESCRIPTION|A\/C NAME|^TITLE$/;
const BAL = /رصيد|BALANCE|^NET$|الصافي|صافي/;
const TYPE = /^(النوع|نوع الحساب|TYPE|ACCOUNT TYPE)$/;
const PARENT = /(الحساب الاب|الحساب الرئيسي|الاب|PARENT)/;

export function roleOfLabel(label: string): Role {
  const n = normalizeText(label);
  if (!n) return "ignore";
  const d = has(n, DEBIT), c = has(n, CREDIT);
  if (has(n, NET) && (d || c)) return d ? "net_debit" : "net_credit";
  if (has(n, NET)) return "ignore";
  if (has(n, OPEN)) return d ? "opening_debit" : c ? "opening_credit" : "opening_balance";
  if (has(n, CLOSE)) return d ? "closing_debit" : c ? "closing_credit" : "closing_balance";
  if (has(n, MOVE) && (d || c)) return d ? "movement_debit" : "movement_credit";
  if (has(n, MOVE)) return "ignore";
  if (d && !c) return "debit";
  if (c && !d) return "credit";
  if (has(n, PARENT)) return "parent";
  if (has(n, TYPE)) return "type";
  if (has(n, CODE)) return "code";
  if (has(n, NAME)) return "name";
  if (has(n, BAL)) return "balance";
  return "ignore";
}

/** Composite label of a column from stacked header rows ("الرصيد الافتتاحي" + "مدين"). */
export function composeLabel(parts: string[]): string {
  const seen: string[] = [];
  for (const p of parts.map((x) => String(x ?? "").trim()).filter(Boolean)) {
    if (!seen.some((s) => normalizeText(s) === normalizeText(p))) seen.push(p);
  }
  return seen.join(" ");
}

export const AMOUNT_ROLES: Role[] = [
  "opening_debit", "opening_credit", "opening_balance", "movement_debit", "movement_credit",
  "net_debit", "net_credit", "closing_debit", "closing_credit", "closing_balance", "debit", "credit", "balance",
];
