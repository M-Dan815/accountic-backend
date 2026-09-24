import {
  CLIENT_NAME_NORM_RE,
  type Enrichment,
} from "@/modules/extraction/statementEnricher";

export const CONF = { HIGH: 0.9, MEDIUM: 0.75, LOW: 0.55 } as const;

export type AccountRole =
  | "BANK_FEE"
  | "OTHER_EXPENSE"
  | "HOSPITALITY"
  | "TRANSPORT"
  | "SUBSCRIPTIONS"
  | "SALARIES"
  | "RELATED_PARTY"
  | "GOV_FEES"
  | "RESIDENCY"
  | "RENT"
  | "MARKETING"
  | "FREIGHT"
  | "FINANCE_COST"
  | "PREPAID_INSURANCE"
  | "OTHER_INCOME"
  | "RECEIVABLES"
  | "OWN_ACCOUNT_TRANSFER"
  | "FINES"
  | "WATER"
  | "EWALLET";

export const DEFAULT_ROLE_CODES: Record<AccountRole, string> = {
  BANK_FEE: "540102",
  OTHER_EXPENSE: "530901",
  HOSPITALITY: "530703",
  TRANSPORT: "530601",
  SUBSCRIPTIONS: "530402",
  SALARIES: "530101",
  RELATED_PARTY: "110301",
  GOV_FEES: "530206",
  RESIDENCY: "530201",
  RENT: "530301",
  MARKETING: "520101",
  FREIGHT: "510103",
  FINANCE_COST: "540101",
  PREPAID_INSURANCE: "110502",
  OTHER_INCOME: "420107",
  RECEIVABLES: "110201",
  OWN_ACCOUNT_TRANSFER: "110802",
  FINES: "530903",
  WATER: "530304",
  EWALLET: "110109",
};

export type HeuristicResult =
  | {
      decision: "CLASSIFY";
      role: AccountRole;
      confidence: number;
      reason: string;
    }
  | { decision: "PENDING"; reason: string };

export type ClassifierContext = { knownCustomers?: string[] };

const has = (text: string, ...needles: string[]) =>
  needles.some((n) => text.includes(n));
const classify = (
  role: AccountRole,
  confidence: number,
  reason: string,
): HeuristicResult => ({ decision: "CLASSIFY", role, confidence, reason });

const FUEL = [
  "petrol",
  "ptrole",
  "petrole",
  "aldrees",
  "الدريس",
  "sasco",
  "petromin",
  "adnoc",
  "وقود",
  "بنزين",
  "البتروليه",
  "محطه وقود",
  "tas-hilat",
  "tashilat",
];
const CAR_MAINT = [
  "غيار",
  "زيت",
  "صيانه",
  "سمكر",
  "بطاري",
  "اطار",
  "ورشه",
  "فرامل",
  "ميكانيك",
];
const FOOD = [
  "restaur",
  "resturan",
  "resta",
  "cafe",
  "coffee",
  "roaster",
  "food",
  "bakery",
  "bakeri",
  "kitchen",
  "burger",
  "shawarma",
  "pizza",
  "juice",
  "sweets",
  "catering",
  "kebab",
  "grill",
  "tandoor",
  "مطعم",
  "كافيه",
  "مقهى",
  "مخبز",
  "حلويات",
  "عصير",
  "شاورما",
];
const FOOD_PLATFORMS = [
  "foodics",
  "toyou",
  "jahez",
  "hungerstation",
  "talabat",
  "keeta",
  "mrsool",
];
const TELECOM_SOFTWARE = [
  "qoyod",
  "zain",
  "mobily",
  "stc",
  "salam",
  "otoglobal",
  "agmt",
  "google",
  "microsoft",
  "zoom",
  "canva",
  "openai",
  "shopify",
];
const PERSONAL_GOODS = ["tobacco", "دخان", "shisha", "معسل"];
const WATER_UTILITY = ["alliance water", "water co", "مياه", "ميه", "water"];
const INVESTMENT = ["استثمار", "استثمارات", "investment", "investments"];

