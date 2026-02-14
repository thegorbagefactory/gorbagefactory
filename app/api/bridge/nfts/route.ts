import { NextResponse } from "next/server";
import { Metaplex } from "@metaplex-foundation/js";
import { Connection, PublicKey } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import { rateLimit, rateLimitResponse } from "../../_lib/rateLimit";

export const runtime = "nodejs";

const CACHE_TTL_MS = Number(process.env.NFT_CACHE_TTL_MS ?? 20_000);
const MAX_RPC_MS = Number(process.env.DAS_TIMEOUT_MS ?? 7_000);
const MAX_JSON_MS = Number(process.env.NFT_JSON_TIMEOUT_MS ?? 3_500);
const MAX_ITEMS = Number(process.env.NFTS_MAX_ITEMS ?? 50);
const BASE58_REGEX = /^[1-9A-HJ-NP-Za-km-z]+$/;
const BRIDGE_ONLY_VERIFIED = (process.env.BRIDGE_ONLY_VERIFIED ?? "true").toLowerCase() === "true";
const BRIDGE_FILTER_SCAM = (process.env.BRIDGE_FILTER_SCAM ?? "true").toLowerCase() === "true";
const BRIDGE_ALLOW_TOKEN_FALLBACK = (process.env.BRIDGE_ALLOW_TOKEN_FALLBACK ?? "false").toLowerCase() === "true";
const BRIDGE_USE_DAS = (process.env.BRIDGE_USE_DAS ?? "false").toLowerCase() === "true";
const BRIDGE_MINT_ALLOWLIST = new Set(
  String(process.env.BRIDGE_MINT_ALLOWLIST || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
);
const BRIDGE_COLLECTION_ALLOWLIST = new Set(
  String(process.env.BRIDGE_COLLECTION_ALLOWLIST || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
);
const SCAM_PATTERNS = [
  "airdrop",
  "claim",
  "voucher",
  "reward",
  "free mint",
  "bonus",
  "qr",
  "scan",
  "wallet connect",
  "drain",
  "sweep",
  "verify wallet",
  "congrat",
  "visit",
  "telegram",
  "discord",
];

const SOL_RPC =
  process.env.SOLANA_RPC_URL ||
  process.env.NEXT_PUBLIC_SOLANA_RPC_URL ||
  "https://api.mainnet-beta.solana.com";
const SOL_DAS_URL =
  process.env.SOLANA_DAS_URL ||
  process.env.NEXT_PUBLIC_SOLANA_DAS_URL ||
  SOL_RPC;

type CacheEntry = { data: any[]; updatedAt: number };
const cache = new Map<string, CacheEntry>();

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

function normalizeUri(input?: string): string {
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
}

async function fetchJsonImage(uri: string): Promise<string> {
  if (!uri) return "";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), MAX_JSON_MS);
  try {
    const res = await fetch(uri, { signal: controller.signal, cache: "no-store" });
    if (!res.ok) return "";
    const json: any = await res.json();
    return normalizeUri(String(json?.image || "").trim());
  } catch {
    return "";
  } finally {
    clearTimeout(timer);
  }
}

