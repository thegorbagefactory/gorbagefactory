import { NextResponse } from "next/server";
import fs from "fs";
import path from "path";

export const runtime = "nodejs";

const LEDGER_PATH = process.env.REMIX_LEDGER_PATH || path.join(process.cwd(), "data", "remix-ledger.json");
const TIER1_CAP = Number(process.env.TIER1_CAP ?? "3000");
const TIER2_CAP = Number(process.env.TIER2_CAP ?? "999");
const TIER3_CAP = Number(process.env.TIER3_CAP ?? "444");

function loadTierCounts(): { tier1: number; tier2: number; tier3: number } {
  if (!fs.existsSync(LEDGER_PATH)) return { tier1: 0, tier2: 0, tier3: 0 };
  try {
    const raw = fs.readFileSync(LEDGER_PATH, "utf8");
    const parsed = JSON.parse(raw);
    const used = parsed?.usedMints || {};
    const counts = { tier1: 0, tier2: 0, tier3: 0 };
    for (const key of Object.keys(used)) {
      const tier = used[key]?.tier as "tier1" | "tier2" | "tier3" | undefined;
      if (tier && (tier in counts)) (counts as any)[tier] += 1;
    }
    return counts;
  } catch {
    return { tier1: 0, tier2: 0, tier3: 0 };
  }
}

export async function GET() {
  try {
    const counts = loadTierCounts();
    const caps = { tier1: TIER1_CAP, tier2: TIER2_CAP, tier3: TIER3_CAP };
    const supply = {
      tier1: { cap: caps.tier1, minted: counts.tier1, remaining: Math.max(0, caps.tier1 - counts.tier1) },
      tier2: { cap: caps.tier2, minted: counts.tier2, remaining: Math.max(0, caps.tier2 - counts.tier2) },
      tier3: { cap: caps.tier3, minted: counts.tier3, remaining: Math.max(0, caps.tier3 - counts.tier3) },
      totalCap: caps.tier1 + caps.tier2 + caps.tier3,
      totalMinted: counts.tier1 + counts.tier2 + counts.tier3,
    };
    return NextResponse.json({ ok: true, supply });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? "Failed to load supply" }, { status: 500 });
  }
}
