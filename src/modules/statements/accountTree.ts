/**
 * Groups postable accounts into the same nested section structure the
 * firm's real financial statements use — built and validated directly
 * against Meshal's real Income Statement / Balance Sheet PDFs.
 *
 * Key finding from those real files: the CoA export's own "Parent Account
 * code" column is only reliably populated from the 4-digit level down
 * (e.g. 4101's parent is "41", 520802's parent is "5208") — the top-level
 * 1- and 2-digit section rows (1, 11, 41, 51, 52, 31, 34...) mostly have a
 * BLANK parent in the export itself, even though the real statements
 * clearly nest them (Balance Sheet wraps everything in "1 - الأصول"; the
 * Income Statement does NOT wrap in "4 - الإيرادات", it starts straight at
 * "41 - الإيرادات التشغيلية"). So instead of trusting that column, section
 * nesting here is derived from the account CODE itself: whichever
 * known account code is the *longest proper prefix* of a given code is
 * its parent. This is exactly the standard Saudi/Qoyod-style numbering
 * convention (1-digit type, 2-digit section, 4-digit group, 6-digit leaf)
 * this firm's export follows, and it reproduces both real documents
 * exactly (see statements.service.ts for the validated numbers).
 */

export type TreeAccount = { id: string; code: string; name: string; nameAr: string | null };

export type TreeNode = {
  id: string | null;
  code: string;
  name: string;
  nameAr: string | null;
  amount: number;
  isLeaf: boolean;
  children: TreeNode[];
};

/**
 * @param accounts   candidate accounts for this tree (already filtered to
 *                    one statement side, e.g. all REVENUE accounts)
 * @param amounts    normal-balance amount per code, for accounts that
 *                    actually had movement (postable leaves only)
 * @param minCodeLength  shortest code allowed to appear as a section —
 *                    2 for the Income Statement (skip the bare "4"/"5"
 *                    type wrapper), 1 for the Balance Sheet (include it)
 */
export function buildAccountTree(
  accounts: TreeAccount[],
  amounts: Map<string, number>,
  minCodeLength = 1,
): TreeNode[] {
  const pool = accounts.filter((a) => a.code.length >= minCodeLength).sort((a, b) => a.code.length - b.code.length);

  const nodeByCode = new Map<string, TreeNode>();
  for (const a of pool) {
    nodeByCode.set(a.code, {
      id: a.id,
      code: a.code,
      name: a.name,
      nameAr: a.nameAr,
      amount: amounts.get(a.code) ?? 0,
      isLeaf: true,
      children: [],
    });
  }

  const roots: TreeNode[] = [];
  for (const a of pool) {
    const node = nodeByCode.get(a.code)!;
    const parentCode = longestPrefixParent(a.code, pool.map((p) => p.code));
    if (parentCode) {
      const parent = nodeByCode.get(parentCode)!;
      parent.children.push(node);
      parent.isLeaf = false;
    } else {
      roots.push(node);
    }
  }

  rollUp(roots);
  return pruneEmpty(roots);
}

function longestPrefixParent(code: string, allCodes: string[]): string | null {
  let best: string | null = null;
  for (const candidate of allCodes) {
    if (candidate === code) continue;
    if (code.startsWith(candidate) && (!best || candidate.length > best.length)) {
      best = candidate;
    }
  }
  return best;
}

function rollUp(nodes: TreeNode[]): number {
  let total = 0;
  for (const node of nodes) {
    if (node.children.length > 0) {
      node.amount = rollUp(node.children);
    }
    total += node.amount;
  }
  return total;
}

/** Matches the real documents' behavior of omitting sections with zero activity entirely. */
function pruneEmpty(nodes: TreeNode[]): TreeNode[] {
  return nodes
    .map((n) => ({ ...n, children: pruneEmpty(n.children) }))
    .filter((n) => n.amount !== 0 || n.children.length > 0);
}

export function sumTree(nodes: TreeNode[]): number {
  return nodes.reduce((s, n) => s + n.amount, 0);
}

/** Standard accounting negative-in-parentheses display, matching the real statement PDFs exactly. */
export function formatSar(amount: number): string {
  const rounded = Math.round(amount * 100) / 100;
  const abs = Math.abs(rounded).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return rounded < 0 ? `(${abs} ر.س)` : `${abs} ر.س`;
}