function toAsset(mint: string, data: { name?: string; symbol?: string; image?: string }) {
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

function isVerifiedCollectionAsset(it: any): boolean {
  return it?.collection?.verified === true || it?.content?.metadata?.collection?.verified === true;
}

function hasCollectionGrouping(it: any): boolean {
  return Array.isArray(it?.grouping)
    ? it.grouping.some((g: any) => g?.group_key === "collection" && String(g?.group_value || "").length > 0)
    : false;
}

function getCollectionMint(it: any): string {
  const fromGrouping = Array.isArray(it?.grouping)
    ? it.grouping.find((g: any) => g?.group_key === "collection")?.group_value
    : "";
  const fromCollection = it?.collection?.key || it?.content?.metadata?.collection?.key || "";
  return String(fromGrouping || fromCollection || "").trim();
}

function hasVerifiedCreator(it: any): boolean {
  return Array.isArray(it?.creators) ? it.creators.some((c: any) => c?.verified === true) : false;
}

function isAllowlistedAsset(it: any): boolean {
  if (!BRIDGE_MINT_ALLOWLIST.size && !BRIDGE_COLLECTION_ALLOWLIST.size) return true;
  const mint = String(it?.id || "").trim();
  const collectionMint = getCollectionMint(it);
  if (mint && BRIDGE_MINT_ALLOWLIST.has(mint)) return true;
  if (collectionMint && BRIDGE_COLLECTION_ALLOWLIST.has(collectionMint)) return true;
  return false;
}

function looksScammyAsset(it: any): boolean {
  const name = String(it?.content?.metadata?.name || "").toLowerCase();
  const symbol = String(it?.content?.metadata?.symbol || "").toLowerCase();
  const desc = String(it?.content?.metadata?.description || "").toLowerCase();
  const hay = `${name} ${symbol} ${desc}`;
  return SCAM_PATTERNS.some((p) => hay.includes(p));
}

async function fetchAssetsViaDas(owner: string): Promise<any[]> {
  const allowedInterfaces = new Set(["V1_NFT", "ProgrammableNFT", "CompressedNFT", "MplCoreAsset"]);
  const payload = {
    jsonrpc: "2.0",
    id: "bridge-nfts",
    method: "getAssetsByOwner",
    params: {
      ownerAddress: owner,
      page: 1,
      limit: Math.min(100, MAX_ITEMS),
      sortBy: { sortBy: "created", sortDirection: "desc" },
    },
  };
  const res = await withTimeout(
    fetch(SOL_DAS_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      cache: "no-store",
    }),
    MAX_RPC_MS,
    "das fetch"
  );
  if (!res.ok) throw new Error(`das rpc ${res.status}`);
  const json: any = await res.json();
  const items = Array.isArray(json?.result?.items) ? json.result.items : [];
  const normalizeOne = async (it: any, requireVerified: boolean, requireCreator: boolean) => {
      const iface = String(it?.interface || "");
      if (!allowedInterfaces.has(iface)) return null;
      if (!isAllowlistedAsset(it)) return null;
      if (!hasCollectionGrouping(it)) return null;
      if (requireVerified && !isVerifiedCollectionAsset(it)) return null;
      if (requireCreator && !hasVerifiedCreator(it)) return null;
      if (BRIDGE_FILTER_SCAM && looksScammyAsset(it)) return null;

      const balance = Number(it?.token_info?.balance ?? 1);
      if (!Number.isFinite(balance) || balance < 1) return null;
      const primaryImage =
        String(it?.content?.files?.find((f: any) => String(f?.mime || "").startsWith("image/"))?.uri || "") ||
        String(it?.content?.links?.image || "");
      const jsonUri = String(it?.content?.json_uri || "");
      const jsonImage = jsonUri ? await fetchJsonImage(jsonUri) : "";
      const image = normalizeUri(primaryImage) || jsonImage || "";
      if (!image) return null;

      return toAsset(String(it?.id || ""), {
        name: String(it?.content?.metadata?.name || ""),
        symbol: String(it?.content?.metadata?.symbol || ""),
        image,
      });
  };

  const strict = await Promise.all(items.slice(0, MAX_ITEMS).map((it: any) => normalizeOne(it, true, true)));
  const strictFiltered = strict.filter((a: any) => a?.id);
  if (strictFiltered.length) return strictFiltered;

  const relaxed = await Promise.all(items.slice(0, MAX_ITEMS).map((it: any) => normalizeOne(it, false, true)));
  const relaxedFiltered = relaxed.filter((a: any) => a?.id);
  if (relaxedFiltered.length) return relaxedFiltered;

  // Optional last fallback: token account path (still amount=1, decimals=0).
  return BRIDGE_ALLOW_TOKEN_FALLBACK ? fetchAssetsViaTokenAccounts(owner) : [];
}

async function fetchAssetsViaTokenAccounts(ownerAddress: string): Promise<any[]> {
  const connection = new Connection(SOL_RPC, "confirmed");
  const metaplex = Metaplex.make(connection);
  const owner = new PublicKey(ownerAddress);
  const mints = new Set<string>();
  for (const programId of [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID]) {
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
      if (mint && amount === 1 && decimals === 0) mints.add(mint);
      if (mints.size >= MAX_ITEMS) break;
    }
    if (mints.size >= MAX_ITEMS) break;
  }
  const mintList = Array.from(mints).slice(0, MAX_ITEMS);
  if (!mintList.length) return [];

  const mintPubkeys = mintList.map((m) => new PublicKey(m));
  const metasRaw: any[] = await withTimeout(
    metaplex.nfts().findAllByMintList({ mints: mintPubkeys }) as Promise<any[]>,
    MAX_RPC_MS,
    "metadata fetch"
  );

  return Promise.all(
    mintList.map(async (mint, index) => {
      const meta: any = metasRaw[index] || null;
      const name = String(meta?.name || "").trim();
      const symbol = String(meta?.symbol || "").trim();
      const uri = String(meta?.uri || "").trim();
      const image = uri ? await fetchJsonImage(uri) : "";
      return toAsset(mint, { name, symbol, image });
    })
  );
}

export async function GET(req: Request) {
  try {
    if (!rateLimit(req, "bridge_nfts", 30, 60_000)) return rateLimitResponse();
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

    // Default to token-account discovery to avoid DAS spam/airdrop noise.
    // DAS can be enabled explicitly for broader compressed NFT discovery.
    let items: any[] = await fetchAssetsViaTokenAccounts(owner);
    if (!items.length && BRIDGE_USE_DAS) {
      try {
        items = await fetchAssetsViaDas(owner);
      } catch {
        items = [];
      }
    }

    cache.set(owner, { data: items, updatedAt: now });
    return NextResponse.json({ ok: true, source: "live", items });
  } catch (e) {
    console.error("[/api/bridge/nfts] error", e);
    return NextResponse.json({ error: "Failed to load NFTs" }, { status: 500 });
  }
}
