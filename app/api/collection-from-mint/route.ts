import { NextResponse } from "next/server";
import { Connection, PublicKey, Keypair } from "@solana/web3.js";
import { Metaplex, keypairIdentity } from "@metaplex-foundation/js";

const RPC = process.env.GORBAGANA_RPC_URL || process.env.NEXT_PUBLIC_GORBAGANA_RPC_URL || process.env.NEXT_PUBLIC_RPC_URL;

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const mintParam = searchParams.get("mint") || "";
  if (!mintParam) return NextResponse.json({ error: "Missing mint" }, { status: 400 });
  if (!RPC) return NextResponse.json({ error: "Missing RPC" }, { status: 500 });

  try {
    const mint = new PublicKey(mintParam);
    const connection = new Connection(RPC, "confirmed");
    const metaplex = Metaplex.make(connection).use(keypairIdentity(Keypair.generate()));
    const nft = await metaplex.nfts().findByMint({ mintAddress: mint });
    const collectionMint = nft.collection?.address?.toBase58() || "";
    return NextResponse.json({
      collectionMint,
      verified: nft.collection?.verified ?? false,
      name: nft.name,
      symbol: nft.symbol,
    });
  } catch (e: any) {
    return NextResponse.json({ error: String(e?.message || e || "Unknown error") }, { status: 500 });
  }
}
