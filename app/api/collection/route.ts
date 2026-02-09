import fs from "fs";
import path from "path";
import { NextResponse } from "next/server";

const LEDGER_PATH = process.env.REMIX_LEDGER_PATH || path.join(process.cwd(), "data", "remix-ledger.json");

function readLedgerCollection(): string | null {
  try {
    if (!fs.existsSync(LEDGER_PATH)) return null;
    const raw = fs.readFileSync(LEDGER_PATH, "utf8");
    const parsed = JSON.parse(raw);
    return typeof parsed?.collectionMint === "string" ? parsed.collectionMint : null;
  } catch {
    return null;
  }
}

export async function GET() {
  const envMint =
    process.env.TRASHTECH_COLLECTION_MINT ||
    process.env.COLLECTION_MINT ||
    process.env.NEXT_PUBLIC_TRASHTECH_COLLECTION_MINT ||
    "";

  const ledgerMint = readLedgerCollection() || "";
  const collectionMint = envMint || ledgerMint || "";

  return NextResponse.json({
    collectionMint,
    source: envMint ? "env" : ledgerMint ? "ledger" : "none",
  });
}
