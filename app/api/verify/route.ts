import { NextResponse } from "next/server";
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { Metaplex, keypairIdentity } from "@metaplex-foundation/js";
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";

export const runtime = "nodejs";

type Machine = "CONVEYOR" | "COMPACTOR" | "HAZMAT";
type TierId = "tier1" | "tier2" | "tier3";

type LedgerEntry = {
  originalMint: string;
  mintedMint: string;
  signature: string;
  payer: string;
  machine: Machine;
  tier: TierId;
  createdAt: string;
};

type Ledger = {
  usedMints: Record<string, LedgerEntry>;
  usedSignatures: Record<string, string>;
  lastMintCostLamports?: string;
  mintCount?: number;
  collectionMint?: string;
};

const RPC = process.env.GORBAGANA_RPC_URL || "https://rpc.gorbagana.wtf/";
const TREASURY = process.env.TREASURY_WALLET;
const ROLL_SECRET = process.env.ROLL_SECRET || "change-me";
const PINATA_JWT = process.env.PINATA_JWT;
const MINT_AUTHORITY_KEYPAIR = process.env.MINT_AUTHORITY_KEYPAIR;
const LEDGER_PATH = process.env.REMIX_LEDGER_PATH || path.join(process.cwd(), "data", "remix-ledger.json");
const GOR_LAMPORTS = Number(process.env.GOR_LAMPORTS ?? LAMPORTS_PER_SOL);

const PRICE_CONVEYOR = Number(process.env.PRICE_CONVEYOR_GOR ?? process.env.PRICE_CONVEYOR_GGOR ?? "2500");
const PRICE_COMPACTOR = Number(process.env.PRICE_COMPACTOR_GOR ?? process.env.PRICE_COMPACTOR_GGOR ?? "3500");
const PRICE_HAZMAT = Number(process.env.PRICE_HAZMAT_GOR ?? process.env.PRICE_HAZMAT_GGOR ?? "4500");
const TIER1_CAP = Number(process.env.TIER1_CAP ?? "3000");
const TIER2_CAP = Number(process.env.TIER2_CAP ?? "999");
const TIER3_CAP = Number(process.env.TIER3_CAP ?? "444");

const BASE_ODDS: Record<Machine, Record<TierId, number>> = {
  CONVEYOR: { tier1: 0.8, tier2: 0.18, tier3: 0.02 },
  COMPACTOR: { tier1: 0.65, tier2: 0.3, tier3: 0.05 },
  HAZMAT: { tier1: 0.45, tier2: 0.45, tier3: 0.1 },
};

function priceFor(machine: Machine) {
  const p =
    machine === "CONVEYOR"
      ? PRICE_CONVEYOR
      : machine === "COMPACTOR"
        ? PRICE_COMPACTOR
        : PRICE_HAZMAT;
  if (!isFinite(p) || p <= 0) throw new Error("Invalid machine price config");
  return p;
}

function rollTier(machine: Machine, signature: string, counts: Record<TierId, number>, caps: Record<TierId, number>): TierId {
  const h = crypto.createHash("sha256").update(signature + "|" + machine + "|" + ROLL_SECRET).digest();
  const n = h.readUInt32BE(0) / 0xffffffff;

  const base = BASE_ODDS[machine];
  const weights: Record<TierId, number> = {
    tier1: counts.tier1 < caps.tier1 ? base.tier1 : 0,
    tier2: counts.tier2 < caps.tier2 ? base.tier2 : 0,
    tier3: counts.tier3 < caps.tier3 ? base.tier3 : 0,
  };
  const total = weights.tier1 + weights.tier2 + weights.tier3;
  if (total <= 0) throw new Error("All tiers are sold out.");
  const r = n * total;
  if (r < weights.tier1) return "tier1";
  if (r < weights.tier1 + weights.tier2) return "tier2";
  return "tier3";
}

