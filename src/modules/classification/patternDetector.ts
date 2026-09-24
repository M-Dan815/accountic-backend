/**
 * Pattern detector for grouped, unclassified transactions.
 *
 * WHY THIS EXISTS — the spec said:
 *   "Uncertain statements should be grouped by the AI based on certain
 *    pattern recognition like you made this transaction to the same account
 *    at the same time of month for example as well."
 *
 * The spec also said the AI should be the one deciding — and it should be.
 * BUT: the AI must NOT be the one staring at Arabic PDF text, because PDF
 * structure varies per bank and regex-style recognition on raw text is
 * fragile. The architecture that resolves this tension is the same one the
 * classifier already uses (see statementEnricher.ts + classify-case.ts):
 *
 *   deterministic signal extraction  →  AI interpretation  →  deterministic fallback
 *
 * This file is the FIRST step — the deterministic signal extraction. It
 * operates on BankTransaction rows that have ALREADY been extracted and
 * enriched. By this point in the pipeline, every row has a parsed `date`,
 * a signed `amount`, a stable `beneficiaryKey`, and a structured
 * `enrichment.kind` / `enrichment.counterpartyType` / `enrichment.memo`.
 * None of that depends on the original PDF layout or its language — the
 * extraction layer has already normalised it.
 *
 * Output is a `DetectedPattern` block that gets fed to the AI
 * question-generator (see ai-provider.ts → suggestClarificationQuestion).
 * The AI never sees the PDF; it sees these structured signals and decides
 * what to ask the client and which account to hypothesise.
 *
 * Pure functions, no DB, no network — unit-testable.
 */

export type PatternDetectorInput = {
  id: string;
  date: Date;
  /** Negative = outflow, positive = inflow. */
  amount: number;
  enrichment?: {
    kind?: string | null;
    counterpartyType?: string | null;
    memo?: string | null;
  } | null;
  counterparty?: string | null;
  description?: string | null;
};

export type DetectedPattern = {
  /** True iff a stable cadence + same day-of-month is observed. */
  recurring: boolean;
  cadence: "monthly" | "weekly" | "quarterly" | null;
  /** Day of month (1–31). `allSame` allows ±1 tolerance (e.g. day 30/1/2). */
  dayOfMonth: { min: number; max: number; allSame: boolean } | null;
  /** Amount variance across the group. */
  amountRange: {
    min: number;
    max: number;
    variancePct: number;
    allSimilar: boolean;
  } | null;
  direction: "inflow" | "outflow";
  counterpartyType:
    | "company"
    | "person"
    | "self"
    | "government"
    | "unknown"
    | null;
  occurrenceCount: number;
  firstDate: string;
  lastDate: string;
  totalAbsAmount: number;
  /** Short summary, e.g. "5 monthly outflows on day 1, ~4,850 SAR each". */
  summary: string;
};

// ── Tunables ────────────────────────────────────────────────────────────
// Conservative thresholds. We want recurring patterns to be OBVIOUS before
// we let the AI propose "this is salaries" — a false positive here means
// the client sees a misleading question. False negatives just fall through
// to the generic template question, which is safe.
const MIN_OCCURRENCES = 2;
const DAY_OF_MONTH_TOLERANCE = 1; // day 30 / day 1 (next month) treated as same
const AMOUNT_VARIANCE_THRESHOLD_PCT = 5; // ≤5% variance = "similar"
const CADENCE_PASS_RATIO = 0.7; // 70% of gaps must fit the cadence

const MONTHLY_MIN_DAYS = 25;
const MONTHLY_MAX_DAYS = 35;
const WEEKLY_MIN_DAYS = 5;
const WEEKLY_MAX_DAYS = 8;
const QUARTERLY_MIN_DAYS = 80;
const QUARTERLY_MAX_DAYS = 100;

const MS_PER_DAY = 1000 * 60 * 60 * 24;

