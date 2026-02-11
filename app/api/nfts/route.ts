import { NextResponse } from "next/server";
import { Metaplex } from "@metaplex-foundation/js";
import { Connection, PublicKey } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import { rateLimit, rateLimitResponse } from "../_lib/rateLimit";

export const runtime = "nodejs";

const CACHE_TTL_MS = Number(process.env.NFT_CACHE_TTL_MS ?? 20_000);
const MAX_RPC_MS = Number(process.env.DAS_TIMEOUT_MS ?? 6_000);
const MAX_JSON_MS = Number(process.env.NFT_JSON_TIMEOUT_MS ?? 3_500);
const MAX_ITEMS = Number(process.env.NFTS_MAX_ITEMS ?? 50);
const BASE58_REGEX = /^[1-9A-HJ-NP-Za-km-z]+$/;
const RPC =
  process.env.GORBAGANA_RPC_URL ||
  process.env.NEXT_PUBLIC_GORBAGANA_RPC_URL ||
  process.env.NEXT_PUBLIC_RPC_URL ||
  "https://rpc.gorbagana.wtf/";
const SAFE_RPC = RPC.includes("rpc.trashscan.io") ? "https://rpc.gorbagana.wtf/" : RPC;

if (!Number.isFinite(CACHE_TTL_MS) || CACHE_TTL_MS <= 0) {
  throw new Error("Invalid NFT_CACHE_TTL_MS");
}
if (!Number.isFinite(MAX_RPC_MS) || MAX_RPC_MS <= 0) {
  throw new Error("Invalid DAS_TIMEOUT_MS");
}
if (!Number.isFinite(MAX_JSON_MS) || MAX_JSON_MS <= 0) {
  throw new Error("Invalid NFT_JSON_TIMEOUT_MS");
}
if (!Number.isFinite(MAX_ITEMS) || MAX_ITEMS <= 0) {
  throw new Error("Invalid NFTS_MAX_ITEMS");
}

type CacheEntry = { data: any[]; updatedAt: number };
const cache = new Map<string, CacheEntry>();
const connection = new Connection(SAFE_RPC, "confirmed");
const metaplex = Metaplex.make(connection);

function isValidOwner(owner: string) {
  return owner.length >= 32 && owner.length <= 44 && BASE58_REGEX.test(owner);
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        controller.signal.addEventListener("abort", () => reject(new Error(`${label} timeout`)));
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function fetchJsonImage(uri: string): Promise<string> {
  if (!uri) return "";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), MAX_JSON_MS);
  try {
    const res = await fetch(uri, { signal: controller.signal, cache: "no-store" });
    if (!res.ok) return "";
    const json: any = await res.json();
    return String(json?.image || "").trim();
  } catch {
    return "";
  } finally {
    clearTimeout(timer);
  }
}

async function fetchOwnedNftMints(owner: PublicKey): Promise<string[]> {
  const mints = new Set<string>();
  const programs = [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID];

  for (const programId of programs) {
    const parsed = await withTimeout(
      connection.getParsedTokenAccountsByOwner(owner, { programId }, "confirmed"),
      MAX_RPC_MS,
      "token accounts"
    );
    for (const row of parsed.value) {
      const info: any = (row.account.data as any)?.parsed?.info;
      const mint = String(info?.mint || "");
      const amount = Number(info?.tokenAmount?.uiAmount ?? 0);
      const decimals = Number(info?.tokenAmount?.decimals ?? 0);
      if (mint && amount > 0 && decimals === 0) mints.add(mint);
      if (mints.size >= MAX_ITEMS) break;
    }
    if (mints.size >= MAX_ITEMS) break;
  }
  return Array.from(mints).slice(0, MAX_ITEMS);
}

function toAsset(mint: string, data: { name?: string; symbol?: string; image?: string }) {
  const normalizeUri = (input?: string) => {
    const value = (input || "").trim();
    if (!value) return "";
    if (value.startsWith("ipfs://")) {
      return `https://ipfs.io/ipfs/${value.slice("ipfs://".length).replace(/^ipfs\//, "")}`;
    }
    if (value.startsWith("ar://")) {
      return `https://arweave.net/${value.slice("ar://".length)}`;
    }
    if (value.startsWith("http://") || value.startsWith("https://")) return value;
    return "";
  };

  const name = data.name?.trim() || mint.slice(0, 8);
  const image = normalizeUri(data.image);
  const symbol = data.symbol?.trim() || "";
  return {
    id: mint,
    content: {
      metadata: { name, symbol, image },
      links: { image },
      files: image ? [{ uri: image, mime: "image/*" }] : [],
    },
  };
}

async function fetchAssetsFromRpc(ownerAddress: string): Promise<any[]> {
  const owner = new PublicKey(ownerAddress);
  const mints = await fetchOwnedNftMints(owner);
  if (!mints.length) return [];

  const mintPubkeys = mints.map((m) => new PublicKey(m));
  const metasRaw: any[] = await withTimeout(
    metaplex.nfts().findAllByMintList({ mints: mintPubkeys }) as Promise<any[]>,
    MAX_RPC_MS,
    "metadata fetch"
  );

  const assets = await Promise.all(
    mints.map(async (mint, index) => {
      const meta: any = metasRaw[index] || null;
      const name = String(meta?.name || "").trim();
      const symbol = String(meta?.symbol || "").trim();
      const uri = String(meta?.uri || "").trim();
      const image = uri ? await fetchJsonImage(uri) : "";
      return toAsset(mint, { name, symbol, image });
    })
  );

  return assets;
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
      items = await fetchAssetsFromRpc(owner);
    } catch (e) {
      console.error("[/api/nfts] rpc fetch failed", e);
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