function pickEffectFromTier(tier: TierId, signature: string) {
  const primaryPools: Record<TierId, string[]> = {
    tier1: ["Rust Chrome", "Oil Slick", "Graffiti Tag", "Grime Wash", "Dusty Circuit", "Soot Fade"],
    tier2: ["Toxic Slime Glow", "Dumpster Drip", "Mold Bloom", "Leachate Sheen", "Grease Halo", "Smog Streaks"],
    tier3: [
      "Biohazard Aura",
      "Liquid Metal Mirror",
      "Radiation Veil",
      "Acid Mist",
      "Nuclear Afterglow",
      "Gamma Bloom",
      "Golden Dumpster (Mythic)",
    ],
  };
  const texturePools = ["Grime Film", "Oil Vignette", "Smog Haze", "Mold Bloom", "Leachate Drip", "Soot Dust"];
  const glowPools = ["Toxic Teal", "Amber Rust", "Magenta Spill", "Lime Halo", "Cold Cyan"];
  const edgePools = ["Clean Edge", "Pitted Edge", "Burnt Edge", "Stickered Edge"];

  const pick = (key: string, arr: string[]) => {
    const h = crypto.createHash("sha256").update(key + "|" + signature).digest();
    const idx = h.readUInt32BE(0) % arr.length;
    return arr[idx];
  };

  const primary = pick("effect", primaryPools[tier]);
  const texture = pick("texture", texturePools);
  const glow = pick("glow", glowPools);
  const edge = pick("edge", edgePools);
  return { primary, texture, glow, edge };
}

function toLamports(amount: number) {
  return BigInt(Math.round(amount * GOR_LAMPORTS));
}

function getLamportDelta(tx: any, treasury: PublicKey) {
  const meta = tx?.meta;
  if (!meta) return null;

  const keys = tx.transaction.message.accountKeys?.map((k: any) =>
    k?.pubkey ? k.pubkey.toBase58() : k?.toBase58?.()
  );
  const idx = Array.isArray(keys) ? keys.indexOf(treasury.toBase58()) : -1;
  if (idx < 0) return null;

  const pre = BigInt(meta.preBalances?.[idx] ?? 0);
  const post = BigInt(meta.postBalances?.[idx] ?? 0);
  return post - pre;
}

function loadKeypair() {
  if (!MINT_AUTHORITY_KEYPAIR) throw new Error("Missing MINT_AUTHORITY_KEYPAIR env var");
  const raw = fs.readFileSync(MINT_AUTHORITY_KEYPAIR, "utf8");
  const arr = JSON.parse(raw);
  const secret = Uint8Array.from(arr);
  return Keypair.fromSecretKey(secret);
}

function loadLedger(): Ledger {
  if (!fs.existsSync(LEDGER_PATH)) {
    return { usedMints: {}, usedSignatures: {} };
  }
  const raw = fs.readFileSync(LEDGER_PATH, "utf8");
  try {
    const parsed = JSON.parse(raw);
    return {
      usedMints: parsed.usedMints || {},
      usedSignatures: parsed.usedSignatures || {},
      lastMintCostLamports: parsed.lastMintCostLamports,
      mintCount: parsed.mintCount ?? 0,
      collectionMint: parsed.collectionMint,
    };
  } catch {
    return { usedMints: {}, usedSignatures: {} };
  }
}

function saveLedger(ledger: Ledger) {
  fs.mkdirSync(path.dirname(LEDGER_PATH), { recursive: true });
  fs.writeFileSync(LEDGER_PATH, JSON.stringify(ledger, null, 2));
}

function getTierCounts(ledger: Ledger): Record<TierId, number> {
  const counts: Record<TierId, number> = { tier1: 0, tier2: 0, tier3: 0 };
  for (const key of Object.keys(ledger.usedMints || {})) {
    const tier = ledger.usedMints[key]?.tier as TierId | undefined;
    if (tier && counts[tier] !== undefined) counts[tier] += 1;
  }
  return counts;
}

