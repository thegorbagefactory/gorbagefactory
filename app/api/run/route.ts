import { NextResponse } from "next/server";
import { LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import fs from "fs";
import path from "path";
import { rateLimit, rateLimitResponse } from "../_lib/rateLimit";

export const runtime = "nodejs";

type Machine = "CONVEYOR" | "COMPACTOR" | "HAZMAT";

function requireEnv(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

const TREASURY = requireEnv("TREASURY_WALLET");
const GOR_LAMPORTS = Number(process.env.GOR_LAMPORTS ?? LAMPORTS_PER_SOL);

if (!Number.isFinite(GOR_LAMPORTS) || GOR_LAMPORTS <= 0) {
  throw new Error("Invalid GOR_LAMPORTS configuration");
}

// New pricing: $5 / $7 / $9 => 2500 / 3500 / 4500 $GOR
const PRICE_CONVEYOR_RAW = process.env.PRICE_CONVEYOR_GOR ?? process.env.PRICE_CONVEYOR_GGOR ?? "auto";
const PRICE_CONVEYOR = Number(PRICE_CONVEYOR_RAW);
const PRICE_COMPACTOR = Number(process.env.PRICE_COMPACTOR_GOR ?? process.env.PRICE_COMPACTOR_GGOR ?? "3500");
const PRICE_HAZMAT = Number(process.env.PRICE_HAZMAT_GOR ?? process.env.PRICE_HAZMAT_GGOR ?? "4500");
const TIER1_CAP = Number(process.env.TIER1_CAP ?? "3000");
const TIER2_CAP = Number(process.env.TIER2_CAP ?? "999");
const TIER3_CAP = Number(process.env.TIER3_CAP ?? "444");
const LEDGER_PATH = process.env.REMIX_LEDGER_PATH || path.join(process.cwd(), "data", "remix-ledger.json");

function loadLastMintCostLamports(): number | null {
  if (!fs.existsSync(LEDGER_PATH)) return null;
  try {
    const raw = fs.readFileSync(LEDGER_PATH, "utf8");
    const parsed = JSON.parse(raw);
    const val = Number(parsed?.lastMintCostLamports ?? 0);
    return Number.isFinite(val) && val > 0 ? val : null;
  } catch (e) {
    console.error("[/api/run] ledger parse failed", e);
    throw new Error("Ledger corrupted");
  }
}

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
  } catch (e) {
    console.error("[/api/run] ledger parse failed", e);
    throw new Error("Ledger corrupted");
  }
}

function priceFor(machine: Machine) {
  if (machine === "CONVEYOR") {
    if (!isFinite(PRICE_CONVEYOR) || PRICE_CONVEYOR <= 0 || PRICE_CONVEYOR_RAW === "auto") {
      const last = loadLastMintCostLamports();
      if (!last) throw new Error("No mint cost recorded yet. Set PRICE_CONVEYOR_GOR or run one mint.");
      return last / GOR_LAMPORTS;
    }
    return PRICE_CONVEYOR;
  }
  const p = machine === "COMPACTOR" ? PRICE_COMPACTOR : PRICE_HAZMAT;
  if (!isFinite(p) || p <= 0) throw new Error("Invalid machine price config");
  return p;
}

export async function POST(req: Request) {
  try {
    if (!rateLimit(req, "run", 30, 60_000)) return rateLimitResponse();
    if (!TREASURY) return NextResponse.json({ error: "Missing TREASURY_WALLET env var" }, { status: 500 });
    if (!isFinite(GOR_LAMPORTS) || GOR_LAMPORTS <= 0) {
      return NextResponse.json({ error: "Invalid GOR_LAMPORTS" }, { status: 500 });
    }

    const body = (await req.json()) as { machine?: Machine };
    const machine = body?.machine as Machine;

    if (!machine || !["CONVEYOR", "COMPACTOR", "HAZMAT"].includes(machine)) {
      return NextResponse.json({ error: "Invalid machine" }, { status: 400 });
    }

    const counts = loadTierCounts();
    const caps = { tier1: TIER1_CAP, tier2: TIER2_CAP, tier3: TIER3_CAP };
    const remaining = {
      tier1: Math.max(0, caps.tier1 - counts.tier1),
      tier2: Math.max(0, caps.tier2 - counts.tier2),
      tier3: Math.max(0, caps.tier3 - counts.tier3),
    };
    if (remaining.tier1 + remaining.tier2 + remaining.tier3 <= 0) {
      return NextResponse.json({ error: "All tiers are sold out." }, { status: 409 });
    }

    const treasury = new PublicKey(TREASURY);
    const amount = priceFor(machine);
    const amountLamports = BigInt(Math.round(amount * GOR_LAMPORTS)).toString();

    return NextResponse.json({
      ok: true,
      machine,
      treasury: treasury.toBase58(),
      amount, // $GOR units
      amountLamports, // base units (string)
    });
  } catch (e: any) {
    console.error("[/api/run] error", e);
    return NextResponse.json({ error: "Failed to create quote" }, { status: 500 });
  }
}