export function classifyFromStatement(
  e: Enrichment,
  amount: number,
  ctx: ClassifierContext = {},
): HeuristicResult | null {
  // Combine searchText and memo to ensure we don't miss keywords placed in the memo field.
  const textToCheck = (e.searchText + " " + (e.memo ?? "")).toLowerCase();
  const outflow = amount < 0;

  if (e.isFee)
    return classify("BANK_FEE", CONF.HIGH, "Bank transfer fee (رسوم حوالة)");

  if (e.isSelfTransfer && outflow) {
    if (has(textToCheck, "عموله تمويل"))
      return classify(
        "FINANCE_COST",
        CONF.MEDIUM,
        "Transfer to own account memo'd as financing commission",
      );
    if (has(textToCheck, "قسط", "تمويل", "قرض", "سداد"))
      return classify(
        "OWN_ACCOUNT_TRANSFER",
        CONF.HIGH,
        "Transfer to the firm's own name with an instalment/financing memo",
      );
    return classify(
      "OWN_ACCOUNT_TRANSFER",
      CONF.MEDIUM,
      "Transfer to the firm's own name — internal transfer",
    );
  }

  if (e.kind === "SADAD_PAYMENT") {
    if (
      has(textToCheck, "المخالفات المروريه", "violation number", "traffic law")
    )
      return classify("FINES", CONF.MEDIUM, "Traffic fine paid via SADAD");
    if (has(textToCheck, "خدمات المقيمين"))
      return classify(
        "RESIDENCY",
        CONF.HIGH,
        "SADAD residents-services payment (iqama)",
      );
    return classify("GOV_FEES", CONF.MEDIUM, "SADAD government bill payment");
  }
  if (e.kind === "SADAD_REFUND")
    return classify("GOV_FEES", CONF.MEDIUM, "SADAD refund");

  if (e.kind === "ONLINE_PURCHASE" || e.kind === "PURCHASE_REFUND") {
    const refund = e.kind === "PURCHASE_REFUND";
    const why = (s: string) => (refund ? `Refund of ${s}` : s);
    if (has(textToCheck, "hrsd"))
      return classify("RESIDENCY", CONF.HIGH, why("HRSD online payment"));
    if (has(textToCheck, "ejar"))
      return classify("RENT", CONF.MEDIUM, why("Payment via Ejar platform"));
    if (has(textToCheck, "stc pay"))
      return classify("EWALLET", CONF.MEDIUM, why("STC Pay wallet"));
    if (has(textToCheck, "sbc mof", "mof"))
      return classify(
        "GOV_FEES",
        CONF.MEDIUM,
        why("Ministry of Finance payment"),
      );
    if (FUEL.some((f) => textToCheck.includes(f)))
      return classify("TRANSPORT", CONF.MEDIUM, why("Fuel purchase"));
    if (FOOD_PLATFORMS.some((f) => textToCheck.includes(f)))
      return classify(
        "HOSPITALITY",
        CONF.MEDIUM,
        why("Food ordering platform"),
      );
    if (TELECOM_SOFTWARE.some((f) => textToCheck.includes(f)))
      return classify(
        "SUBSCRIPTIONS",
        CONF.MEDIUM,
        why("Telecom / software subscription"),
      );
    if (WATER_UTILITY.some((f) => textToCheck.includes(f)))
      return classify("WATER", CONF.MEDIUM, why("Water utility purchase"));
    return null;
  }

  if (e.kind === "POS_PURCHASE" && outflow) {
    if (PERSONAL_GOODS.some((p) => textToCheck.includes(p)))
      return classify(
        "RELATED_PARTY",
        CONF.MEDIUM,
        "Purchase of an evidently personal nature",
      );
    if (FUEL.some((f) => textToCheck.includes(f)))
      return classify("TRANSPORT", CONF.MEDIUM, "Fuel station purchase");
    if (FOOD.some((f) => textToCheck.includes(f)))
      return classify(
        "HOSPITALITY",
        CONF.MEDIUM,
        "Restaurant / café / food merchant",
      );
    return null;
  }

  if (e.kind === "ATM_WITHDRAWAL") return null;
  if (e.kind === "ATM_DEPOSIT") return null;

  if (e.kind === "INTERNAL_TRANSFER_IN")
    return classify(
      "RELATED_PARTY",
      CONF.MEDIUM,
      "Internal transfer from an individual's account",
    );

  if (e.kind === "TRANSFER_OUT") {
    if (has(textToCheck, ...INVESTMENT))
      return {
        decision: "PENDING",
        reason:
          "Cheque/transfer memo'd as استثمار (investment) — needs clarification",
      };

    // Robust check for loan repayments and domain purchases
    if (has(textToCheck, "سداد القرض", "سداد اقساط", "اقساط مستحقه", "تمويل"))
      return classify(
        "FINANCE_COST",
        CONF.HIGH,
        "Transfer memo explicitly mentions loan/financing repayment",
      );
    if (has(textToCheck, "دومين", "domain", "hosting", "استضافة"))
      return classify(
        "SUBSCRIPTIONS",
        CONF.HIGH,
        "Transfer memo mentions domain/IT infrastructure purchase",
      );

    if (has(textToCheck, "راتب", "رواتب", "salary"))
      return classify("SALARIES", CONF.HIGH, "Transfer memo says salary");
    if (FUEL.some((f) => textToCheck.includes(f)))
      return classify("TRANSPORT", CONF.HIGH, "Transfer to a fuel supplier");
    if (CAR_MAINT.some((f) => textToCheck.includes(f)))
      return classify("TRANSPORT", CONF.MEDIUM, "Vehicle maintenance");
    if (has(textToCheck, "ايجار"))
      return classify("RENT", CONF.MEDIUM, "Transfer memo mentions rent");
    if (has(textToCheck, "تسويق", "اعلان", "دعايه"))
      return classify("MARKETING", CONF.MEDIUM, "Transfer memo says marketing");
    if (has(textToCheck, "توصيل", "شحن", "طرود"))
      return classify("FREIGHT", CONF.MEDIUM, "Transfer memo says delivery");
    if (has(textToCheck, "تامين"))
      return classify(
        "PREPAID_INSURANCE",
        CONF.MEDIUM,
        "Transfer to an insurer",
      );
    if (has(textToCheck, "اشتراك"))
      return classify(
        "SUBSCRIPTIONS",
        CONF.MEDIUM,
        "Transfer memo says subscription",
      );
    if (has(textToCheck, "مصروف", "مصاريف", "مصروفات", "شراء")) return null;

    if (e.counterpartyType === "person" || !e.counterparty || !e.memo)
      return null;
    return null;
  }

  if (e.kind === "TRANSFER_IN") {
    const tIn = e.searchText.replace(CLIENT_NAME_NORM_RE, " ");
    if (has(tIn, "assurance", "insurance", "تعاوني", "تامين"))
      return classify("OTHER_INCOME", CONF.MEDIUM, "Insurer payout");
    const cp = (e.counterparty ?? "").toLowerCase();
    const cpNorm = cp.replace(/\s+/g, " ");
    if (
      ctx.knownCustomers?.some(
        (c) => c && (tIn.includes(c) || cpNorm.includes(c)),
      )
    )
      return classify(
        "RECEIVABLES",
        CONF.HIGH,
        "Incoming payment from a customer",
      );
    if (e.counterpartyType === "self")
      return {
        decision: "PENDING",
        reason: "Incoming transfer under the firm's own name",
      };
    if (
      e.counterpartyType === "company" ||
      has(tIn, "شركه", "logistics", "company")
    )
      return classify(
        "RECEIVABLES",
        CONF.MEDIUM,
        "Incoming payment from a named company",
      );
    return null;
  }

  return null;
}
