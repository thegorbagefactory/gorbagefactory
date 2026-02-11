import { NextResponse } from "next/server";
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram } from "@solana/web3.js";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import net from "net";
import { Metaplex, keypairIdentity } from "@metaplex-foundation/js";
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import { createClient } from "@supabase/supabase-js";
import { rateLimit, rateLimitResponse } from "../_lib/rateLimit";

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

const RPC =
  process.env.GORBAGANA_RPC_URL ||
  process.env.NEXT_PUBLIC_GORBAGANA_RPC_URL ||
  process.env.NEXT_PUBLIC_RPC_URL ||
  "https://rpc.gorbagana.wtf/";
const SAFE_RPC = RPC.includes("rpc.trashscan.io") ? "https://rpc.gorbagana.wtf/" : RPC;

const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";

const supabase =
  SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY
    ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
        auth: { persistSession: false },
      })
    : null;

function requireEnv(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

const TREASURY = requireEnv("TREASURY_WALLET");
const PINATA_JWT = requireEnv("PINATA_JWT");
const MINT_AUTHORITY_KEYPAIR = requireEnv("MINT_AUTHORITY_KEYPAIR");
const ROLL_SECRET = requireEnv("ROLL_SECRET");

if (
  !ROLL_SECRET ||
  ROLL_SECRET === "change-me" ||
  ROLL_SECRET === "CHANGE_ME_TO_A_LONG_RANDOM_SECRET" ||
  ROLL_SECRET.length < 32
) {
  throw new Error("ROLL_SECRET must be set to a strong random value");
}

const LEDGER_PATH = process.env.REMIX_LEDGER_PATH || path.join(process.cwd(), "data", "remix-ledger.json");
const GOR_LAMPORTS = Number(process.env.GOR_LAMPORTS ?? LAMPORTS_PER_SOL);

if (!Number.isFinite(GOR_LAMPORTS) || GOR_LAMPORTS <= 0) {
  throw new Error("Invalid GOR_LAMPORTS configuration");
}

const PRICE_CONVEYOR = Number(process.env.PRICE_CONVEYOR_GOR ?? process.env.PRICE_CONVEYOR_GGOR ?? "1");
const PRICE_COMPACTOR = Number(process.env.PRICE_COMPACTOR_GOR ?? process.env.PRICE_COMPACTOR_GGOR ?? "3500");
const PRICE_HAZMAT = Number(process.env.PRICE_HAZMAT_GOR ?? process.env.PRICE_HAZMAT_GGOR ?? "4500");
const TIER1_CAP = Number(process.env.TIER1_CAP ?? "3000");
const TIER2_CAP = Number(process.env.TIER2_CAP ?? "999");
const TIER3_CAP = Number(process.env.TIER3_CAP ?? "444");

const MAX_BODY_BYTES = Number(process.env.MAX_BODY_BYTES ?? 8 * 1024 * 1024);
const MAX_IMAGE_BYTES = Number(process.env.MAX_IMAGE_BYTES ?? 5 * 1024 * 1024);
const MAX_TX_SLOT_AGE = Number(process.env.MAX_TX_SLOT_AGE ?? 300);

if (!Number.isFinite(MAX_BODY_BYTES) || MAX_BODY_BYTES <= 0) {
  throw new Error("Invalid MAX_BODY_BYTES configuration");
}
if (!Number.isFinite(MAX_IMAGE_BYTES) || MAX_IMAGE_BYTES <= 0) {
  throw new Error("Invalid MAX_IMAGE_BYTES configuration");
}
if (!Number.isFinite(MAX_TX_SLOT_AGE) || MAX_TX_SLOT_AGE <= 0) {
  throw new Error("Invalid MAX_TX_SLOT_AGE configuration");
}

const BASE58_REGEX = /^[1-9A-HJ-NP-Za-km-z]+$/;
const ALLOWED_IMAGE_MIMES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const DEFAULT_ALLOWED_IMAGE_HOSTS = [
  "ipfs.io",
  "gateway.pinata.cloud",
  "cloudflare-ipfs.com",
  "nftstorage.link",
  "dweb.link",
  "arweave.net",
  "arweave.dev",
  "arweave.org",
];
const IMAGE_HOST_ALLOWLIST = (process.env.IMAGE_HOST_ALLOWLIST || "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
const ALLOWED_IMAGE_HOSTS = IMAGE_HOST_ALLOWLIST.length ? IMAGE_HOST_ALLOWLIST : DEFAULT_ALLOWED_IMAGE_HOSTS;

const BASE_ODDS: Record<Machine, Record<TierId, number>> = {
  CONVEYOR: { tier1: 0.8, tier2: 0.18, tier3: 0.02 },
  COMPACTOR: { tier1: 0.65, tier2: 0.3, tier3: 0.05 },
  HAZMAT: { tier1: 0.45, tier2: 0.45, tier3: 0.1 },
};

const inFlightSignatures = new Set<string>();
const inFlightMints = new Set<string>();
let ledgerLock: Promise<void> = Promise.resolve();
let cachedKeypair: Keypair | null = null;

function withLedgerLock<T>(fn: () => Promise<T>): Promise<T> {
  let release: () => void;
  const next = new Promise<void>((resolve) => {
    release = resolve;
  });
  const previous = ledgerLock;
  ledgerLock = next;
  return previous.then(fn).finally(() => release());
}

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

function isValidSignature(sig: string) {
  return sig.length >= 80 && sig.length <= 90 && BASE58_REGEX.test(sig);
}

function isValidPublicKey(key: string) {
  return key.length >= 32 && key.length <= 44 && BASE58_REGEX.test(key);
}

function sanitizeName(name: string) {
  return name.replace(/[^\w\s\-\.]/g, "").trim().slice(0, 32) || "TrashTech";
}

function loadKeypair() {
  if (cachedKeypair) return cachedKeypair;
  const resolved = path.resolve(MINT_AUTHORITY_KEYPAIR);
  const allowedRoots = [path.resolve(process.cwd()), "/etc/secrets"];
  const isAllowed = allowedRoots.some((root) => resolved === root || resolved.startsWith(root + path.sep));
  if (!isAllowed) throw new Error("MINT_AUTHORITY_KEYPAIR path outside allowed roots");
  const raw = fs.readFileSync(resolved, "utf8");
  const arr = JSON.parse(raw);
  if (!Array.isArray(arr)) throw new Error("Invalid mint authority keypair file");
  cachedKeypair = Keypair.fromSecretKey(Uint8Array.from(arr));
  return cachedKeypair;
}

function backupCorruptedLedger() {
  if (!fs.existsSync(LEDGER_PATH)) return;
  const backup = `${LEDGER_PATH}.corrupted.${Date.now()}`;
  fs.copyFileSync(LEDGER_PATH, backup);
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
  } catch (e) {
    console.error("[verify] ledger corrupted", e);
    backupCorruptedLedger();
    throw new Error("Ledger corrupted - minting halted for safety");
  }
}

function saveLedger(ledger: Ledger) {
  fs.mkdirSync(path.dirname(LEDGER_PATH), { recursive: true });
  const tmpPath = `${LEDGER_PATH}.${crypto.randomBytes(6).toString("hex")}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(ledger, null, 2));
  fs.renameSync(tmpPath, LEDGER_PATH);
}

type PersistentState = {
  mintCount: number;
  collectionMint?: string | null;
};

async function getPersistentState(): Promise<PersistentState | null> {
  if (!supabase) return null;
  const { data, error } = await supabase
    .from("remix_state")
    .select("mint_count, collection_mint")
    .eq("id", 1)
    .maybeSingle();
  if (error) throw new Error(`Supabase read failed: ${error.message}`);
  return {
    mintCount: data?.mint_count ?? 0,
    collectionMint: data?.collection_mint ?? null,
  };
}

async function isSignatureUsed(signature: string): Promise<boolean> {
  if (!supabase) return false;
  const { data, error } = await supabase
    .from("used_signatures")
    .select("signature")
    .eq("signature", signature)
    .maybeSingle();
  if (error) throw new Error(`Supabase read failed: ${error.message}`);
  return !!data?.signature;
}

async function getTierCountsPersistent(): Promise<Record<TierId, number> | null> {
  if (!supabase) return null;
  const { data, error } = await supabase.from("mint_log").select("tier");
  if (error) throw new Error(`Supabase read failed: ${error.message}`);
  const counts: Record<TierId, number> = { tier1: 0, tier2: 0, tier3: 0 };
  for (const row of data || []) {
    const tier = row?.tier as TierId | undefined;
    if (tier && counts[tier] !== undefined) counts[tier] += 1;
  }
  return counts;
}

async function persistMint(params: {
  originalMint: string;
  mintedMint: string;
  signature: string;
  payer: string;
  machine: Machine;
  tier: TierId;
  mintCount: number;
  collectionMint?: string | null;
}) {
  if (!supabase) return;
  const { error: mintErr } = await supabase.from("mint_log").insert({
    signature: params.signature,
    original_mint: params.originalMint,
    minted_mint: params.mintedMint,
    payer: params.payer,
    machine: params.machine,
    tier: params.tier,
  });
  if (mintErr) throw new Error(`Supabase write failed: ${mintErr.message}`);

  const { error: sigErr } = await supabase.from("used_signatures").upsert(
    {
      signature: params.signature,
      original_mint: params.originalMint,
    },
    { onConflict: "signature" }
  );
  if (sigErr) throw new Error(`Supabase write failed: ${sigErr.message}`);

  const { error: stateErr } = await supabase.from("remix_state").upsert(
    {
      id: 1,
      mint_count: params.mintCount,
      collection_mint: params.collectionMint ?? null,
    },
    { onConflict: "id" }
  );
  if (stateErr) throw new Error(`Supabase write failed: ${stateErr.message}`);
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

function hasPngMagic(buf: Buffer) {
  return buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
}

function hasJpegMagic(buf: Buffer) {
  return buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xd8;
}

function hasGifMagic(buf: Buffer) {
  return buf.length >= 6 && buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46;
}

function hasWebpMagic(buf: Buffer) {
  return buf.length >= 12 && buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP";
}

function mimeMatchesBuffer(mime: string, data: Buffer) {
  if (mime === "image/png") return hasPngMagic(data);
  if (mime === "image/jpeg") return hasJpegMagic(data);
  if (mime === "image/gif") return hasGifMagic(data);
  if (mime === "image/webp") return hasWebpMagic(data);
  return false;
}

function parseDataUrl(dataUrl: string) {
  const match = /^data:(.*?);base64,(.*)$/.exec(dataUrl);
  if (!match) return null;
  const mime = match[1] || "image/png";
  if (!ALLOWED_IMAGE_MIMES.has(mime)) return null;
  const base64 = match[2];
  if (base64.length > MAX_IMAGE_BYTES * 1.37) return null;
  const data = Buffer.from(base64, "base64");
  if (data.length > MAX_IMAGE_BYTES) return null;
  if (!mimeMatchesBuffer(mime, data)) return null;
  return { mime, data };
}

function isPrivateHost(hostname: string) {
  if (!hostname) return true;
  if (hostname === "localhost" || hostname === "0.0.0.0" || hostname.endsWith(".local")) return true;
  const ipType = net.isIP(hostname);
  if (ipType === 4) {
    const parts = hostname.split(".").map((p) => Number(p));
    if (parts[0] === 10) return true;
    if (parts[0] === 127) return true;
    if (parts[0] === 169 && parts[1] === 254) return true;
    if (parts[0] === 192 && parts[1] === 168) return true;
    if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
  }
  if (ipType === 6) {
    const lower = hostname.toLowerCase();
    if (lower === "::1" || lower.startsWith("fc") || lower.startsWith("fd")) return true;
  }
  return false;
}

function isAllowedImageUrl(url: string) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") return false;
    if (isPrivateHost(parsed.hostname)) return false;
    if (!ALLOWED_IMAGE_HOSTS.length) return true;
    return ALLOWED_IMAGE_HOSTS.some(
      (host) => parsed.hostname === host || parsed.hostname.endsWith(`.${host}`)
    );
  } catch {
    return false;
  }
}

function normalizeImageUrl(url: string) {
  if (url.startsWith("ipfs://")) {
    return `https://ipfs.io/ipfs/${url.replace("ipfs://", "")}`;
  }
  return url;
}

