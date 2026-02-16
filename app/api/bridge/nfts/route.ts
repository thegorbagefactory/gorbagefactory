import { NextResponse } from "next/server";
import { Metaplex } from "@metaplex-foundation/js";
import { Connection, PublicKey } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import { rateLimit, rateLimitResponse } from "../../_lib/rateLimit";

export const runtime = "nodejs";

const CACHE_TTL_MS = Number(process.env.NFT_CACHE_TTL_MS ?? 20_000);
const MAX_RPC_MS = Number(process.env.DAS_TIMEOUT_MS ?? 8_000);
const MAX_JSON_MS = Number(process.env.NFT_JSON_TIMEOUT_MS ?? 4_000);
const MAX_ITEMS = Number(process.env.NFTS_MAX_ITEMS ?? 50);
const BASE58_REGEX = /^[1-9A-HJ-NP-Za-km-z]+$/;

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
const connection = new Connection(SOL_RPC, "confirmed");
const metaplex = Metaplex.make(connection);
const imageCache = new Map<string, string>();

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
  if (value.startsWith("data:image/")) return value;
  if (value.startsWith("ipfs://")) {
    return `https://ipfs.io/ipfs/${value.slice("ipfs://".length).replace(/^ipfs\//, "")}`;
  }
  if (value.startsWith("ar://")) {
    return `https://arweave.net/${value.slice("ar://".length)}`;
  }
  // Some metadata stores raw CID values without a URI scheme.
  if (/^(Qm[1-9A-HJ-NP-Za-km-z]{44,}|bafy[1-9A-Za-z]{20,})$/.test(value)) {
    return `https://ipfs.io/ipfs/${value}`;
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
    const direct =
      typeof json?.image === "string"
        ? json.image
        : typeof json?.properties?.image === "string"
          ? json.properties.image
          : typeof json?.image?.uri === "string"
            ? json.image.uri
            : "";
    const fileCandidate = Array.isArray(json?.properties?.files)
      ? String(
          json.properties.files.find((f: any) => String(f?.type || f?.mime || "").startsWith("image/"))?.uri ||
            json.properties.files[0]?.uri ||
            ""
        )
      : "";
    return normalizeUri(String(direct || fileCandidate || "").trim());
  } catch {
    return "";
  } finally {
    clearTimeout(timer);
  }
}

async function resolveImageForMint(mint: string): Promise<string> {
  if (!mint) return "";
  if (imageCache.has(mint)) return imageCache.get(mint) || "";
  try {
    const loaded: any = await withTimeout(
      metaplex.nfts().findByMint({ mintAddress: new PublicKey(mint) }),
      MAX_RPC_MS,
      "mint metadata"
    );
    const fromJson = normalizeUri(String(loaded?.json?.image || ""));
    if (fromJson) {
      imageCache.set(mint, fromJson);
      return fromJson;
    }
    const uri = String(loaded?.uri || "").trim();
    const fromUri = uri ? await fetchJsonImage(uri) : "";
    imageCache.set(mint, fromUri || "");
    return fromUri || "";
  } catch {
    imageCache.set(mint, "");
    return "";
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

async function fetchAssetsViaDas(owner: string): Promise<any[]> {
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
  const out: any[] = [];

  for (const it of items.slice(0, MAX_ITEMS)) {
    const iface = String(it?.interface || "");
    if (!["V1_NFT", "ProgrammableNFT", "CompressedNFT", "MplCoreAsset"].includes(iface)) continue;
    const balance = Number(it?.token_info?.balance ?? 1);
    if (!Number.isFinite(balance) || balance < 1) continue;

    const mint = String(it?.token_info?.mint || it?.id || "").trim();
    if (!mint) continue;

    const primaryImage =
      String(
        it?.content?.files?.find((f: any) => String(f?.mime || f?.type || "").startsWith("image/"))?.uri ||
          it?.content?.files?.[0]?.uri ||
          ""
      ) || String(it?.content?.links?.image || "");
    const jsonUri = String(it?.content?.json_uri || "");
    const image =
      normalizeUri(primaryImage) ||
      (jsonUri ? await fetchJsonImage(jsonUri) : "") ||
      (await resolveImageForMint(mint));

    out.push(
      toAsset(mint, {
        name: String(it?.content?.metadata?.name || ""),
        symbol: String(it?.content?.metadata?.symbol || ""),
        image,
      })
    );
  }

  return out;
}

async function fetchAssetsViaTokenAccounts(ownerAddress: string): Promise<any[]> {
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
      if (mint && amount > 0 && decimals === 0) mints.add(mint);
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
      let image = (uri ? await fetchJsonImage(uri) : "") || (await resolveImageForMint(mint));
      if (!image && meta) {
        try {
          const loaded: any = await withTimeout(metaplex.nfts().load({ metadata: meta }), MAX_RPC_MS, "metadata load");
          image = normalizeUri(String(loaded?.json?.image || ""));
        } catch {
          // keep empty image; frontend will use fallback
        }
      }
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

    let items: any[] = [];
    try {
      items = await fetchAssetsViaDas(owner);
    } catch {
      items = [];
    }
    if (!items.length) {
      items = await fetchAssetsViaTokenAccounts(owner);
    }

    const dedup = items.filter((a, i, arr) => a?.id && arr.findIndex((x) => x.id === a.id) === i);
    cache.set(owner, { data: dedup, updatedAt: now });
    return NextResponse.json({ ok: true, source: "live", items: dedup });
  } catch (e) {
    console.error("[/api/bridge/nfts] error", e);
    return NextResponse.json({ error: "Failed to load NFTs" }, { status: 500 });
  }
}