function getTierCaps(): Record<TierId, number> {
  const caps = { tier1: TIER1_CAP, tier2: TIER2_CAP, tier3: TIER3_CAP };
  if (!isFinite(caps.tier1) || caps.tier1 <= 0) throw new Error("Invalid TIER1_CAP");
  if (!isFinite(caps.tier2) || caps.tier2 <= 0) throw new Error("Invalid TIER2_CAP");
  if (!isFinite(caps.tier3) || caps.tier3 <= 0) throw new Error("Invalid TIER3_CAP");
  return caps;
}

async function ownsMint(connection: Connection, owner: PublicKey, mint: PublicKey) {
  const programIds = [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID];
  for (const programId of programIds) {
    const resp = await connection.getParsedTokenAccountsByOwner(owner, { mint, programId });
    for (const { account } of resp.value) {
      const info: any = account.data.parsed?.info;
      const amount = Number(info?.tokenAmount?.uiAmount ?? 0);
      const decimals = Number(info?.tokenAmount?.decimals ?? 0);
      if (amount > 0 && decimals === 0) return true;
    }
  }
  return false;
}

function parseDataUrl(dataUrl: string) {
  const match = /^data:(.*?);base64,(.*)$/.exec(dataUrl);
  if (!match) return null;
  return { mime: match[1] || "image/png", data: Buffer.from(match[2], "base64") };
}

async function loadImageBuffer(imageDataUrl?: string, imageUrl?: string) {
  if (imageDataUrl) {
    const parsed = parseDataUrl(imageDataUrl);
    if (parsed) return { buffer: parsed.data, mime: parsed.mime };
  }
  if (imageUrl) {
    const res = await fetch(imageUrl);
    if (!res.ok) throw new Error("Failed to fetch image URL");
    const mime = res.headers.get("content-type") || "image/png";
    const buf = Buffer.from(await res.arrayBuffer());
    return { buffer: buf, mime };
  }
  throw new Error("Missing remix image");
}