async function loadImageBuffer(imageDataUrl?: string, imageUrl?: string) {
  if (imageDataUrl) {
    const parsed = parseDataUrl(imageDataUrl);
    if (parsed) return { buffer: parsed.data, mime: parsed.mime };
  }
  if (imageUrl) {
    const normalized = normalizeImageUrl(imageUrl);
    if (!isAllowedImageUrl(normalized)) throw new Error("Invalid image URL");
    const res = await fetch(normalized, { redirect: "manual" });
    if (res.status >= 300 && res.status < 400) throw new Error("Image URL redirects are not allowed");
    if (!res.ok) throw new Error("Failed to fetch image URL");
    const mime = (res.headers.get("content-type") || "image/png").split(";")[0].trim();
    if (!ALLOWED_IMAGE_MIMES.has(mime)) throw new Error("Unsupported image mime type");
    const contentLength = Number(res.headers.get("content-length") || 0);
    if (contentLength && contentLength > MAX_IMAGE_BYTES) throw new Error("Image too large");
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > MAX_IMAGE_BYTES) throw new Error("Image too large");
    if (!mimeMatchesBuffer(mime, buf)) throw new Error("Image data did not match mime type");
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
  const envCollection =
    process.env.TRASHTECH_COLLECTION_MINT ||
    process.env.COLLECTION_MINT ||
    process.env.NEXT_PUBLIC_TRASHTECH_COLLECTION_MINT;
  if (envCollection) {
    params.ledger.collectionMint = envCollection;
    saveLedger(params.ledger);
    return new PublicKey(envCollection);
  }
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
  const { nft } = await metaplex.nfts().create(
    {
      uri: metadataUrl,
      name: "TrashTech",
      symbol: "TRASH",
      sellerFeeBasisPoints: 0,
      tokenOwner: params.payer.publicKey,
      isMutable: true,
      isCollection: true,
    },
    {
      commitment: "processed",
      confirmOptions: MINT_CONFIRM_OPTIONS,
    }
  );

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
  const { nft } = await metaplex.nfts().create(
    {
      uri: params.metadataUrl,
      name: params.name,
      symbol: "TRASH",
      sellerFeeBasisPoints: 0,
      tokenOwner: params.owner,
      isMutable: true,
      collection: params.collectionMint ?? null,
      collectionAuthority: params.collectionMint ? params.payer : null,
      collectionIsSized: params.collectionMint ? true : undefined,
    },
    {
      commitment: "processed",
      confirmOptions: MINT_CONFIRM_OPTIONS,
    }
  );
  return nft.address.toBase58();
}

