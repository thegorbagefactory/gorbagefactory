import { NextResponse } from "next/server";
import { rateLimit, rateLimitResponse } from "../_lib/rateLimit";

export const runtime = "nodejs";

const DAS = "https://gorapi.trashscan.io/";
const CACHE_TTL_MS = Number(process.env.NFT_CACHE_TTL_MS ?? 20_000);
const MAX_DAS_MS = Number(process.env.DAS_TIMEOUT_MS ?? 6_000);
const BASE58_REGEX = /^[1-9A-HJ-NP-Za-km-z]+$/;

if (!Number.isFinite(CACHE_TTL_MS) || CACHE_TTL_MS <= 0) {
  throw new Error("Invalid NFT_CACHE_TTL_MS");
}
if (!Number.isFinite(MAX_DAS_MS) || MAX_DAS_MS <= 0) {
  throw new Error("Invalid DAS_TIMEOUT_MS");
}

type CacheEntry = { data: any[]; updatedAt: number };
const cache = new Map<string, CacheEntry>();

function isValidOwner(owner: string) {
  return owner.length >= 32 && owner.length <= 44 && BASE58_REGEX.test(owner);
}

async function fetchDas(method: string, params: any, timeoutMs: number) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(DAS, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: "1", method, params }),
      signal: controller.signal,
    });
    const json = await res.json();
    if (!res.ok) throw new Error(json?.error?.message || "DAS request failed");
    return json?.result;
  } finally {
    clearTimeout(timer);
  }
}

export async function GET(req: Request) {
  try {
    if (!rateLimit(req, "nfts", 30, 60_000)) return rateLimitResponse();
    const { searchParams } = new URL(req.url);
    const owner = (searchParams.get("owner") || "").trim();
    if (!owner || !isValidOwner(owner)) {
      return NextResponse.json({ error: "Invalid owner" }, { status: 400 });
    }

    const cached = cache.get(owner);
    const now = Date.now();
    if (cached && now - cached.updatedAt < CACHE_TTL_MS) {
      return NextResponse.json({ ok: true, source: "cache", items: cached.data });
    }

    let items: any[] = [];
    try {
      const result: any = await fetchDas(
        "getAssetsByOwner",
        {
          ownerAddress: owner,
          page: 1,
          limit: 50,
        },
        MAX_DAS_MS
      );
      items = result?.items || result?.assets || [];
    } catch {
      if (cached) {
        return NextResponse.json({ ok: true, source: "stale", items: cached.data });
      }
      return NextResponse.json({ ok: true, source: "empty", items: [] });
    }

    cache.set(owner, { data: items, updatedAt: now });
    return NextResponse.json({ ok: true, source: "live", items });
  } catch (e) {
    console.error("[/api/nfts] error", e);
    return NextResponse.json({ error: "Failed to load NFTs" }, { status: 500 });
  }
}