async function uploadToPinata(opts: {
  name: string;
  description: string;
  imageBuffer: Buffer;
  imageMime: string;
  attributes: Array<{ trait_type: string; value: string }>;
}) {
  if (!PINATA_JWT) throw new Error("Missing PINATA_JWT env var");

  const uploadFile = async (filename: string, mime: string, buffer: Buffer) => {
    const form = new FormData();
    const blob = new Blob([buffer], { type: mime });
    form.append("file", blob, filename);
    form.append("pinataMetadata", JSON.stringify({ name: filename }));
    form.append("pinataOptions", JSON.stringify({ cidVersion: 1 }));

    const res = await fetch("https://api.pinata.cloud/pinning/pinFileToIPFS", {
      method: "POST",
      headers: { Authorization: `Bearer ${PINATA_JWT}` },
      body: form,
    });
    const data = await res.json();
    if (!res.ok || !data?.IpfsHash) {
      throw new Error(data?.error?.details || data?.error?.message || "Pinata upload failed");
    }
    return data.IpfsHash as string;
  };

  const imageCid = await uploadFile("remix.png", opts.imageMime, opts.imageBuffer);
  const metadata = {
    name: opts.name,
    description: opts.description,
    image: `ipfs://${imageCid}`,
    attributes: opts.attributes,
  };

  const res = await fetch("https://api.pinata.cloud/pinning/pinJSONToIPFS", {
    method: "POST",
    headers: { Authorization: `Bearer ${PINATA_JWT}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      pinataContent: metadata,
      pinataMetadata: { name: `${opts.name} metadata` },
      pinataOptions: { cidVersion: 1 },
    }),
  });
  const data = await res.json();
  if (!res.ok || !data?.IpfsHash) {
    throw new Error(data?.error?.details || data?.error?.message || "Pinata metadata upload failed");
  }
  return `ipfs://${data.IpfsHash}`;
}

async function ensureCollection(params: { connection: Connection; payer: Keypair; ledger: Ledger }) {
  if (params.ledger.collectionMint) return new PublicKey(params.ledger.collectionMint);

  const imagePath = path.join(process.cwd(), "public", "gorbage-logo.png");
  if (!fs.existsSync(imagePath)) throw new Error("Missing collection image at public/gorbage-logo.png");
  const imageBuffer = fs.readFileSync(imagePath);

  const metadataUrl = await uploadToPinata({
    name: "TrashTech",
    description:
      "Stamped in the Gorbage Factory — a fresh TrashTech output packed with grime, glow, and hazard‑grade polish.",
    imageBuffer,
    imageMime: "image/png",
    attributes: [{ trait_type: "Collection", value: "TrashTech" }],
  });

  const metaplex = Metaplex.make(params.connection).use(keypairIdentity(params.payer));
  const { nft } = await metaplex.nfts().create({
    uri: metadataUrl,
    name: "TrashTech",
    symbol: "TRASH",
    sellerFeeBasisPoints: 0,
    tokenOwner: params.payer.publicKey,
    isMutable: true,
    isCollection: true,
  });

  params.ledger.collectionMint = nft.address.toBase58();
  saveLedger(params.ledger);
  return nft.address;
}

async function mintStandardNft(params: {
  connection: Connection;
  payer: Keypair;
  owner: PublicKey;
  name: string;
  metadataUrl: string;
  collectionMint?: PublicKey;
}) {
  const metaplex = Metaplex.make(params.connection).use(keypairIdentity(params.payer));
  const { nft } = await metaplex.nfts().create({
    uri: params.metadataUrl,
    name: params.name,
    symbol: "TRASH",
    sellerFeeBasisPoints: 0,
    tokenOwner: params.owner,
    isMutable: true,
    collection: params.collectionMint ?? null,
    collectionAuthority: params.collectionMint ? params.payer : null,
    collectionIsSized: params.collectionMint ? true : undefined,
  });
  return nft.address.toBase58();
}

export async function POST(req: Request) {
  try {
    if (!TREASURY) return NextResponse.json({ error: "Missing TREASURY_WALLET env var" }, { status: 500 });
    if (!isFinite(GOR_LAMPORTS) || GOR_LAMPORTS <= 0) {
      return NextResponse.json({ error: "Invalid GOR_LAMPORTS" }, { status: 500 });
    }

    const body = (await req.json()) as {
      signature?: string;
      payer?: string;
      machine?: Machine;
      originalMint?: string;
      imageDataUrl?: string;
      imageUrl?: string;
      name?: string;
    };

    const sig = body?.signature?.trim();
    const payerStr = body?.payer?.trim();
    const machine = body?.machine as Machine;
    const originalMint = body?.originalMint?.trim();
    const imageDataUrl = body?.imageDataUrl;
    const imageUrl = body?.imageUrl;
    if (!sig) return NextResponse.json({ error: "Missing signature" }, { status: 400 });
    if (!payerStr) return NextResponse.json({ error: "Missing payer" }, { status: 400 });
    if (!originalMint) return NextResponse.json({ error: "Missing originalMint" }, { status: 400 });
    if (!machine || !["CONVEYOR", "COMPACTOR", "HAZMAT"].includes(machine)) {
      return NextResponse.json({ error: "Invalid machine" }, { status: 400 });
    }

    const ledger = loadLedger();
    if (ledger.usedMints[originalMint]) {
      return NextResponse.json({ error: "This NFT already has a remix" }, { status: 409 });
    }
    if (ledger.usedSignatures[sig]) {
      return NextResponse.json({ error: "Signature already used" }, { status: 409 });
    }

    const payer = new PublicKey(payerStr);
    const treasury = new PublicKey(TREASURY);

    const connection = new Connection(RPC, "confirmed");
    const tx = await connection.getParsedTransaction(sig, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    });

    if (!tx) return NextResponse.json({ error: "Transaction not found yet. Try again in a moment." }, { status: 404 });
    if (tx.meta?.err) return NextResponse.json({ error: "Payment transaction failed" }, { status: 400 });

    const accountKeys = tx.transaction.message.accountKeys?.map((k: any) =>
      k?.pubkey ? k.pubkey.toBase58() : k?.toBase58?.()
    );
    const payerInKeys = Array.isArray(accountKeys) && accountKeys.includes(payer.toBase58());
    if (!payerInKeys) {
      return NextResponse.json({ error: "Payer not found in transaction account keys" }, { status: 400 });
    }

    const delta = getLamportDelta(tx, treasury);
    if (delta === null) {
      return NextResponse.json({ error: "Transaction missing balance metadata" }, { status: 400 });
    }

    const expected = toLamports(priceFor(machine));
    if (delta !== expected) {
      return NextResponse.json(
        {
          error: "Payment verification failed (wrong amount)",
          expectedLamports: expected.toString(),
          gotLamports: delta.toString(),
        },
        { status: 400 }
      );
    }

    const owns = await ownsMint(connection, payer, new PublicKey(originalMint));
    if (!owns) {
      return NextResponse.json({ error: "Payer does not own the selected NFT" }, { status: 403 });
    }

    const treasuryBalanceBefore = await connection.getBalance(treasury, "confirmed");
    const caps = getTierCaps();
    const counts = getTierCounts(ledger);
    const tier = rollTier(machine, sig, counts, caps);
    if (counts[tier] >= caps[tier]) {
      return NextResponse.json({ error: "This tier is sold out" }, { status: 409 });
    }
    const effect = pickEffectFromTier(tier, sig);

    const image = await loadImageBuffer(imageDataUrl, imageUrl);
    const nextCount = (ledger.mintCount ?? 0) + 1;
    const remixName = `TrashTech ${String(nextCount).padStart(3, "0")}`;
    const description =
      "Stamped in the Gorbage Factory — a fresh TrashTech output packed with grime, glow, and hazard‑grade polish.";

    const attributes = [
      { trait_type: "Collection", value: "TrashTech" },
      { trait_type: "Machine", value: machine },
      { trait_type: "Tier", value: tier },
      { trait_type: "Primary Effect", value: effect.primary },
      { trait_type: "Texture", value: effect.texture },
      { trait_type: "Glow", value: effect.glow },
      { trait_type: "Edge", value: effect.edge },
    ];

    const metadataUrl = await uploadToPinata({
      name: remixName,
      description,
      imageBuffer: image.buffer,
      imageMime: image.mime,
      attributes,
    });

    const payerKeypair = loadKeypair();
    const collectionMint = await ensureCollection({ connection, payer: payerKeypair, ledger });
    const minted = await mintStandardNft({
      connection,
      payer: payerKeypair,
      owner: payer,
      name: remixName,
      metadataUrl,
      collectionMint,
    });
    const treasuryBalanceAfter = await connection.getBalance(treasury, "confirmed");
    const mintCostLamports = Math.max(0, treasuryBalanceBefore - treasuryBalanceAfter);

    const entry: LedgerEntry = {
      originalMint,
      mintedMint: minted,
      signature: sig,
      payer: payer.toBase58(),
      machine,
      tier,
      createdAt: new Date().toISOString(),
    };
    ledger.usedMints[originalMint] = entry;
    ledger.usedSignatures[sig] = originalMint;
    ledger.lastMintCostLamports = String(mintCostLamports);
    ledger.mintCount = nextCount;
    saveLedger(ledger);

    return NextResponse.json({
      ok: true,
      signature: sig,
      payer: payer.toBase58(),
      treasury: treasury.toBase58(),
      machine,
      tier,
      effect: effect.primary,
      texture: effect.texture,
      glow: effect.glow,
      edge: effect.edge,
      metadataUrl,
      minted,
    });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? "Verification failed" }, { status: 500 });
  }
}
