import type { Account } from "@prisma/client";
import { STANDARD, STD_BY_CODE, codeForActivity, type SeedOption } from "@/modules/chart/standard";
import { resolveStd } from "@/modules/chart/resolve";

/**
 * The accountant's multiple-choice questions (coa_seed.json → questions[]),
 * resolved against ONE file's chart. Every option is already bound to an
 * account or an action, so answering is one tap; the three universal options
 * (another account · split · defer to suspense) are always appended (§3).
 */
export type QuestionAccount = { id: string; code: string; name: string; nameAr: string | null };
export type ResolvedOption = {
  label: string;
  kind: "account" | "choose" | "next" | "split" | "pick" | "defer";
  account?: QuestionAccount;          // kind = account
  choices?: QuestionAccount[];        // kind = choose
  nextQuestionId?: string;            // kind = next
  pickType?: string;                  // kind = pick (limit the picker to this account type)
  universal?: boolean;
};
export type ResolvedQuestion = { questionId: string; caseAr: string; textAr: string; options: ResolvedOption[] };

const qa = (a: Pick<Account, "id" | "code" | "name" | "nameAr">): QuestionAccount => ({ id: a.id, code: a.code, name: a.name, nameAr: a.nameAr });

function resolveOption(o: SeedOption, chart: Account[], activity: string): ResolvedOption | null {
  const acct = (std: string) => resolveStd(chart, std);
  if (o.code_by_activity) {
    const a = acct(codeForActivity(o.code_by_activity, activity));
    return a ? { label: o.label, kind: "account", account: qa(a) } : { label: o.label, kind: "pick", pickType: "REVENUE" };
  }
  if (o.code) { const a = acct(o.code); return a ? { label: o.label, kind: "account", account: qa(a) } : { label: o.label, kind: "pick" }; }
  if (o.choose_from) {
    const list = o.choose_from.map(acct).filter((a): a is Account => !!a).map(qa);
    return list.length ? { label: o.label, kind: "choose", choices: list } : { label: o.label, kind: "pick" };
  }
  if (o.next_question) return { label: o.label, kind: "next", nextQuestionId: o.next_question };
  if (o.split) return { label: o.label, kind: "split" };
  if (o.pick_account) return { label: o.label, kind: "pick", pickType: (o.pick_account as { type?: string }).type?.toUpperCase() };
  return null;
}

export function buildQuestion(questionId: string, chart: Account[], activity: string): ResolvedQuestion {
  const q = STANDARD.questions.find((x) => x.question_id === questionId) ?? STANDARD.questions.find((x) => x.question_id === "Q02")!;
  const options = q.options.map((o) => resolveOption(o, chart, activity)).filter((o): o is ResolvedOption => !!o);
  for (const u of STANDARD.universal_options) {
    if (u.pick_account) options.push({ label: u.label, kind: "pick", universal: true });
    else if ((u as { split_free?: boolean }).split_free) options.push({ label: u.label, kind: "split", universal: true });
    else if (u.code) options.push({ label: u.label, kind: "defer", universal: true });
  }
  return { questionId: q.question_id, caseAr: q.case_ar, textAr: q.text_ar, options };
}

export { STD_BY_CODE };