export function detectPattern(
  txns: PatternDetectorInput[],
): DetectedPattern | null {
  if (txns.length < MIN_OCCURRENCES) return null;

  const sorted = [...txns].sort(
    (a, b) => a.date.getTime() - b.date.getTime(),
  );
  const direction = sorted[0].amount < 0 ? "outflow" : "inflow";
  const abs = sorted.map((t) => Math.abs(t.amount));

  // Day-of-month analysis (with ±1 tolerance to absorb weekend / holiday drift)
  const days = sorted.map((t) => t.date.getDate());
  const dayMin = Math.min(...days);
  const dayMax = Math.max(...days);
  const dayAllSame = dayMax - dayMin <= DAY_OF_MONTH_TOLERANCE;

  // Amount analysis
  const aMin = Math.min(...abs);
  const aMax = Math.max(...abs);
  const variancePct = aMax > 0 ? ((aMax - aMin) / aMax) * 100 : 0;
  const amountAllSimilar = variancePct <= AMOUNT_VARIANCE_THRESHOLD_PCT;

  // Cadence: gaps between consecutive transactions in days
  const gaps: number[] = [];
  for (let i = 1; i < sorted.length; i++) {
    gaps.push((sorted[i].date.getTime() - sorted[i - 1].date.getTime()) / MS_PER_DAY);
  }

  let cadence: DetectedPattern["cadence"] = null;
  if (gaps.length > 0) {
    const monthlyHits = gaps.filter(
      (g) => g >= MONTHLY_MIN_DAYS && g <= MONTHLY_MAX_DAYS,
    ).length;
    const weeklyHits = gaps.filter(
      (g) => g >= WEEKLY_MIN_DAYS && g <= WEEKLY_MAX_DAYS,
    ).length;
    const quarterlyHits = gaps.filter(
      (g) => g >= QUARTERLY_MIN_DAYS && g <= QUARTERLY_MAX_DAYS,
    ).length;
    if (monthlyHits / gaps.length >= CADENCE_PASS_RATIO) cadence = "monthly";
    else if (weeklyHits / gaps.length >= CADENCE_PASS_RATIO) cadence = "weekly";
    else if (quarterlyHits / gaps.length >= CADENCE_PASS_RATIO)
      cadence = "quarterly";
  }

  // Counterparty type — most common across the group
  const cpTypes = sorted
    .map((t) => t.enrichment?.counterpartyType)
    .filter((x): x is string => !!x);
  const counterpartyType = cpTypes.length
    ? (mostFrequent(cpTypes) as DetectedPattern["counterpartyType"])
    : null;

  // Recurring = stable cadence + stable day-of-month. (We do NOT require
  // amount similarity for "recurring" — salaries vary ±50 SAR all the time.
  // The amount similarity is a separate signal the AI can use.)
  const recurring = cadence !== null && dayAllSame;

  return {
    recurring,
    cadence,
    dayOfMonth: { min: dayMin, max: dayMax, allSame: dayAllSame },
    amountRange: {
      min: aMin,
      max: aMax,
      variancePct,
      allSimilar: amountAllSimilar,
    },
    direction,
    counterpartyType,
    occurrenceCount: sorted.length,
    firstDate: sorted[0].date.toISOString().slice(0, 10),
    lastDate: sorted[sorted.length - 1].date.toISOString().slice(0, 10),
    totalAbsAmount: abs.reduce((a, b) => a + b, 0),
    summary: buildSummary({
      count: sorted.length,
      cadence,
      dayAllSame,
      dayMin,
      direction,
      aMin,
      aMax,
      amountAllSimilar,
    }),
  };
}

function mostFrequent<T>(arr: T[]): T | null {
  if (arr.length === 0) return null;
  const counts = new Map<T, number>();
  for (const x of arr) counts.set(x, (counts.get(x) ?? 0) + 1);
  let best: T | null = null;
  let bestN = 0;
  for (const [k, v] of counts) {
    if (v > bestN) {
      best = k;
      bestN = v;
    }
  }
  return best;
}

function buildSummary(args: {
  count: number;
  cadence: DetectedPattern["cadence"];
  dayAllSame: boolean;
  dayMin: number;
  direction: "inflow" | "outflow";
  aMin: number;
  aMax: number;
  amountAllSimilar: boolean;
}): string {
  const dir = args.direction === "outflow" ? "outflow" : "inflow";
  const cadenceLabel =
    args.cadence === "monthly"
      ? "monthly"
      : args.cadence === "weekly"
        ? "weekly"
        : args.cadence === "quarterly"
          ? "quarterly"
          : "irregular";
  const dayClause = args.dayAllSame ? `on day ${args.dayMin}` : "on varied days";
  const amtClause = args.amountAllSimilar
    ? `~${args.aMin.toLocaleString()} SAR each`
    : `${args.aMin.toLocaleString()}–${args.aMax.toLocaleString()} SAR`;
  return `${args.count} ${cadenceLabel} ${dir}s ${dayClause}, ${amtClause}`;
}
