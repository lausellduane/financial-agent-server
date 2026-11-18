export const TOP_MERCHANT_LIMIT = 5;

const NON_SPENDING = new Set(["income", "transfers", "credit-cards"]);

const MONTH_NAMES = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

const CATEGORY_LABELS: Record<string, string> = {
  dining: "Eating out",
  groceries: "Groceries",
  "gas/auto": "Gas/auto",
  shopping: "Shopping",
  "entertainment/events": "Entertainment",
  subscriptions: "Subscriptions",
  "utilities/telecom": "Utilities",
  healthcare: "Healthcare",
  "insurance/health": "Health insurance",
  "insurance/auto": "Car insurance",
  "cloud/software": "Cloud/software",
  home: "Home",
  "housing/mortgage": "Housing",
  other: "Other",
  unknown: "Other",
};

export type SpendEvent = {
  date: string;
  merchant: string;
  spendCents: number;
  category: string;
};

export type CategorySpend = {
  name: string;
  cents: number;
};

export type MerchantSpend = {
  name: string;
  cents: number;
};

export type MonthSpend = {
  month: string;
  label: string;
  totalCents: number;
  categories: CategorySpend[];
  topMerchants: MerchantSpend[];
  biggestPurchase: MerchantSpend | null;
  diningCents: number;
};

export function isSpendingCategory(category: string): boolean {
  return !NON_SPENDING.has(category);
}

export function displayCategory(category: string): string {
  if (!category) return "Other";
  return CATEGORY_LABELS[category] ?? category;
}

export function monthKey(date: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  return date.slice(0, 7);
}

export function monthLabel(month: string): string {
  const year = month.slice(0, 4);
  const index = Number(month.slice(5, 7)) - 1;
  const name = MONTH_NAMES[index];
  return name ? `${name} ${year}` : month;
}

export function previousMonthKey(month: string): string {
  const year = Number(month.slice(0, 4));
  const number = Number(month.slice(5, 7));
  if (number === 1) return `${year - 1}-12`;
  return `${year}-${String(number - 1).padStart(2, "0")}`;
}

type MonthBucket = {
  totalCents: number;
  diningCents: number;
  categories: Map<string, number>;
  merchants: Map<string, number>;
  biggest: MerchantSpend | null;
};

function emptyBucket(): MonthBucket {
  return {
    totalCents: 0,
    diningCents: 0,
    categories: new Map(),
    merchants: new Map(),
    biggest: null,
  };
}

function sortCategories(map: Map<string, number>): CategorySpend[] {
  const rows = [...map.entries()]
    .filter(([, cents]) => cents !== 0)
    .map(([name, cents]) => ({ name, cents }));
  const rest = rows
    .filter((row) => row.name !== "Other")
    .sort((a, b) => b.cents - a.cents || a.name.localeCompare(b.name));
  const other = rows.filter((row) => row.name === "Other");
  return [...rest, ...other];
}

export function buildMonthlySpend(events: SpendEvent[]): MonthSpend[] {
  const byMonth = new Map<string, MonthBucket>();

  for (const event of events) {
    if (!isSpendingCategory(event.category)) continue;
    const key = monthKey(event.date);
    if (!key) continue;
    let bucket = byMonth.get(key);
    if (!bucket) {
      bucket = emptyBucket();
      byMonth.set(key, bucket);
    }
    bucket.totalCents += event.spendCents;
    if (event.category === "dining") bucket.diningCents += event.spendCents;
    const categoryName = displayCategory(event.category);
    bucket.categories.set(
      categoryName,
      (bucket.categories.get(categoryName) ?? 0) + event.spendCents,
    );
    const merchant = event.merchant.trim() || "Unknown merchant";
    bucket.merchants.set(
      merchant,
      (bucket.merchants.get(merchant) ?? 0) + event.spendCents,
    );
    if (
      event.spendCents > 0 &&
      (bucket.biggest === null || event.spendCents > bucket.biggest.cents)
    ) {
      bucket.biggest = { name: merchant, cents: event.spendCents };
    }
  }

  return [...byMonth.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([month, bucket]) => ({
      month,
      label: monthLabel(month),
      totalCents: bucket.totalCents,
      categories: sortCategories(bucket.categories),
      topMerchants: [...bucket.merchants.entries()]
        .filter(([, cents]) => cents !== 0)
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .slice(0, TOP_MERCHANT_LIMIT)
        .map(([name, cents]) => ({ name, cents })),
      biggestPurchase: bucket.biggest,
      diningCents: bucket.diningCents,
    }));
}
