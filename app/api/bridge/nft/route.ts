import { NextResponse } from "next/server";
import { Metaplex } from "@metaplex-foundation/js";
import { Connection, PublicKey } from "@solana/web3.js";

export const runtime = "nodejs";

const RPC =
  process.env.SOLANA_RPC_URL ||
  process.env.NEXT_PUBLIC_SOLANA_RPC_URL ||
  "https://api.mainnet-beta.solana.com";

const connection = new Connection(RPC, "confirmed");
const metaplex = Metaplex.make(connection);

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
  try {
    const res = await fetch(uri, { cache: "no-store" });
    if (!res.ok) return "";
    const json: any = await res.json();
    return normalizeUri(String(json?.image || "").trim());
  } catch {
    return "";
  }
}

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const mintStr = (searchParams.get("mint") || "").trim();
    if (!mintStr) return NextResponse.json({ error: "Missing mint" }, { status: 400 });

    const mint = new PublicKey(mintStr);
    const nft: any = await metaplex.nfts().findByMint({ mintAddress: mint });
    const name = String(nft?.name || "").trim() || mintStr.slice(0, 8);
    const symbol = String(nft?.symbol || "").trim();
    const uri = String(nft?.uri || "").trim();
    const image = uri ? await fetchJsonImage(uri) : "";

    return NextResponse.json({
      ok: true,
      item: {
        id: mintStr,
        content: {
          metadata: { name, symbol, image },
          links: { image },
          files: image ? [{ uri: image, mime: "image/*" }] : [],
        },
      },
    });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || "Failed to load mint" }, { status: 400 });
  }
}