function isRetryableChainError(err: any) {
  const msg = String(err?.message || err || "").toLowerCase();
  return (
    msg.includes("block height exceeded") ||
    msg.includes("blockhash not found") ||
    msg.includes("transactionexpiredblockheightexceedederror") ||
    msg.includes("has expired") ||
    msg.includes("could not be confirmed")
  );
}

async function withChainRetry<T>(fn: () => Promise<T>, maxAttempts = 6): Promise<T> {
  let lastErr: any = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err: any) {
      lastErr = err;
      if (!isRetryableChainError(err) || attempt === maxAttempts) {
        throw err;
      }
      await new Promise((r) => setTimeout(r, 1200 * attempt));
    }
  }
  throw lastErr || new Error("Chain operation failed");
}

function getFeePayer(tx: any) {
  const keys = tx?.transaction?.message?.accountKeys;
  if (!Array.isArray(keys) || keys.length === 0) return null;
  const first = keys[0];
  return first?.pubkey ? first.pubkey.toBase58() : first?.toBase58?.();
}

function verifyPaymentInstruction(tx: any, payer: PublicKey, treasury: PublicKey, expectedLamports: bigint) {
  const instructions = tx?.transaction?.message?.instructions || [];
  for (const ix of instructions) {
    const program = ix?.program || ix?.programId?.toBase58?.();
    if (program !== "system" && program !== SystemProgram.programId.toBase58()) continue;
    if (ix?.parsed?.type !== "transfer") continue;
    const info = ix?.parsed?.info;
    if (!info) continue;
    if (info.source !== payer.toBase58()) continue;
    if (info.destination !== treasury.toBase58()) continue;
    const lamports = BigInt(info.lamports || 0);
    if (lamports >= expectedLamports) return true;
  }
  return false;
}

