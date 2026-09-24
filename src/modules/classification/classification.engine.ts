/**
 * Rule matching is deliberately dumb and predictable: a case-insensitive
 * substring match against either the transaction description or the
 * counterparty name (depending on `ruleKind`). That's the whole point —
 * it's auditable by a human at a glance ("GOSI → Social Insurance"), and
 * it's what accumulates as the firm approves more exceptions over time.
 *
 * Four kinds of rule:
 *   substring      — case-insensitive substring of the description (default)
 *   merchant       — case-insensitive substring of the counterparty name
 *   amount-pattern — description substring AND an exact amount match
 *   beneficiary    — exact match on the payee identity extracted from the
 *                    statement (beneficiary account no. or normalised name).
 *                    One answer about a payee settles every payment to them.
 *
 * Longest matchText wins when multiple rules could apply, so a specific
 * rule ("Muqeem gov fee") beats an accidentally-broad one ("fee").
 */
export type Rule = {
  id: string;
  matchText: string;
  accountId: string;
  ruleKind?: string; // default "substring"
};

export type RuleContext = {
  beneficiaryKey?: string | null;
  description: string;
  counterparty?: string | null;
  amount: number;
};

export function matchRule(ctx: RuleContext, rules: Rule[]): Rule | null {
  const desc = ctx.description.toLowerCase();
  const cp = (ctx.counterparty ?? "").toLowerCase();
  const amount = Math.abs(ctx.amount);

  const candidates = rules.filter((r) => {
    const mt = r.matchText.toLowerCase();
    switch (r.ruleKind ?? "substring") {
      case "beneficiary":
        return !!ctx.beneficiaryKey && ctx.beneficiaryKey.toLowerCase() === mt;
      case "merchant":
        return cp.length > 0 && cp.includes(mt);
      case "amount-pattern":
        return (
          desc.includes(mt) && parseAmountFromRuleText(r.matchText) === amount
        );
      default:
        return desc.includes(mt);
    }
  });

  const priority = (r: Rule) => ((r.ruleKind ?? "substring") === "beneficiary" ? 1 : 0);
  return (
    candidates.sort(
      (a, b) =>
        priority(b) - priority(a) || b.matchText.length - a.matchText.length,
    )[0] ?? null
  );
}

function parseAmountFromRuleText(matchText: string): number | null {
  const m = matchText.match(/amount:([\d.]+)/i);
  return m ? Number(m[1]) : null;
}
