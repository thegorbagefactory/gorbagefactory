# GorbageFactory (v1)
A simple pay-per-use web app: connect wallet → verify you own an NFT (by mint) → pay in GOR (50% burn / 50% treasury) → generate a clean "Refurbished Trash" preview image you can download.

## What this is (and is not)
- ✅ Ready-to-deploy **v1**: payment + preview generator (downloadable PNG)
- ❌ Does **not** mint a new Remix NFT yet (that's Phase 2)

## Setup
1) Install deps
   ```bash
   npm i
   ```
2) Copy env
   ```bash
   cp .env.example .env.local
   ```
3) Set env vars in `.env.local`

You must set these:
- `NEXT_PUBLIC_RPC_URL`
- `NEXT_PUBLIC_GOR_MINT`
- `NEXT_PUBLIC_TREASURY_WALLET`
- `NEXT_PUBLIC_BURN_WALLET`
- prices + `NEXT_PUBLIC_BURN_SPLIT`

**Note:** Next.js exposes only vars prefixed with `NEXT_PUBLIC_` to the client.
For convenience, this template expects those names.

4) Run
   ```bash
   npm run dev
   ```

## Deploy
- Vercel is easiest: import repo → set env vars → deploy.

## Phase 2 (Remix NFT minting)
To mint Remix NFTs, you will add:
- A backend worker to generate + pin images/metadata (Arweave/IPFS)
- A minting flow using Metaplex standards
- Idempotent payment receipts (prevent double-mints)

If you want, ask: "Add Phase 2 minting" and I’ll extend this repo with API routes and the Metaplex mint flow skeleton.