const DEBUG_VERIFY = (process.env.DEBUG_VERIFY || "").toLowerCase() === "true";
const MINT_CONFIRM_OPTIONS = {
  commitment: "processed" as const,
  preflightCommitment: "processed" as const,
  skipPreflight: true,
  maxRetries: 30,
};

export async function POST(req: Request) {
  if (!rateLimit(req, "verify", 10, 60_000)) return rateLimitResponse();

  const contentLength = Number(req.headers.get("content-length") || 0);
  if (contentLength && contentLength > MAX_BODY_BYTES) {
    return NextResponse.json({ error: "Request too large" }, { status: 413 });
  }

  let body: {
    signature?: string;
    payer?: string;
    machine?: Machine;
    originalMint?: string;
    imageDataUrl?: string;
    imageUrl?: string;
    name?: string;
  };

  try {
    body = (await req.json()) as typeof body;
  } catch (e) {
    console.error("[verify] invalid json", e);
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const sig = body?.signature?.trim();
  const payerStr = body?.payer?.trim();
  const machine = body?.machine as Machine;
  const originalMint = body?.originalMint?.trim();
  const imageDataUrl = body?.imageDataUrl;
  const imageUrl = body?.imageUrl;

  if (!sig || !isValidSignature(sig)) return NextResponse.json({ error: "Invalid signature" }, { status: 400 });
  if (!payerStr || !isValidPublicKey(payerStr)) return NextResponse.json({ error: "Invalid payer" }, { status: 400 });
  if (!originalMint || !isValidPublicKey(originalMint)) {
    return NextResponse.json({ error: "Invalid originalMint" }, { status: 400 });
  }
  if (!machine || !["CONVEYOR", "COMPACTOR", "HAZMAT"].includes(machine)) {
    return NextResponse.json({ error: "Invalid machine" }, { status: 400 });
  }
  if (!imageDataUrl && !imageUrl) {
    return NextResponse.json({ error: "Missing remix image" }, { status: 400 });
  }

  if (inFlightSignatures.has(sig) || inFlightMints.has(originalMint)) {
    return NextResponse.json({ error: "This request is already being processed" }, { status: 409 });
  }

  inFlightSignatures.add(sig);
  inFlightMints.add(originalMint);

  try {
    return await withLedgerLock(async () => {
      const ledger = loadLedger();
      const persistent = await getPersistentState();
      if (await isSignatureUsed(sig)) {
        return NextResponse.json({ error: "Signature already used" }, { status: 409 });
      }
      if (ledger.usedSignatures[sig]) {
        return NextResponse.json({ error: "Signature already used" }, { status: 409 });
      }

      const payer = new PublicKey(payerStr);
      const treasury = new PublicKey(TREASURY);

      const rpcFallbacks =
        (process.env.GORBAGANA_RPC_FALLBACKS || process.env.NEXT_PUBLIC_GORBAGANA_RPC_FALLBACKS || "")
          .split(",")
          .map((s) => s.trim())
          .filter((s) => Boolean(s) && !s.includes("rpc.trashscan.io"));
      const rpcList = [SAFE_RPC, ...rpcFallbacks.filter((r) => r !== SAFE_RPC)];

      let tx: any = null;
      let connection: Connection | null = null;
      let lastErr: any = null;
      for (const rpc of rpcList) {
        try {
          const conn = new Connection(rpc, "confirmed");
          const parsed = await conn.getParsedTransaction(sig, {
            commitment: "confirmed",
            maxSupportedTransactionVersion: 0,
          });
          if (parsed) {
            tx = parsed;
            connection = conn;
            break;
          }
        } catch (err: any) {
          lastErr = err;
          const msg = String(err?.message || err || "").toLowerCase();
          if (msg.includes("block height exceeded") || msg.includes("expired") || msg.includes("not found")) {
            continue;
          }
          throw err;
        }
      }

      if (!tx || !connection) {
        const msg = String(lastErr?.message || lastErr || "").toLowerCase();
        if (msg.includes("block height exceeded") || msg.includes("expired") || msg.includes("not found")) {
          return NextResponse.json({ error: "Transaction not found yet. Try again in a moment." }, { status: 404 });
        }
        return NextResponse.json({ error: "Transaction not found yet. Try again in a moment." }, { status: 404 });
      }
      if (tx.meta?.err) {
        return NextResponse.json({ error: "Payment transaction failed" }, { status: 400 });
      }

      const feePayer = getFeePayer(tx);
      if (!feePayer || feePayer !== payer.toBase58()) {
        return NextResponse.json({ error: "Payer is not the fee payer for this transaction" }, { status: 400 });
      }

      if (Number.isFinite(MAX_TX_SLOT_AGE) && tx.slot !== null && tx.slot !== undefined) {
      const currentSlot = await connection.getSlot("confirmed");
        if (currentSlot - tx.slot > MAX_TX_SLOT_AGE) {
          return NextResponse.json({ error: "Transaction too old. Please submit a new payment." }, { status: 400 });
        }
      }

      const expected = toLamports(priceFor(machine));
      if (!verifyPaymentInstruction(tx, payer, treasury, expected)) {
        return NextResponse.json({ error: "Payment verification failed" }, { status: 400 });
      }

      const owns = await ownsMint(connection, payer, new PublicKey(originalMint));
      if (!owns) {
        return NextResponse.json({ error: "Payer does not own the selected NFT" }, { status: 403 });
      }

      const treasuryBalanceBefore = await connection.getBalance(treasury, "confirmed");
      const caps = getTierCaps();
      const persistentCounts = await getTierCountsPersistent();
      const counts = persistentCounts || getTierCounts(ledger);
      const tier = rollTier(machine, sig, counts, caps);
      if (counts[tier] >= caps[tier]) {
        return NextResponse.json({ error: "This tier is sold out" }, { status: 409 });
      }
      const effect = pickEffectFromTier(tier, sig);

      const image = await loadImageBuffer(imageDataUrl, imageUrl);
      const baseCount = persistent?.mintCount ?? ledger.mintCount ?? 0;
      const nextCount = baseCount + 1;
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
        name: sanitizeName(remixName),
        description,
        imageBuffer: image.buffer,
        imageMime: image.mime,
        attributes,
      });

      const payerKeypair = loadKeypair();
      if (persistent?.collectionMint && !ledger.collectionMint) {
        ledger.collectionMint = persistent.collectionMint;
        saveLedger(ledger);
      }
      const collectionMint = await withChainRetry(
        () => ensureCollection({ connection, payer: payerKeypair, ledger }),
        4
      );
      const minted = await withChainRetry(
        () =>
          mintStandardNft({
            connection,
            payer: payerKeypair,
            owner: payer,
            name: remixName,
            metadataUrl,
            collectionMint,
          }),
        6
      );
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
      await persistMint({
        originalMint,
        mintedMint: minted,
        signature: sig,
        payer: payer.toBase58(),
        machine,
        tier,
        mintCount: nextCount,
        collectionMint: collectionMint.toBase58(),
      });

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
        collectionMint: collectionMint.toBase58(),
      });
    });
  } catch (e: any) {
    console.error("[/api/verify] error", e);
    if (isRetryableChainError(e)) {
      return NextResponse.json(
        { error: "Chain confirmation delayed. Keep waiting.", detail: String(e?.message || e || "Unknown error") },
        { status: 503 }
      );
    }
    if (DEBUG_VERIFY) {
      return NextResponse.json(
        { error: "Verification failed", detail: String(e?.message || e || "Unknown error") },
        { status: 500 }
      );
    }
    return NextResponse.json({ error: "Verification failed. Please try again." }, { status: 500 });
  } finally {
    inFlightSignatures.delete(sig || "");
    inFlightMints.delete(originalMint || "");
  }
}
