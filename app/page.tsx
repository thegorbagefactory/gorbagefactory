'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Connection, PublicKey, SystemProgram, Transaction } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from '@solana/spl-token';

type Machine = 'CONVEYOR' | 'COMPACTOR' | 'HAZMAT';
type TierId = 'tier1' | 'tier2' | 'tier3';

type DasAsset = {
  id: string;
  content?: {
    metadata?: { name?: string };
    links?: { image?: string };
    files?: Array<{ uri?: string; mime?: string }>;
  };
};

type DasResponse<T> = { result?: T; error?: { message?: string } };
type SupplyState = {
  tier1: { cap: number; minted: number; remaining: number };
  tier2: { cap: number; minted: number; remaining: number };
  tier3: { cap: number; minted: number; remaining: number };
  totalCap: number;
  totalMinted: number;
};

const RPC = process.env.NEXT_PUBLIC_GORBAGANA_RPC_URL || process.env.NEXT_PUBLIC_RPC_URL || 'https://rpc.gorbagana.wtf/';

// Trashscan DAS-style endpoint (GOR)
const DAS = 'https://gorapi.trashscan.io/';

// Prices shown in UI (optional)
const PRICE_CONVEYOR_RAW = process.env.NEXT_PUBLIC_PRICE_CONVEYOR || '1';
const PRICE: Record<Machine, number> = {
  CONVEYOR: Number(PRICE_CONVEYOR_RAW),
  COMPACTOR: Number(process.env.NEXT_PUBLIC_PRICE_COMPACTOR || '3500'),
  HAZMAT: Number(process.env.NEXT_PUBLIC_PRICE_HAZMAT || '4500'),
};

const priceLabel = (machine: Machine) => {
  const value = PRICE[machine];
  if (!Number.isFinite(value) || value <= 0) return 'Mint cost';
  return `${value} $GOR`;
};

function cx(...parts: Array<string | false | null | undefined>) {
  return parts.filter(Boolean).join(' ');
}

function hash32(input: string) {
  let h = 2166136261;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function seededRng(seed: number) {
  let t = seed >>> 0;
  return () => {
    t += 0x6d2b79f5;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

function drawHazard(ctx: CanvasRenderingContext2D, x: number, y: number, size: number, color: string) {
  ctx.save();
  ctx.translate(x, y);
  ctx.strokeStyle = color;
  ctx.lineWidth = Math.max(2, size * 0.08);
  ctx.beginPath();
  ctx.arc(0, 0, size * 0.46, 0, Math.PI * 2);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(0, -size * 0.38);
  ctx.lineTo(size * 0.33, size * 0.2);
  ctx.lineTo(-size * 0.33, size * 0.2);
  ctx.closePath();
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(0, 0, size * 0.08, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
}

function drawTrashBag(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, stroke: string, fill: string) {
  ctx.save();
  ctx.translate(x, y);
  ctx.fillStyle = fill;
  ctx.strokeStyle = stroke;
  ctx.lineWidth = Math.max(2, w * 0.04);
  ctx.beginPath();
  ctx.moveTo(-w * 0.18, -h * 0.38);
  ctx.quadraticCurveTo(0, -h * 0.5, w * 0.18, -h * 0.38);
  ctx.quadraticCurveTo(w * 0.36, -h * 0.18, w * 0.32, h * 0.15);
  ctx.quadraticCurveTo(w * 0.28, h * 0.45, 0, h * 0.5);
  ctx.quadraticCurveTo(-w * 0.28, h * 0.45, -w * 0.32, h * 0.15);
  ctx.quadraticCurveTo(-w * 0.36, -h * 0.18, -w * 0.18, -h * 0.38);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  ctx.restore();
}

function drawGraffiti(ctx: CanvasRenderingContext2D, rng: () => number, w: number, h: number) {
  ctx.save();
  ctx.globalAlpha = 0.7;
  ctx.lineWidth = 6;
  ctx.strokeStyle = 'rgba(255,120,180,0.75)';
  ctx.beginPath();
  ctx.moveTo(w * 0.1, h * 0.8);
  ctx.bezierCurveTo(w * 0.3, h * 0.6, w * 0.6, h * 0.6, w * 0.9, h * 0.5);
  ctx.stroke();
  ctx.strokeStyle = 'rgba(0,255,200,0.65)';
  ctx.beginPath();
  ctx.moveTo(w * 0.15, h * 0.9);
  ctx.bezierCurveTo(w * 0.4, h * 0.75, w * 0.7, h * 0.75, w * 0.88, h * 0.7);
  ctx.stroke();
  ctx.restore();
}

function drawCautionTape(ctx: CanvasRenderingContext2D, w: number, h: number, opacity: number) {
  ctx.save();
  ctx.globalAlpha = opacity;
  ctx.translate(w * 0.05, h * 0.15);
  ctx.rotate(-0.2);
  const tapeHeight = h * 0.08;
  const tapeWidth = w * 1.1;
  ctx.fillStyle = 'rgba(20,20,20,0.35)';
  ctx.fillRect(-w * 0.1, 0, tapeWidth, tapeHeight);
  ctx.fillStyle = 'rgba(255,220,80,0.6)';
  for (let x = -w * 0.1; x < tapeWidth; x += tapeHeight) {
    ctx.fillRect(x, 0, tapeHeight * 0.6, tapeHeight);
  }
  ctx.restore();
}

function drawTrashyOverlays(
  ctx: CanvasRenderingContext2D,
  tier: TierId,
  primary: string,
  seed: string
) {
  const rng = seededRng(hash32(seed));
  const w = ctx.canvas.width;
  const h = ctx.canvas.height;
  const strength = tier === 'tier3' ? 1 : tier === 'tier2' ? 0.7 : 0.45;

  // Burned edges
  ctx.save();
  ctx.globalCompositeOperation = 'multiply';
  const burn = ctx.createRadialGradient(w * 0.5, h * 0.5, w * 0.3, w * 0.5, h * 0.5, w * 0.8);
  burn.addColorStop(0, 'rgba(0,0,0,0)');
  burn.addColorStop(1, `rgba(20,10,5,${0.55 * strength})`);
  ctx.fillStyle = burn;
  ctx.fillRect(0, 0, w, h);
  ctx.restore();

  // Color wash background (stronger on higher tiers)
  ctx.save();
  ctx.globalCompositeOperation = 'overlay';
  ctx.globalAlpha = 0.25 + 0.35 * strength;
  const wash = ctx.createLinearGradient(0, 0, w, h);
  wash.addColorStop(0, 'rgba(0,255,200,0.35)');
  wash.addColorStop(1, 'rgba(255,120,200,0.25)');
  ctx.fillStyle = wash;
  ctx.fillRect(0, 0, w, h);
  ctx.restore();

  // Dirt speckles
  ctx.save();
  ctx.globalCompositeOperation = 'multiply';
  ctx.globalAlpha = 0.18 + 0.25 * strength;
  const speckCount = Math.floor(60 + 140 * strength);
  for (let i = 0; i < speckCount; i++) {
    const x = rng() * w;
    const y = rng() * h;
    const r = 2 + rng() * 6;
    ctx.fillStyle = 'rgba(30,25,20,0.5)';
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();

  // Primary-specific decals
  ctx.save();
  ctx.globalCompositeOperation = 'screen';
  ctx.globalAlpha = 0.5 + 0.3 * strength;
  if (primary.includes('Graffiti') || tier === 'tier3') {
    drawGraffiti(ctx, rng, w, h);
  }
  if (
    primary.includes('Biohazard') ||
    primary.includes('Nuclear') ||
    primary.includes('Toxic') ||
    primary.includes('Quarantine') ||
    tier !== 'tier1'
  ) {
    drawHazard(ctx, w * 0.78, h * 0.22, w * 0.2, 'rgba(255,220,120,0.9)');
    drawHazard(ctx, w * 0.2, h * 0.75, w * 0.14, 'rgba(255,220,120,0.7)');
  }
  if (primary.includes('Dumpster') || primary.includes('Leachate') || primary.includes('Smog') || tier === 'tier3') {
    drawTrashBag(ctx, w * 0.2, h * 0.75, w * 0.22, h * 0.26, 'rgba(200,200,200,0.6)', 'rgba(30,30,30,0.6)');
  }
  if (tier === 'tier3') {
    drawCautionTape(ctx, w, h, 0.55);
  }
  if (tier === 'tier3') {
    drawTrashBag(ctx, w * 0.78, h * 0.68, w * 0.2, h * 0.24, 'rgba(200,200,200,0.5)', 'rgba(20,20,20,0.55)');
    drawGraffiti(ctx, rng, w, h);
  }
  ctx.restore();
}

function drawPreviewCanvas(
  canvas: HTMLCanvasElement,
  img: HTMLImageElement,
  tier: TierId,
  primary: string,
  seed: string
) {
  const size = 1024;
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.clearRect(0, 0, size, size);

  const scale = Math.max(size / img.width, size / img.height);
  const dw = img.width * scale;
  const dh = img.height * scale;
  const dx = (size - dw) / 2;
  const dy = (size - dh) / 2;

  // Base draw
  ctx.drawImage(img, dx, dy, dw, dh);

  // Strong color transform by tier
  ctx.save();
  ctx.filter =
    tier === 'tier3'
      ? 'invert(0.32) hue-rotate(130deg) saturate(2.1) contrast(1.55) brightness(1.06)'
      : tier === 'tier2'
        ? 'hue-rotate(50deg) saturate(1.55) contrast(1.3) brightness(1.02)'
        : 'saturate(1.25) contrast(1.12)';
  ctx.drawImage(img, dx, dy, dw, dh);
  ctx.restore();

  drawTrashyOverlays(ctx, tier, primary, seed);
}
function rollTierLocal(machine: Machine, seed: string): TierId {
  const n = (hash32(seed) % 10000) / 10000;
  if (machine === 'CONVEYOR') {
    if (n < 0.8) return 'tier1';
    if (n < 0.98) return 'tier2';
    return 'tier3';
  }
  if (machine === 'COMPACTOR') {
    if (n < 0.65) return 'tier1';
    if (n < 0.95) return 'tier2';
    return 'tier3';
  }
  if (n < 0.45) return 'tier1';
  if (n < 0.9) return 'tier2';
  return 'tier3';
}

const PRIMARY_POOLS: Record<TierId, string[]> = {
  tier1: ['Graffiti Tag', 'Rust Chrome', 'Oil Slick', 'Grime Wash', 'Dusty Circuit', 'Soot Fade'],
  tier2: ['Toxic Slime Glow', 'Dumpster Drip', 'Smog Streaks', 'Mold Bloom', 'Leachate Sheen', 'Grease Halo'],
  tier3: [
    'Biohazard Aura',
    'Radiation Veil',
    'Acid Mist',
    'Liquid Metal Mirror',
    'Nuclear Afterglow',
    'Gamma Bloom',
    'Golden Dumpster (Mythic)',
  ],
};

const TEXTURE_POOLS = ['Grime Film', 'Oil Vignette', 'Smog Haze', 'Mold Bloom', 'Leachate Drip', 'Soot Dust'];
const GLOW_POOLS = ['Toxic Teal', 'Amber Rust', 'Magenta Spill', 'Lime Halo', 'Cold Cyan'];
const EDGE_POOLS = ['Clean Edge', 'Pitted Edge', 'Burnt Edge', 'Stickered Edge'];

function getBackpackProvider() {
  const w = window as any;
  if (w?.backpack?.solana) return w.backpack.solana;
  const providers = w?.solana?.providers;
  if (Array.isArray(providers)) {
    const found = providers.find((p: any) => p?.isBackpack);
    if (found) return found;
  }
  if (w?.solana?.isBackpack) return w.solana;
  throw new Error('Backpack not found. Install + unlock Backpack extension.');
}

async function connectBackpack(): Promise<string> {
  const p = getBackpackProvider();
  let res: any = null;
  try {
    res = await p.connect({ onlyIfTrusted: false });
  } catch (e) {
    // Some Backpack builds require request({ method: 'connect' }) to trigger the prompt
    if (p?.request) {
      try {
        res = await p.request({ method: 'connect', params: { onlyIfTrusted: false } });
      } catch (e2) {
        throw e2;
      }
    } else {
      throw e;
    }
  }
  const pk = res?.publicKey ?? p.publicKey;
  if (!pk) throw new Error('Backpack connected but no publicKey returned.');
  return pk.toString();
}

async function fetchDas<T>(method: string, params: any, signal?: AbortSignal): Promise<T> {
  const res = await fetch(DAS, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: '1', method, params }),
    signal,
  });
  const data = (await res.json()) as DasResponse<T>;
  if (data?.error?.message) throw new Error(data.error.message);
  if (!data?.result) throw new Error('No result from DAS');
  return data.result;
}

async function fetchDasWithTimeout<T>(method: string, params: any, timeoutMs: number): Promise<T> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchDas<T>(method, params, controller.signal);
  } finally {
    window.clearTimeout(timer);
  }
}

function pickImage(asset: DasAsset): string | '' {
  const img = asset?.content?.links?.image;
  if (img) return img;
  const files = asset?.content?.files || [];
  const imageFile = files.find((f) => (f?.mime || '').startsWith('image/') && f?.uri);
  return imageFile?.uri || '';
}

export default function Page() {
  const previewCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const imgUrlRef = useRef<string>('');
  const beltRef = useRef<HTMLDivElement | null>(null);
  const beltBackRef = useRef<HTMLDivElement | null>(null);
  const beltTrashRef = useRef<HTMLDivElement | null>(null);
  const beltTrashBackRef = useRef<HTMLDivElement | null>(null);
  const compactorTopRef = useRef<HTMLDivElement | null>(null);
  const compactorPlateRef = useRef<HTMLDivElement | null>(null);
  const trashPileRef = useRef<HTMLDivElement | null>(null);
  const compactorBaleRef = useRef<HTMLDivElement | null>(null);
  const [wallet, setWallet] = useState<string>('');
  const [walletErr, setWalletErr] = useState<string>('');
  const [loadingNfts, setLoadingNfts] = useState(false);
  const [isMinting, setIsMinting] = useState(false);
  const [supply, setSupply] = useState<SupplyState | null>(null);
  const [nfts, setNfts] = useState<DasAsset[]>([]);
  const [selected, setSelected] = useState<DasAsset | null>(null);

  const [machine, setMachine] = useState<Machine>('CONVEYOR');
  const [status, setStatus] = useState<string>('Connect Backpack to load your NFTs.');
  const [effectCycle, setEffectCycle] = useState(0);

  const selectedImage = useMemo(() => (selected ? pickImage(selected) : ''), [selected]);
  const effectClass = useMemo(() => {
    if (machine === 'HAZMAT') return 'gf-effectHazmat';
    if (machine === 'COMPACTOR') return 'gf-effectCompactor';
    return 'gf-effectConveyor';
  }, [machine]);
  const effectTraits = useMemo(() => {
    const tierCycle =
      machine === 'CONVEYOR'
        ? (['tier2', 'tier1'] as TierId[])
        : machine === 'COMPACTOR'
          ? (['tier3', 'tier2'] as TierId[])
          : (['tier3'] as TierId[]);
    const tier = tierCycle[effectCycle % tierCycle.length];
    const primaryPool = PRIMARY_POOLS[tier];
    const primaryIndex = Math.floor(effectCycle / tierCycle.length) % primaryPool.length;
    const primary = primaryPool[primaryIndex];
    const texture = TEXTURE_POOLS[effectCycle % TEXTURE_POOLS.length];
    const glow = GLOW_POOLS[effectCycle % GLOW_POOLS.length];
    const edge = EDGE_POOLS[effectCycle % EDGE_POOLS.length];
    return { tier, primary, texture, glow, edge };
  }, [machine, effectCycle]);
  const previewSeed = useMemo(() => {
    return `${selectedImage}|${effectTraits.tier}|${effectTraits.primary}|${effectCycle}`;
  }, [selectedImage, effectTraits.tier, effectTraits.primary, effectCycle]);

  const tier1Supply = supply?.tier1 ?? { cap: 0, minted: 0, remaining: 0 };
  const tier2Supply = supply?.tier2 ?? { cap: 0, minted: 0, remaining: 0 };
  const tier3Supply = supply?.tier3 ?? { cap: 0, minted: 0, remaining: 0 };
  const tier1Pct = tier1Supply.cap ? Math.max(0, Math.min(100, (tier1Supply.remaining / tier1Supply.cap) * 100)) : 0;
  const tier2Pct = tier2Supply.cap ? Math.max(0, Math.min(100, (tier2Supply.remaining / tier2Supply.cap) * 100)) : 0;
  const tier3Pct = tier3Supply.cap ? Math.max(0, Math.min(100, (tier3Supply.remaining / tier3Supply.cap) * 100)) : 0;
  const tier1Sold = tier1Supply.cap > 0 && tier1Supply.remaining <= 0;
  const tier2Sold = tier2Supply.cap > 0 && tier2Supply.remaining <= 0;
  const tier3Sold = tier3Supply.cap > 0 && tier3Supply.remaining <= 0;

  const statusInfo = useMemo(() => {
    const raw = status || '';
    const lower = raw.toLowerCase();
    if (!raw) return null;
    if (lower.includes('insufficient')) return { type: 'error' as const, label: raw };
    if (
      lower.includes('processing') ||
      lower.includes('compacting') ||
      lower.includes('preparing') ||
      lower.includes('approve payment') ||
      lower.includes('payment sent') ||
      lower.includes('finalizing') ||
      lower.includes('minting') ||
      lower.includes('verifying')
    ) {
      return { type: 'progress' as const, label: raw };
    }
    if (raw.startsWith('Minted:')) return { type: 'success' as const, label: 'Trash Successfully Minted.' };
    return null;
  }, [status]);

  useEffect(() => {
    if (!selectedImage) return;
    if (imgUrlRef.current === selectedImage && imgRef.current) return;
    imgUrlRef.current = selectedImage;
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      imgRef.current = img;
      if (previewCanvasRef.current) {
        drawPreviewCanvas(previewCanvasRef.current, img, effectTraits.tier, effectTraits.primary, previewSeed);
      }
    };
    img.src = selectedImage;
  }, [selectedImage, effectTraits.tier, effectTraits.primary, previewSeed]);

  useEffect(() => {
    if (!selectedImage || !imgRef.current || !previewCanvasRef.current) return;
    drawPreviewCanvas(previewCanvasRef.current, imgRef.current, effectTraits.tier, effectTraits.primary, previewSeed);
  }, [selectedImage, effectTraits.tier, effectTraits.primary, previewSeed]);
  const tierClass = useMemo(() => `gf-tier-${effectTraits.tier}`, [effectTraits.tier]);
  useEffect(() => {
    if (!selected) return;
    const id = setInterval(() => {
      setEffectCycle((v) => v + 1);
    }, 3200);
    return () => clearInterval(id);
  }, [selected?.id, machine]);
  useEffect(() => {
    setEffectCycle(0);
  }, [machine, selected?.id]);

  useEffect(() => {
    let raf = 0;
    let lastFrame = 0;
    const start = performance.now();
    const belt = beltRef.current;
    const beltBack = beltBackRef.current;
    const beltTrash = beltTrashRef.current;
    const beltTrashBack = beltTrashBackRef.current;
    const beltTreads = belt?.querySelector('.gf-beltTreads') as HTMLDivElement | null;
    const beltBackTreads = beltBack?.querySelector('.gf-beltTreads') as HTMLDivElement | null;
    const compactorTop = compactorTopRef.current;
    const compactorPlate = compactorPlateRef.current;
    const trashPile = trashPileRef.current;
    const compactorBale = compactorBaleRef.current;
    const trashEls = beltTrash ? Array.from(beltTrash.querySelectorAll('span')) : [];
    const trashBackEls = beltTrashBack ? Array.from(beltTrashBack.querySelectorAll('span')) : [];

    let beltWidth = beltTrash?.offsetWidth || 0;
    let beltBackWidth = beltTrashBack?.offsetWidth || 0;
    let beltTravel = beltWidth ? beltWidth + 240 : 0;
    let beltBackTravel = beltBackWidth ? beltBackWidth + 240 : 0;

    const updateBeltSizes = () => {
      beltWidth = beltTrash?.offsetWidth || beltWidth;
      beltBackWidth = beltTrashBack?.offsetWidth || beltBackWidth;
      beltTravel = beltWidth ? beltWidth + 240 : beltTravel;
      beltBackTravel = beltBackWidth ? beltBackWidth + 240 : beltBackTravel;
    };

    updateBeltSizes();

    let resizeObserver: ResizeObserver | null = null;
    if (typeof ResizeObserver !== 'undefined') {
      resizeObserver = new ResizeObserver(() => updateBeltSizes());
      if (beltTrash) resizeObserver.observe(beltTrash);
      if (beltTrashBack) resizeObserver.observe(beltTrashBack);
    } else {
      window.addEventListener('resize', updateBeltSizes);
    }

    const loop = (now: number) => {
      if (document.hidden) {
        raf = requestAnimationFrame(loop);
        return;
      }
      if (now - lastFrame < 33) {
        raf = requestAnimationFrame(loop);
        return;
      }
      lastFrame = now;
      const t = (now - start) / 1000;

      if (belt) {
        const x = -((t * 60) % 640);
        if (beltTreads) beltTreads.style.transform = `translate3d(${x}px, 0, 0)`;
      }
      if (beltBack) {
        const x = -((t * 40) % 480);
        if (beltBackTreads) beltBackTreads.style.transform = `translate3d(${x}px, 0, 0)`;
      }
      if (beltTrash) {
        if (!beltTravel) updateBeltSizes();
        trashEls.forEach((el) => {
          const base = Number(el.getAttribute('data-base') || '0');
          const speed = Number(el.getAttribute('data-speed') || '18');
          const rot = Number(el.getAttribute('data-rot') || '0');
          const x = beltWidth + 120 - ((t * speed + base * beltWidth) % beltTravel);
          el.style.transform = `translate3d(${x}px, 0, 0) rotate(${rot}deg)`;
        });
      }
      if (beltTrashBack) {
        if (!beltBackTravel) updateBeltSizes();
        trashBackEls.forEach((el) => {
          const base = Number(el.getAttribute('data-base') || '0');
          const speed = Number(el.getAttribute('data-speed') || '14');
          const rot = Number(el.getAttribute('data-rot') || '0');
          const x = beltBackWidth + 120 - ((t * speed + base * beltBackWidth) % beltBackTravel);
          el.style.transform = `translate3d(${x}px, 0, 0) rotate(${rot}deg)`;
        });
      }
      if (compactorTop) {
        const phase = (t % 3.6) / 3.6;
        let press = 0;
        if (phase < 0.5) {
          press = phase / 0.5;
        } else if (phase < 0.7) {
          press = 1;
        } else if (phase < 0.9) {
          press = 1 - (phase - 0.7) / 0.2;
        } else {
          press = 0;
        }

        compactorTop.style.transform = `translate3d(0, ${press * 36}px, 0)`;
        if (compactorPlate) {
          compactorPlate.style.transform = `translate3d(0, ${press * 68}px, 0)`;
        }
        if (trashPile) {
          let pileScaleY = 1 - press * 0.75;
          let pileScaleX = 1 + press * 0.08;
          let pileOpacity = 1 - press * 0.4;
          if (phase > 0.62) {
            const fade = Math.min((phase - 0.62) / 0.16, 1);
            pileOpacity = 1 - fade;
            pileScaleY = Math.max(pileScaleY, 0.22);
          }
          if (phase > 0.92) {
            pileScaleY = 1;
            pileScaleX = 1;
            pileOpacity = 1;
          }
          trashPile.style.transform = `translate3d(-50%, ${press * 8}px, 0) scale(${pileScaleX}, ${pileScaleY})`;
          trashPile.style.opacity = `${pileOpacity}`;
        }
        if (compactorBale) {
          let baleScale = 0.25;
          let baleOpacity = 0;
          let baleLift = 0;
          if (phase >= 0.62 && phase < 0.82) {
            const local = (phase - 0.62) / 0.2;
            baleScale = 0.55 + local * 0.55;
            baleOpacity = local;
          } else if (phase >= 0.82 && phase < 0.95) {
            const local = (phase - 0.82) / 0.13;
            baleScale = 1.1 - local * 0.15;
            baleOpacity = 1 - local * 0.7;
            baleLift = local * 10;
          }
          compactorBale.style.transform = `translate3d(0, ${press * 12 - baleLift}px, 0) scale(${baleScale})`;
          compactorBale.style.opacity = `${baleOpacity}`;
        }
      }

      raf = requestAnimationFrame(loop);
    };

    raf = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(raf);
      if (resizeObserver) resizeObserver.disconnect();
      if (!resizeObserver) window.removeEventListener('resize', updateBeltSizes);
    };
  }, []);
  const textureClass = useMemo(() => {
    const map: Record<string, string> = {
      'Grime Film': 'gf-textureGrime',
      'Oil Vignette': 'gf-textureOil',
      'Smog Haze': 'gf-textureSmog',
      'Mold Bloom': 'gf-textureMold',
      'Leachate Drip': 'gf-textureDrip',
      'Soot Dust': 'gf-textureSoot',
    };
    return map[effectTraits.texture] || '';
  }, [effectTraits.texture]);
  const glowClass = useMemo(() => {
    const map: Record<string, string> = {
      'Toxic Teal': 'gf-glowToxic',
      'Amber Rust': 'gf-glowAmber',
      'Magenta Spill': 'gf-glowMagenta',
      'Lime Halo': 'gf-glowLime',
      'Cold Cyan': 'gf-glowCyan',
    };
    return map[effectTraits.glow] || '';
  }, [effectTraits.glow]);
  const primaryClass = useMemo(() => {
    const map: Record<string, string> = {
      'Graffiti Tag': 'gf-primaryGraffiti',
      'Rust Chrome': 'gf-primaryRust',
      'Oil Slick': 'gf-primaryOil',
      'Toxic Slime Glow': 'gf-primarySlime',
      'Biohazard Aura': 'gf-primaryBio',
      'Black Bag Void': 'gf-primaryVoid',
      'Golden Dumpster (Mythic)': 'gf-primaryGold',
      'Gamma Bloom': 'gf-primaryInvert',
      'Void of Refuse': 'gf-primaryInvert',
      'Toxic Eclipse': 'gf-primaryHazard',
      'Quarantine Pulse': 'gf-primaryHazard',
      'Nuclear Afterglow': 'gf-primaryHazard',
      'Plasma Spill': 'gf-primaryHazard',
      'Dumpster Drip': 'gf-primaryBag',
      'Leachate Sheen': 'gf-primaryBag',
      'Smog Streaks': 'gf-primaryBag',
    };
    return map[effectTraits.primary] || 'gf-primaryDefault';
  }, [effectTraits.primary]);
  const edgeClass = useMemo(() => {
    const map: Record<string, string> = {
      'Clean Edge': 'gf-edgeClean',
      'Pitted Edge': 'gf-edgePitted',
      'Burnt Edge': 'gf-edgeBurnt',
      'Stickered Edge': 'gf-edgeSticker',
    };
    return map[effectTraits.edge] || '';
  }, [effectTraits.edge]);

  // Keep your conveyor vibe background (same classes as your original)
  const connection = useMemo(() => new Connection(RPC, 'confirmed'), []);

  async function onConnect() {
    try {
      setWalletErr('');
      setStatus('Connecting Backpack…');
      const pk = await connectBackpack();
      setWallet(pk);
      setStatus('Connected. Loading NFTs…');
    } catch (e: any) {
      const msg = e?.message ?? 'Failed to connect Backpack';
      if (msg.includes('Not Connected')) {
        setWalletErr('Backpack is installed but not connected. Open the Backpack extension and approve this site.');
      } else {
        setWalletErr(msg);
      }
      setStatus('Connect failed.');
    }
  }

  async function onDisconnect() {
    try {
      const p = (window as any)?.backpack?.solana;
      if (p?.disconnect) await p.disconnect();
    } finally {
      setWallet('');
      setNfts([]);
      setSelected(null);
      setStatus('Disconnected.');
    }
  }

  function cacheKey(owner: string) {
    return `gf-nfts-${owner}`;
  }

  function readCachedNfts(owner: string): DasAsset[] {
    try {
      const raw = localStorage.getItem(cacheKey(owner));
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed as DasAsset[];
    } catch {
      return [];
    }
  }

  function writeCachedNfts(owner: string, assets: DasAsset[]) {
    try {
      localStorage.setItem(cacheKey(owner), JSON.stringify(assets.slice(0, 50)));
    } catch {
      // ignore
    }
  }

  async function fetchAssetsByMintIds(mints: string[], limit = 40) {
    const slice = mints.slice(0, limit);
    const out: DasAsset[] = [];
    const concurrency = 6;
    let idx = 0;
    const workers = Array.from({ length: concurrency }, async () => {
      while (idx < slice.length) {
        const mint = slice[idx++];
        try {
          const asset = (await fetchDasWithTimeout('getAsset', { id: mint }, 4500)) as DasAsset;
          if (asset && pickImage(asset)) out.push(asset);
        } catch {
          // ignore
        }
      }
    });
    await Promise.all(workers);
    return out;
  }

  async function loadNfts(owner: string) {
    setLoadingNfts(true);
    setStatus(`Loading NFTs for ${owner.slice(0, 6)}…`);
    try {
      const cached = readCachedNfts(owner);
      if (cached.length) {
        setNfts(cached);
        if (!selected && cached[0]) setSelected(cached[0]);
      }

      const timeoutMs = 4500;
      const controller = new AbortController();
      const timer = window.setTimeout(() => controller.abort(), timeoutMs);

      const dasPromise = fetch(`/api/nfts?owner=${owner}`, { signal: controller.signal })
        .then((res) => res.json())
        .then((data) => {
          const items: DasAsset[] = data?.items || [];
          return items.filter((a) => pickImage(a));
        });

      const directDasPromise = fetchDasWithTimeout<any>(
        'getAssetsByOwner',
        { ownerAddress: owner, page: 1, limit: 50 },
        6000
      ).then((result) => {
        const items: DasAsset[] = result?.items || result?.assets || [];
        return items.filter((a) => pickImage(a));
      });

      const tokenPromise = fetchMintsFromOwner(owner).then(async (mints) => {
        if (!mints.length) return [] as DasAsset[];
        return await fetchAssetsByMintIds(mints, 40);
      });

      const first = await Promise.race([dasPromise, directDasPromise, tokenPromise]);
      window.clearTimeout(timer);

      if (first.length) {
        setNfts(first);
        writeCachedNfts(owner, first);
        if (!selected && first[0]) setSelected(first[0]);
        setStatus('Select an NFT to remix.');
        return;
      }

      const [dasAssets, directAssets, tokenAssets] = await Promise.allSettled([
        dasPromise,
        directDasPromise,
        tokenPromise,
      ]);
      const merged = [
        ...(dasAssets.status === 'fulfilled' ? dasAssets.value : []),
        ...(directAssets.status === 'fulfilled' ? directAssets.value : []),
        ...(tokenAssets.status === 'fulfilled' ? tokenAssets.value : []),
      ];
      const unique = merged.filter((asset, idx, arr) => arr.findIndex((a) => a.id === asset.id) === idx);
      if (unique.length) {
        setNfts(unique);
        writeCachedNfts(owner, unique);
        if (!selected && unique[0]) setSelected(unique[0]);
        setStatus('Select an NFT to remix.');
        return;
      }

      setNfts([]);
      setStatus('No NFTs found yet. Retrying…');
    } catch (e: any) {
      const msg = String(e?.message || e || '').toLowerCase();
      if (msg.includes('aborted') || msg.includes('abort')) {
        setStatus('NFT index is slow. Still searching…');
      } else {
        setStatus(e?.message ?? 'Failed to load NFTs.');
      }
    } finally {
      setLoadingNfts(false);
    }
  }

  const autoRetryRef = useRef<{ owner: string; attempts: number; timer?: number } | null>(null);

  useEffect(() => {
    if (!wallet) return;
    if (nfts.length) {
      if (autoRetryRef.current?.timer) window.clearTimeout(autoRetryRef.current.timer);
      autoRetryRef.current = null;
      return;
    }
    if (loadingNfts) return;

    const state = autoRetryRef.current;
    const attempts = state?.owner === wallet ? state.attempts : 0;
    if (attempts >= 8) return;

    const delay = attempts < 2 ? 900 : attempts < 4 ? 1600 : attempts < 6 ? 2400 : 3200;
    const timer = window.setTimeout(() => {
      autoRetryRef.current = { owner: wallet, attempts: attempts + 1 };
      loadNfts(wallet);
    }, delay);
    autoRetryRef.current = { owner: wallet, attempts, timer };

    return () => {
      window.clearTimeout(timer);
    };
  }, [wallet, nfts.length, loadingNfts]);

  async function fetchMintsFromOwner(ownerStr: string): Promise<string[]> {
    const owner = new PublicKey(ownerStr);
    const mints = new Set<string>();

    const programIds = [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID];
    for (const programId of programIds) {
      const resp = await connection.getParsedTokenAccountsByOwner(owner, { programId });
      for (const { account } of resp.value) {
        const info: any = account.data.parsed?.info;
        const mint = info?.mint;
        const amount = Number(info?.tokenAmount?.uiAmount ?? 0);
        const decimals = Number(info?.tokenAmount?.decimals ?? 0);
        if (mint && amount > 0 && decimals === 0) mints.add(mint);
      }
    }
    return Array.from(mints);
  }

  useEffect(() => {
    if (wallet) loadNfts(wallet);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wallet]);

  async function loadSupply() {
    try {
      const res = await fetch('/api/supply', { cache: 'no-store' });
      const data = await res.json();
      if (res.ok && data?.supply) {
        setSupply(data.supply as SupplyState);
      }
    } catch {
      // ignore
    }
  }

  useEffect(() => {
    loadSupply();
  }, []);

  async function payAndRunLine() {
    if (!wallet) return setStatus('Connect Backpack first.');
    if (!selected) return setStatus('Select an NFT first.');
    if (isMinting) return setStatus('Already processing a mint. Please wait.');

    setIsMinting(true);
    try {
      setStatus('Preparing payment quote...');
      const quoteRes = await fetch('/api/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ machine }),
      });
      const quote = await quoteRes.json();
      if (!quoteRes.ok || !quote?.ok) {
        throw new Error(quote?.error || 'Failed to create payment quote.');
      }

      const provider = getBackpackProvider();
      const payer = new PublicKey(wallet);
      const treasury = new PublicKey(quote.treasury);
      const lamports = Number(quote.amountLamports);
      if (!Number.isFinite(lamports) || lamports <= 0) throw new Error('Invalid payment amount.');

      const signAndSendWithTimeout = async (tx: Transaction, timeoutMs = 12000) => {
        const attempt = provider?.signAndSendTransaction(tx);
        if (!attempt) throw new Error('Wallet does not support signAndSendTransaction.');
        const timeout = new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Wallet did not respond. Please approve again.')), timeoutMs)
        );
        return (await Promise.race([attempt, timeout])) as any;
      };

      const sendWithRetry = async () => {
        const maxAttempts = 4;
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
          try {
            let sig = '';
            if (provider?.signAndSendTransaction) {
              const { blockhash } = await connection.getLatestBlockhash('processed');
              const tx = new Transaction().add(
                SystemProgram.transfer({
                  fromPubkey: payer,
                  toPubkey: treasury,
                  lamports,
                })
              );
              tx.feePayer = payer;
              tx.recentBlockhash = blockhash;
              setStatus(`Approve payment in Backpack now… (${attempt}/${maxAttempts})`);
              try {
                const res = await signAndSendWithTimeout(tx);
                sig = res?.signature || res;
              } catch (err: any) {
                const msg = String(err?.message || err || '');
                if (msg.toLowerCase().includes('closed') || msg.toLowerCase().includes('rejected')) {
                  throw err;
                }
                const match = msg.match(/Signature ([1-9A-HJ-NP-Za-km-z]{80,90})/);
                if (match?.[1]) {
                  sig = match[1];
                } else {
                  throw err;
                }
              }
            } else if (provider?.signTransaction) {
              const { blockhash } = await connection.getLatestBlockhash('processed');
              const tx = new Transaction().add(
                SystemProgram.transfer({
                  fromPubkey: payer,
                  toPubkey: treasury,
                  lamports,
                })
              );
              tx.recentBlockhash = blockhash;
              tx.feePayer = payer;
              const feeInfo = await connection.getFeeForMessage(tx.compileMessage(), 'confirmed');
              const feeLamports = feeInfo?.value ?? 0;
              const balance = await connection.getBalance(payer, 'confirmed');
              if (balance < lamports + feeLamports) {
                const short = lamports + feeLamports - balance;
                const shortGor = short / 1_000_000_000;
                throw new Error(`Insufficient $GOR. Add at least ${shortGor.toFixed(6)} $GOR for fees.`);
              }
              setStatus(`Approve payment in Backpack now… (${attempt}/${maxAttempts})`);
              const signed = await provider.signTransaction(tx);
              sig = await connection.sendRawTransaction(signed.serialize(), {
                skipPreflight: false,
                maxRetries: 5,
                preflightCommitment: 'confirmed',
              });
            } else {
              throw new Error('Wallet does not support transaction signing.');
            }

            setStatus('Payment sent. Verifying on-chain...');
            return sig;
          } catch (err: any) {
            const msg = String(err?.message || err || '').toLowerCase();
            if (msg.includes('rejected') || msg.includes('closed')) {
              throw err;
            }
            if (msg.includes('block height exceeded') || msg.includes('blockhash not found') || msg.includes('expired')) {
              setStatus('Transaction expired. Please approve again...');
              continue;
            }
            throw err;
          }
        }
        throw new Error('Transaction expired. Please try again.');
      };

      const signature = await sendWithRetry();

      let imageDataUrl = '';
      try {
        if (previewCanvasRef.current) imageDataUrl = previewCanvasRef.current.toDataURL('image/png');
      } catch {
        imageDataUrl = '';
      }

      setStatus('Minting your remix...');
      const verifyWithRetry = async () => {
        const maxVerify = 6;
        for (let attempt = 1; attempt <= maxVerify; attempt++) {
          const verifyRes = await fetch('/api/verify', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              signature,
              payer: wallet,
              machine,
              originalMint: selected.id,
              imageDataUrl,
              imageUrl: selectedImage,
              name: selected?.content?.metadata?.name || 'NFT',
            }),
          });
          const verify = await verifyRes.json();
          if (verifyRes.ok && verify?.ok) return verify;
          const errMsg = String(verify?.error || '').toLowerCase();
          if (verifyRes.status === 404 || errMsg.includes('not found')) {
            setStatus(`Finalizing payment... (${attempt}/${maxVerify})`);
            await new Promise((r) => setTimeout(r, 2000));
            continue;
          }
          throw new Error(verify?.error || 'Mint failed.');
        }
        throw new Error('Transaction not found yet. Please try again in a moment.');
      };
      const verify = await verifyWithRetry();

      setStatus(
        `Minted: ${verify.minted} • Tier: ${verify.tier} • Effect: ${verify.effect}`
      );
      loadSupply();
    } catch (e: any) {
      setStatus(e?.message ?? 'Payment or mint failed.');
    } finally {
      setIsMinting(false);
    }
  }

  return (
    <div className="gf-root">
      <div className="gf-bg">
        <div className="gf-bgGlow gf-bgGlowA" />
        <div className="gf-bgGlow gf-bgGlowB" />
        <div className="gf-belt" ref={beltRef}>
          <div className="gf-beltTreads" />
        </div>
        <div className="gf-belt gf-beltBack" ref={beltBackRef}>
          <div className="gf-beltTreads" />
        </div>
        <div className="gf-beltTrash gf-beltTrashBack" ref={beltTrashBackRef}>
          <span className="t9" data-base="0.12" data-speed="12" data-rot="5" />
          <span className="t10" data-base="0.34" data-speed="10" data-rot="-4" />
          <span className="t11" data-base="0.58" data-speed="13" data-rot="7" />
          <span className="t12" data-base="0.82" data-speed="9" data-rot="-6" />
        </div>
        <div className="gf-beltTrash" ref={beltTrashRef}>
          <span className="t1" data-base="0.08" data-speed="18" data-rot="-6" />
          <span className="t2" data-base="0.28" data-speed="16" data-rot="8" />
          <span className="t3" data-base="0.54" data-speed="20" data-rot="-10" />
          <span className="t4" data-base="0.78" data-speed="14" data-rot="12" />
          <span className="t5" data-base="0.16" data-speed="15" data-rot="4" />
          <span className="t6" data-base="0.42" data-speed="12" data-rot="-3" />
          <span className="t7" data-base="0.66" data-speed="17" data-rot="6" />
          <span className="t8" data-base="0.9" data-speed="13" data-rot="-5" />
        </div>
      </div>
      <header className="gf-header">
        <div className="gf-brand">
          <img className="gf-logoImg" src="/gorbage-logo.png" alt="Gorbage Factory logo" />
          <div>
            <div className="gf-title">The Gorbage Factory</div>
            <div className="gf-subtitle">Refurbished Trash — trash-tech remixes with controlled effects</div>
          </div>
        </div>

        <div className="gf-headerRight">
          <div className="gf-chip">Batch 001: ScrapTech</div>
          <div className="gf-chip gf-chipStatus">{wallet ? 'Wallet Connected' : 'Wallet Offline'}</div>

          {wallet ? (
            <button className="gf-btn gf-btnPrimary" onClick={onDisconnect}>
              Disconnect
            </button>
          ) : (
            <button className="gf-btn gf-btnPrimary" onClick={onConnect}>
              Connect Backpack
            </button>
          )}
        </div>
      </header>

      <main className="gf-main">
        <section className="gf-intro">
          <div className="gf-introLeft">
            <div className="gf-introBadge">Refurbish Lab</div>
            <h1 className="gf-introTitle">
              Make your NFT <span className="gf-accent">tastefully trashy</span>.
            </h1>
            <p className="gf-introCopy">
              This factory remixes your NFT with controlled effects. Connect, pick a piece of trash, then run it through a
              machine to generate a clean, upgraded look.
            </p>
            <div className="gf-introNote">
              Your original stays yours. This creates a new refurbished output you own — no burning, no taking.
            </div>
            <div className="gf-introActions">
              <button className="gf-btn gf-btnPrimary" onClick={wallet ? onDisconnect : onConnect}>
                {wallet ? 'Disconnect Backpack' : 'Connect Backpack'}
              </button>
              <button className="gf-btn gf-btnGhost" onClick={() => loadNfts(wallet)} disabled={!wallet || loadingNfts}>
                {loadingNfts ? 'Loading…' : 'Load Wallet NFTs'}
              </button>
            </div>
          </div>
          <div className="gf-introRight">
            <div className="gf-compactor">
              <div className="gf-compactorFrame">
                <div className="gf-compactorPiston gf-compactorPistonLeft" />
                <div className="gf-compactorPiston gf-compactorPistonRight" />
                <div className="gf-compactorTop" ref={compactorTopRef} />
                <div className="gf-compactorChamber">
                  <div className="gf-compactorPressPlate" ref={compactorPlateRef} />
                  <div className="gf-trashPile" ref={trashPileRef}>
                    <span className="piece t1" />
                    <span className="piece t2" />
                    <span className="piece t3" />
                    <span className="piece t4" />
                    <span className="piece t5" />
                    <span className="piece t6" />
                  </div>
                  <div className="gf-pressBale" ref={compactorBaleRef}>
                    <span className="baleBit b1" />
                    <span className="baleBit b2" />
                    <span className="baleBit b3" />
                  </div>
                </div>
                <div className="gf-compactorBase" />
              </div>
            </div>
          </div>
        </section>

        <section className="gf-hero">
          <h1 className="gf-h1">
            Refurbish your NFT into <span className="gf-accent">Trash</span>.
          </h1>
          <p className="gf-p">
            Connect Backpack, pick an NFT from your wallet, then run it through the factory for a controlled trash-tech remix.
          </p>
        </section>

        <section className="gf-grid">
          {/* Wallet NFTs */}
          <div className="gf-card gf-cardLeft">
            <div className="gf-cardTitleRow">
          <div className="gf-cardTitle">Pick your trash</div>
          <div className="gf-cardMeta">{wallet ? wallet.slice(0, 6) + '…' + wallet.slice(-4) : 'Backpack required'}</div>
        </div>

            {walletErr ? <div className="gf-warn">{walletErr}</div> : null}

            {!wallet ? (
              <div className="gf-muted">Click “Connect Backpack” to load your wallet NFTs.</div>
            ) : (
              <>
                <div className="gf-row">
                  <button className="gf-btnSecondary" onClick={() => loadNfts(wallet)} disabled={loadingNfts}>
                    {loadingNfts ? 'Loading…' : 'Refresh NFTs'}
                  </button>
                  <div className="gf-mutedSmall">{nfts.length ? `${nfts.length} NFTs found` : ''}</div>
                </div>

                <div className="gf-nftGrid">
                  {nfts.map((a) => {
                    const img = pickImage(a);
                    const name = a?.content?.metadata?.name || a.id.slice(0, 8);
                    const active = selected?.id === a.id;
                    return (
                      <button key={a.id} className={cx('gf-nftTile', active && 'gf-nftTileActive')} onClick={() => setSelected(a)}>
                        <img className="gf-nftImg" src={img} alt={name} />
                        <div className="gf-nftName">{name}</div>
                      </button>
                    );
                  })}
                </div>
              </>
            )}
          </div>

          {/* Factory screen preview */}
          <div className="gf-card gf-cardRight">
            <div className="gf-cardTitleRow">
          <div className="gf-cardTitle">Factory Screen</div>
          <div className="gf-liveDot">
            <span className="gf-liveDotInner" />
            <span className="gf-mutedSmall">LIVE PREVIEW</span>
          </div>
        </div>
        <div className="gf-mutedSmall gf-effectLine" style={{ marginTop: 6 }}>
          <span key={`${effectTraits.primary}-${effectCycle}`} className="gf-effectText">
            Effect: {effectTraits.primary}
          </span>
          <span className="gf-effectExtras">+ 3 traits</span>
        </div>

            <div className="gf-previewFrame">
              {selectedImage ? (
                <canvas className="gf-previewCanvas" ref={previewCanvasRef} />
              ) : (
                <div className="gf-previewEmpty">Select an NFT to preview here.</div>
              )}
            </div>
            <div className="gf-previewBadge">
              {selected ? `Selected: ${selected?.content?.metadata?.name || 'NFT'}` : 'No trash selected'}
            </div>

            <div className="gf-mintBar">
              <div className="gf-mintStatus">
                <div className="gf-mintStatusLabel">Status</div>
                {statusInfo ? (
                  <div
                    className={cx(
                      'gf-mintStatusValue',
                      statusInfo.type === 'success' && 'gf-mintStatusSuccess',
                      statusInfo.type === 'error' && 'gf-mintStatusError'
                    )}
                  >
                    {statusInfo.type === 'success' ? (
                      <>
                        <span className="gf-mintBadge">Mint Confirmed</span>
                        <span className="gf-mintStatusText">{statusInfo.label}</span>
                      </>
                    ) : (
                      <span className="gf-mintStatusText">{statusInfo.label}</span>
                    )}
                  </div>
                ) : (
                  <div className="gf-mintStatusValue gf-mintStatusMuted"> </div>
                )}
              </div>
              <button className="gf-btn gf-mintCTA" onClick={payAndRunLine} disabled={!wallet || !selected || isMinting}>
                {isMinting ? 'Compacting…' : 'Start Compacting'}
              </button>
            </div>
          </div>
        </section>

        <section className="gf-gridSingle">
          {/* Machine selection */}
          <div className="gf-card gf-cardLeft gf-tierSectionCompact">
            <div className="gf-tierHeaderRow">
              <div className="gf-cardTitle">Pick your remix machine</div>
              <div className="gf-tierHint">Tap a bay to preview its strongest effects</div>
            </div>
            <div className="gf-tierCompare">
              <div className="gf-compareItem gf-compareCommon">Common • Clean upgrades</div>
              <div className="gf-compareArrow">→</div>
              <div className="gf-compareItem gf-compareRare">Rare • Sharper remixes</div>
              <div className="gf-compareArrow">→</div>
              <div className="gf-compareItem gf-compareMythic">Mythic • Maximum chaos</div>
            </div>
            <div className="gf-tierGrid">
              <button className={cx('gf-tierCard gf-tierConveyor', machine === 'CONVEYOR' && 'gf-tierActive')} onClick={() => setMachine('CONVEYOR')}>
                <div className="gf-tierTop">
                  <div className="gf-tierBadge">Common Pull</div>
                  {machine === 'CONVEYOR' ? <div className="gf-tierSelected">Selected</div> : null}
                </div>
                <div className="gf-tierBody">
                  <div className="gf-tierPreview gf-tierPreviewConveyor">
                    <span className="gf-tierPreviewTag">Rustwave</span>
                  </div>
                  <div className="gf-tierInfo">
                    <div className="gf-tierName">Conveyor Bin</div>
                    <div className="gf-tierDesc">Everyday scrap with punchy color shifts and grime gloss.</div>
                  </div>
                </div>
                <div className="gf-tierFooter">
                  <div className="gf-tierLeft">
                    <div className="gf-tierMeter">
                      <div className="gf-tierMeterLabel">Effect Intensity</div>
                      <div className="gf-tierMeterBar">
                        <span style={{ width: '38%' }} />
                      </div>
                      <div className="gf-tierMeterHint">Low</div>
                    </div>
                    <div className="gf-tierPrice">
                      <div className="gf-tierPriceLabel">Cost</div>
                      <div className="gf-tierPriceValue">{priceLabel('CONVEYOR')}</div>
                    </div>
                  </div>
                  <div className="gf-tierOdds">
                    <div className="gf-tierOddsLabel">Odds</div>
                    <div className="gf-tierOddsBar">
                      <span style={{ width: '80%' }} />
                    </div>
                    <div className="gf-tierOddsText">80 / 18 / 2</div>
                  </div>
                </div>
                <div className="gf-tierCTA">Select Conveyor Bin</div>
              </button>
              <button className={cx('gf-tierCard gf-tierCompactor', machine === 'COMPACTOR' && 'gf-tierActive')} onClick={() => setMachine('COMPACTOR')}>
                <div className="gf-tierTop">
                  <div className="gf-tierBadge gf-tierBadgeRare">Rare Pull</div>
                  {machine === 'COMPACTOR' ? <div className="gf-tierSelected">Selected</div> : null}
                </div>
                <div className="gf-tierBody">
                  <div className="gf-tierPreview gf-tierPreviewCompactor">
                    <span className="gf-tierPreviewTag">Neon Forge</span>
                  </div>
                  <div className="gf-tierInfo">
                    <div className="gf-tierName">Forge Compactor</div>
                    <div className="gf-tierDesc">Pressurized remixes with deeper saturation and sharper grime.</div>
                  </div>
                </div>
                <div className="gf-tierFooter">
                  <div className="gf-tierLeft">
                    <div className="gf-tierMeter">
                      <div className="gf-tierMeterLabel">Effect Intensity</div>
                      <div className="gf-tierMeterBar gf-tierMeterMid">
                        <span style={{ width: '62%' }} />
                      </div>
                      <div className="gf-tierMeterHint">Medium</div>
                    </div>
                    <div className="gf-tierPrice">
                      <div className="gf-tierPriceLabel">Cost</div>
                      <div className="gf-tierPriceValue">{priceLabel('COMPACTOR')}</div>
                    </div>
                  </div>
                  <div className="gf-tierOdds">
                    <div className="gf-tierOddsLabel">Odds</div>
                    <div className="gf-tierOddsBar gf-tierOddsBarRare">
                      <span style={{ width: '65%' }} />
                    </div>
                    <div className="gf-tierOddsText">65 / 30 / 5</div>
                  </div>
                </div>
                <div className="gf-tierCTA">Select Forge Compactor</div>
              </button>
              <button className={cx('gf-tierCard gf-tierHazmat', machine === 'HAZMAT' && 'gf-tierActive')} onClick={() => setMachine('HAZMAT')}>
                <div className="gf-tierTop">
                  <div className="gf-tierBadge gf-tierBadgeMythic">Mythic Pull</div>
                  {machine === 'HAZMAT' ? <div className="gf-tierSelected">Selected</div> : null}
                </div>
                <div className="gf-tierBody">
                  <div className="gf-tierPreview gf-tierPreviewHazmat">
                    <span className="gf-tierPreviewTag">Hazard Halo</span>
                  </div>
                  <div className="gf-tierInfo">
                    <div className="gf-tierName">Hazmat Shrine</div>
                    <div className="gf-tierDesc">Legendary potential with wild color flips and hazard tech overlays.</div>
                  </div>
                </div>
                <div className="gf-tierFooter">
                  <div className="gf-tierLeft">
                    <div className="gf-tierMeter">
                      <div className="gf-tierMeterLabel">Effect Intensity</div>
                      <div className="gf-tierMeterBar gf-tierMeterHigh">
                        <span style={{ width: '92%' }} />
                      </div>
                      <div className="gf-tierMeterHint">High</div>
                    </div>
                    <div className="gf-tierPrice">
                      <div className="gf-tierPriceLabel">Cost</div>
                      <div className="gf-tierPriceValue">{priceLabel('HAZMAT')}</div>
                    </div>
                  </div>
                  <div className="gf-tierOdds">
                    <div className="gf-tierOddsLabel">Odds</div>
                    <div className="gf-tierOddsBar gf-tierOddsBarMythic">
                      <span style={{ width: '45%' }} />
                    </div>
                    <div className="gf-tierOddsText">45 / 45 / 10</div>
                  </div>
                </div>
                <div className="gf-tierCTA">Select Hazmat Shrine</div>
              </button>
            </div>
          </div>
        </section>
      </main>

      <section className="gf-supply">
        <div className="gf-supplyHeader">
          <div className="gf-supplyBadge">Supply Meters</div>
          <div className="gf-supplyTitle">Tier availability across the factory.</div>
        </div>
        <div className="gf-supplyGrid">
          <div className="gf-supplyRow">
            <div className="gf-supplyLabel">
              <div className="gf-supplyName">Common Pull</div>
              <div className="gf-supplySub">Tier 1 • Conveyor</div>
            </div>
            <div className="gf-supplyMeter">
              <div className="gf-supplyFill gf-supplyFillCommon" style={{ width: `${tier1Pct}%` }} />
            </div>
            <div className="gf-supplyMeta">
              {tier1Supply.cap ? `${tier1Supply.remaining} / ${tier1Supply.cap}` : 'Loading'}
              {tier1Sold ? <span className="gf-supplySold">Sold out</span> : null}
            </div>
          </div>
          <div className="gf-supplyRow">
            <div className="gf-supplyLabel">
              <div className="gf-supplyName">Rare Pull</div>
              <div className="gf-supplySub">Tier 2 • Compactor</div>
            </div>
            <div className="gf-supplyMeter">
              <div className="gf-supplyFill gf-supplyFillRare" style={{ width: `${tier2Pct}%` }} />
            </div>
            <div className="gf-supplyMeta">
              {tier2Supply.cap ? `${tier2Supply.remaining} / ${tier2Supply.cap}` : 'Loading'}
              {tier2Sold ? <span className="gf-supplySold">Sold out</span> : null}
            </div>
          </div>
          <div className="gf-supplyRow">
            <div className="gf-supplyLabel">
              <div className="gf-supplyName">Mythic Pull</div>
              <div className="gf-supplySub">Tier 3 • Hazmat</div>
            </div>
            <div className="gf-supplyMeter">
              <div className="gf-supplyFill gf-supplyFillMythic" style={{ width: `${tier3Pct}%` }} />
            </div>
            <div className="gf-supplyMeta">
              {tier3Supply.cap ? `${tier3Supply.remaining} / ${tier3Supply.cap}` : 'Loading'}
              {tier3Sold ? <span className="gf-supplySold">Sold out</span> : null}
            </div>
          </div>
        </div>
      </section>

      <section className="gf-faq">
        <div className="gf-faqTape" />
        <div className="gf-faqHeader">
          <div className="gf-faqBadge">Factory FAQ</div>
          <div className="gf-faqTitle">Quick answers before you remix.</div>
        </div>
        <div className="gf-faqGrid">
          <details className="gf-faqCard" open>
            <summary className="gf-faqQ">Does this burn or take my NFT?</summary>
            <div className="gf-faqA">
              <div className="gf-faqAInner">
                No. Your original stays yours. This creates a new refurbished output you own — nothing is removed.
              </div>
            </div>
          </details>
          <details className="gf-faqCard">
            <summary className="gf-faqQ">What does the machine choice change?</summary>
            <div className="gf-faqA">
              <div className="gf-faqAInner">
                Each machine tunes the remix intensity and style — Common is subtle, Rare is bold, Mythic is wild.
              </div>
            </div>
          </details>
          <details className="gf-faqCard">
            <summary className="gf-faqQ">Why do effects look different on each NFT?</summary>
            <div className="gf-faqA">
              <div className="gf-faqAInner">
                The same effect reacts differently based on your original colors, contrast, and art style.
              </div>
            </div>
          </details>
          <details className="gf-faqCard">
            <summary className="gf-faqQ">Is this on-chain verified?</summary>
            <div className="gf-faqA">
              <div className="gf-faqAInner">Yes. The remix is minted as a new asset with its own traits and metadata.</div>
            </div>
          </details>
          <details className="gf-faqCard">
            <summary className="gf-faqQ">Can I remix the same NFT again?</summary>
            <div className="gf-faqA">
              <div className="gf-faqAInner">
                We plan to cap at one remix per NFT for scarcity. If that changes, you will see it here first.
              </div>
            </div>
          </details>
        </div>
        <div className="gf-faqTrash" aria-hidden />
      </section>

      <footer className="gf-footer">
        <div className="gf-footerLeft">
          <img className="gf-footerLogoImg" src="/gorbage-logo.png" alt="Gorbage Factory logo" />
          <div>
            <div className="gf-footerTitle">GorbageFactory</div>
            <div className="gf-footerDesc">
              Refurbish your NFT into tasteful trash. You keep your original — this creates a new remix output you own.
            </div>
          </div>
        </div>
        <div className="gf-footerCenter">
          <div>Use at your own risk — output may be trashy.</div>
          <div className="gf-footerMetaInline">Gorbagana • $GOR • Remix Engine</div>
        </div>
        <div className="gf-footerRight">
          <div className="gf-footerSocials">Socials</div>
          <a className="gf-footerX" href="https://x.com/gorbagefactory?s=21" target="_blank" rel="noreferrer" aria-label="X">
            X
          </a>
        </div>
      </footer>

      <style jsx>{`
        /* Minimal styles so this works even if your globals changed.
           If your existing globals.css already defines these classes,
           these will be harmless overrides. */
        .gf-root {
          min-height: 100vh;
          color: rgba(255, 255, 255, 0.92);
          font-family: 'Space Grotesk', 'IBM Plex Sans', 'Segoe UI', sans-serif;
          background: #05080a;
          position: relative;
          overflow: hidden;
        }
        .gf-bg {
          position: fixed;
          inset: 0;
          pointer-events: none;
          z-index: 0;
        }
        .gf-bgGlow {
          position: absolute;
          width: 900px;
          height: 900px;
          border-radius: 50%;
          filter: blur(120px);
          opacity: 0.5;
        }
        .gf-bgGlowA {
          top: -380px;
          left: -200px;
          background: radial-gradient(circle, rgba(0, 255, 120, 0.45), transparent 60%);
        }
        .gf-bgGlowB {
          top: -340px;
          right: -240px;
          background: radial-gradient(circle, rgba(0, 120, 80, 0.28), transparent 60%);
        }
        .gf-belt {
          position: absolute;
          left: -5%;
          right: -5%;
          bottom: 18%;
          height: 90px;
          background: linear-gradient(180deg, rgba(20, 30, 25, 0.9), rgba(6, 10, 8, 0.95));
          border-top: 1px solid rgba(255, 255, 255, 0.12);
          border-bottom: 1px solid rgba(0, 0, 0, 0.6);
          box-shadow: 0 -20px 60px rgba(0, 0, 0, 0.6);
          transform: skewX(-2deg);
          animation: none;
          animation-play-state: running;
          overflow: hidden;
        }
        .gf-beltTreads {
          position: absolute;
          top: 0;
          bottom: 0;
          left: 0;
          width: 200%;
          background: repeating-linear-gradient(
            90deg,
            rgba(255, 255, 255, 0.06) 0 12px,
            rgba(0, 0, 0, 0) 12px 28px
          );
          opacity: 0.6;
          will-change: transform;
        }
        .gf-belt::before { content: none; }
        .gf-beltBack {
          bottom: 30%;
          height: 60px;
          opacity: 0.6;
          background-size: 280px 100%, auto;
          animation: none;
        }
        .gf-beltTrash {
          position: absolute;
          left: 6%;
          right: 6%;
          bottom: 22%;
          height: 60px;
          pointer-events: none;
        }
        .gf-beltTrashBack {
          bottom: 34%;
          height: 44px;
          opacity: 0.7;
        }
        .gf-beltTrash span {
          position: absolute;
          width: 30px;
          height: 22px;
          border-radius: 6px;
          background-repeat: no-repeat;
          background-size: contain;
          background-position: center;
          box-shadow: 0 6px 12px rgba(0, 0, 0, 0.25);
          opacity: 0.75;
          animation: none;
        }
        .gf-beltTreads,
        .gf-beltTrash span,
        .gf-compactorTop,
        .gf-compactorPressPlate,
        .gf-pressBale {
          will-change: transform;
        }
        .gf-beltTrash .t1 { left: 8%; top: 14px; width: 34px; height: 26px; transform: rotate(-6deg); }
        .gf-beltTrash .t2 { left: 28%; top: 30px; width: 28px; height: 22px; transform: rotate(8deg); }
        .gf-beltTrash .t3 { left: 54%; top: 14px; width: 22px; height: 26px; transform: rotate(-10deg); }
        .gf-beltTrash .t4 { left: 78%; top: 26px; width: 30px; height: 20px; transform: rotate(12deg); }
        .gf-beltTrash .t5 { left: 18%; top: 6px; width: 24px; height: 18px; transform: rotate(4deg); }
        .gf-beltTrash .t6 { left: 44%; top: 34px; width: 26px; height: 20px; transform: rotate(-3deg); }
        .gf-beltTrash .t7 { left: 66%; top: 6px; width: 20px; height: 18px; transform: rotate(6deg); }
        .gf-beltTrash .t8 { left: 90%; top: 30px; width: 28px; height: 20px; transform: rotate(-5deg); }
        .gf-beltTrashBack .t9 { left: 10%; top: 6px; width: 22px; height: 16px; transform: rotate(5deg); }
        .gf-beltTrashBack .t10 { left: 36%; top: 20px; width: 20px; height: 16px; transform: rotate(-4deg); }
        .gf-beltTrashBack .t11 { left: 62%; top: 8px; width: 18px; height: 14px; transform: rotate(7deg); }
        .gf-beltTrashBack .t12 { left: 84%; top: 18px; width: 22px; height: 16px; transform: rotate(-6deg); }
        .gf-beltTrash .t1 { background-image: url('data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSI2MCIgaGVpZ2h0PSI1MCIgdmlld0JveD0iMCAwIDYwIDUwIj48cGF0aCBkPSJNMjIgOGMwIDYgNiAxMCA4IDEwczgtNCA4LTEwIiBmaWxsPSJub25lIiBzdHJva2U9InJnYmEoMjIwLDIyMCwyMjAsMC43KSIgc3Ryb2tlLXdpZHRoPSI0Ii8+PHBhdGggZD0iTTE0IDE2Yy02IDEwLTYgMjItNiAzMCAwIDEwIDEwIDE2IDIyIDE2czIyLTYgMjItMTZjMC04IDAtMjAtNi0zMCIgZmlsbD0icmdiYSg0MCw0MCw0MCwwLjc1KSIgc3Ryb2tlPSJyZ2JhKDIwMCwyMDAsMjAwLDAuNSkiIHN0cm9rZS13aWR0aD0iMyIvPjwvc3ZnPg=='); }
        .gf-beltTrash .t2 { background-image: url('data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSI1MCIgaGVpZ2h0PSI0MCIgdmlld0JveD0iMCAwIDUwIDQwIj48cmVjdCB4PSIxMiIgeT0iNiIgd2lkdGg9IjI2IiBoZWlnaHQ9IjI4IiByeD0iNiIgZmlsbD0icmdiYSgxMjAsMTQwLDEzMCwwLjYpIiBzdHJva2U9InJnYmEoMjAwLDIwMCwyMDAsMC41KSIgc3Ryb2tlLXdpZHRoPSIzIi8+PHJlY3QgeD0iMTgiIHk9IjEwIiB3aWR0aD0iMTQiIGhlaWdodD0iNiIgcng9IjMiIGZpbGw9InJnYmEoNDAsNDAsNDAsMC40KSIvPjwvc3ZnPg=='); }
        .gf-beltTrash .t3 { background-image: url('data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSI0MCIgaGVpZ2h0PSI1MCIgdmlld0JveD0iMCAwIDQwIDUwIj48cGF0aCBkPSJNMTQgNmgxMmwyIDRoLTE2eiIgZmlsbD0icmdiYSgxNjAsMTgwLDE3MCwwLjcpIi8+PHBhdGggZD0iTTEwIDEwaDIwdjMwYTggOCAwIDAgMS04IDhoLTRhOCA4IDAgMCAxLTgtOHoiIGZpbGw9InJnYmEoOTAsMTAwLDk1LDAuNzUpIiBzdHJva2U9InJnYmEoMjAwLDIwMCwyMDAsMC40KSIgc3Ryb2tlLXdpZHRoPSIzIi8+PC9zdmc+'); }
        .gf-beltTrash .t4 { background-image: url('data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSI1MCIgaGVpZ2h0PSI0MCIgdmlld0JveD0iMCAwIDUwIDQwIj48cGF0aCBkPSJNOCAyNmMxMC04IDIwLTE0IDM0LTEwIiBzdHJva2U9InJnYmEoMjAwLDIwMCwyMDAsMC41KSIgc3Ryb2tlLXdpZHRoPSI2IiBmaWxsPSJub25lIi8+PHBhdGggZD0iTTEwIDMwYzE0LTYgMjQtOCAzMi00IiBzdHJva2U9InJnYmEoMTIwLDE0MCwxMzAsMC41KSIgc3Ryb2tlLXdpZHRoPSI0IiBmaWxsPSJub25lIi8+PC9zdmc+'); }
        .gf-beltTrash .t5 { background-image: url('data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSI0MCIgaGVpZ2h0PSIzMCIgdmlld0JveD0iMCAwIDQwIDMwIj48Y2lyY2xlIGN4PSIxNSIgY3k9IjE2IiByPSI5IiBmaWxsPSJyZ2JhKDE1MCwxNjAsMTUwLDAuNikIi8+PHBhdGggZD0iTTIyIDguNWgxMCIgc3Ryb2tlPSJyZ2JhKDIwMCwyMDAsMjAwLDAuNSkiIHN0cm9rZS13aWR0aD0iMyIgLz48L3N2Zz4='); }
        .gf-beltTrash .t6 { background-image: url('data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSI0NCIgaGVpZ2h0PSIzMCIgdmlld0JveD0iMCAwIDQ0IDMwIj48cmVjdCB4PSI4IiB5PSI4IiB3aWR0aD0iMjgiIGhlaWdodD0iMTQiIHJ4PSI3IiBmaWxsPSJyZ2JhKDEwMCwxMTAsMTAwLDAuNikiIHN0cm9rZT0icmdiYSgyMDAsMjAwLDIwMCwwLjQpIiBzdHJva2Utd2lkdGg9IjMiLz48L3N2Zz4='); }
        .gf-beltTrash .t7 { background-image: url('data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIzOCIgaGVpZ2h0PSIzMCIgdmlld0JveD0iMCAwIDM4IDMwIj48cGF0aCBkPSJNMTEgOGgxNmwzIDQiIGZpbGw9Im5vbmUiIHN0cm9rZT0icmdiYSgyMDAsMjAwLDIwMCwwLjUpIiBzdHJva2Utd2lkdGg9IjMiLz48cGF0aCBkPSJNOCAxMmgyMnYxMmE2IDYgMCAwIDEtNiA2aC0xMGE2IDYgMCAwIDEtNi02eiIgZmlsbD0icmdiYSgxMDAsMTEwLDEwNSwwLjYpIiBzdHJva2U9InJnYmEoMjAwLDIwMCwyMDAsMC40KSIgc3Ryb2tlLXdpZHRoPSIzIi8+PC9zdmc+'); }
        .gf-beltTrash .t8 { background-image: url('data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSI0MCIgaGVpZ2h0PSIzMCIgdmlld0JveD0iMCAwIDQwIDMwIj48cGF0aCBkPSJNNiAxOGMxMi02IDIwLTggMjgtNCIgc3Ryb2tlPSJyZ2JhKDIwMCwyMDAsMjAwLDAuNSkiIHN0cm9rZS13aWR0aD0iNSIgZmlsbD0ibm9uZSIvPjxwYXRoIGQ9Ik04IDIyYzE0LTQgMjAtNSAyNi0yIiBzdHJva2U9InJnYmEoMTIwLDE0MCwxMzAsMC41KSIgc3Ryb2tlLXdpZHRoPSI0IiBmaWxsPSJub25lIi8+PC9zdmc+'); }
        .gf-beltTrashBack .t9 { background-image: url('data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSI2MCIgaGVpZ2h0PSI1MCIgdmlld0JveD0iMCAwIDYwIDUwIj48cGF0aCBkPSJNMjIgOGMwIDYgNiAxMCA4IDEwczgtNCA4LTEwIiBmaWxsPSJub25lIiBzdHJva2U9InJnYmEoMjIwLDIyMCwyMjAsMC43KSIgc3Ryb2tlLXdpZHRoPSI0Ii8+PHBhdGggZD0iTTE0IDE2Yy02IDEwLTYgMjItNiAzMCAwIDEwIDEwIDE2IDIyIDE2czIyLTYgMjItMTZjMC04IDAtMjAtNi0zMCIgZmlsbD0icmdiYSg0MCw0MCw0MCwwLjc1KSIgc3Ryb2tlPSJyZ2JhKDIwMCwyMDAsMjAwLDAuNSkiIHN0cm9rZS13aWR0aD0iMyIvPjwvc3ZnPg=='); }
        .gf-beltTrashBack .t10 { background-image: url('data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSI1MCIgaGVpZ2h0PSI0MCIgdmlld0JveD0iMCAwIDUwIDQwIj48cmVjdCB4PSIxMiIgeT0iNiIgd2lkdGg9IjI2IiBoZWlnaHQ9IjI4IiByeD0iNiIgZmlsbD0icmdiYSgxMjAsMTQwLDEzMCwwLjYpIiBzdHJva2U9InJnYmEoMjAwLDIwMCwyMDAsMC41KSIgc3Ryb2tlLXdpZHRoPSIzIi8+PHJlY3QgeD0iMTgiIHk9IjEwIiB3aWR0aD0iMTQiIGhlaWdodD0iNiIgcng9IjMiIGZpbGw9InJnYmEoNDAsNDAsNDAsMC40KSIvPjwvc3ZnPg=='); }
        .gf-beltTrashBack .t11 { background-image: url('data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSI0MCIgaGVpZ2h0PSI1MCIgdmlld0JveD0iMCAwIDQwIDUwIj48cGF0aCBkPSJNMTQgNmgxMmwyIDRoLTE2eiIgZmlsbD0icmdiYSgxNjAsMTgwLDE3MCwwLjcpIi8+PHBhdGggZD0iTTEwIDEwaDIwdjMwYTggOCAwIDAgMS04IDhoLTRhOCA4IDAgMCAxLTgtOHoiIGZpbGw9InJnYmEoOTAsMTAwLDk1LDAuNzUpIiBzdHJva2U9InJnYmEoMjAwLDIwMCwyMDAsMC40KSIgc3Ryb2tlLXdpZHRoPSIzIi8+PC9zdmc+'); }
        .gf-beltTrashBack .t12 { background-image: url('data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSI0MCIgaGVpZ2h0PSIzMCIgdmlld0JveD0iMCAwIDQwIDMwIj48cGF0aCBkPSJNNiAxOGMxMi02IDIwLTggMjgtNCIgc3Ryb2tlPSJyZ2JhKDIwMCwyMDAsMjAwLDAuNSkiIHN0cm9rZS13aWR0aD0iNSIgZmlsbD0ibm9uZSIvPjxwYXRoIGQ9Ik04IDIyYzE0LTQgMjAtNSAyNi0yIiBzdHJva2U9InJnYmEoMTIwLDE0MCwxMzAsMC41KSIgc3Ryb2tlLXdpZHRoPSI0IiBmaWxsPSJub25lIi8+PC9zdmc+'); }
        .gf-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 16px;
          padding: 18px 22px;
          position: sticky;
          top: 0;
          z-index: 10;
          background: rgba(0, 0, 0, 0.25);
          backdrop-filter: blur(10px);
          border-bottom: 1px solid rgba(255, 255, 255, 0.08);
        }
        .gf-header,
        .gf-main {
          position: relative;
          z-index: 1;
        }
        .gf-brand {
          display: flex;
          align-items: center;
          gap: 12px;
        }
        .gf-logoImg {
          width: 34px;
          height: 34px;
          object-fit: contain;
          border-radius: 10px;
          filter: drop-shadow(0 6px 12px rgba(0, 0, 0, 0.55));
        }
        .gf-title {
          font-weight: 900;
          letter-spacing: -0.3px;
          font-size: 18px;
        }
        .gf-subtitle {
          font-size: 12px;
          opacity: 0.75;
          margin-top: 2px;
        }
        .gf-headerRight {
          display: flex;
          align-items: center;
          gap: 10px;
        }
        .gf-footer {
          margin: 44px 22px 50px;
          padding: 44px 36px;
          position: relative;
          display: grid;
          grid-template-columns: 1fr auto 1fr;
          align-items: center;
          gap: 20px;
          border: 1px solid rgba(255, 255, 255, 0.08);
          border-radius: 18px;
          background: rgba(0, 0, 0, 0.25);
          backdrop-filter: blur(10px);
          color: rgba(255, 255, 255, 0.7);
          font-size: 12px;
        }
        .gf-supply {
          margin: 32px 22px 0;
          padding: 26px 26px 22px;
          position: relative;
          border-radius: 18px;
          border: 1px solid rgba(255, 255, 255, 0.1);
          background: rgba(0, 0, 0, 0.22);
          backdrop-filter: blur(10px);
        }
        .gf-supplyHeader {
          display: flex;
          align-items: baseline;
          gap: 12px;
          flex-wrap: wrap;
        }
        .gf-supplyBadge {
          display: inline-flex;
          align-items: center;
          gap: 8px;
          padding: 6px 12px;
          border-radius: 999px;
          background: rgba(255, 210, 80, 0.12);
          border: 1px solid rgba(255, 210, 80, 0.4);
          font-size: 11px;
          font-weight: 800;
          text-transform: uppercase;
          letter-spacing: 0.8px;
        }
        .gf-supplyTitle {
          font-size: 18px;
          font-weight: 800;
          letter-spacing: -0.2px;
          opacity: 0.85;
        }
        .gf-supplyGrid {
          margin-top: 18px;
          display: grid;
          gap: 12px;
        }
        .gf-supplyRow {
          display: grid;
          grid-template-columns: 170px 1fr 140px;
          align-items: center;
          gap: 14px;
          padding: 12px 14px;
          border-radius: 14px;
          border: 1px solid rgba(255, 255, 255, 0.08);
          background: rgba(0, 0, 0, 0.35);
        }
        .gf-supplyName {
          font-weight: 800;
          text-transform: uppercase;
          font-size: 12px;
        }
        .gf-supplySub {
          margin-top: 4px;
          font-size: 11px;
          opacity: 0.65;
        }
        .gf-supplyMeter {
          position: relative;
          height: 10px;
          border-radius: 999px;
          background: rgba(255, 255, 255, 0.08);
          overflow: hidden;
        }
        .gf-supplyFill {
          position: absolute;
          inset: 0;
          width: 0%;
          border-radius: 999px;
          transition: width 0.5s ease;
        }
        .gf-supplyFillCommon {
          background: linear-gradient(90deg, rgba(0, 255, 160, 0.65), rgba(0, 150, 90, 0.6));
        }
        .gf-supplyFillRare {
          background: linear-gradient(90deg, rgba(0, 200, 255, 0.65), rgba(80, 120, 255, 0.6));
        }
        .gf-supplyFillMythic {
          background: linear-gradient(90deg, rgba(255, 140, 220, 0.7), rgba(255, 90, 140, 0.6));
        }
        .gf-supplyMeta {
          display: flex;
          flex-direction: column;
          align-items: flex-end;
          gap: 6px;
          font-size: 12px;
          font-weight: 700;
        }
        .gf-supplySold {
          font-size: 10px;
          text-transform: uppercase;
          letter-spacing: 0.6px;
          padding: 4px 10px;
          border-radius: 999px;
          color: #1a1a1a;
          background: repeating-linear-gradient(
            135deg,
            rgba(255, 210, 80, 0.95) 0 12px,
            rgba(16, 16, 16, 0.95) 12px 24px
          );
        }
        .gf-faq {
          margin: 40px 22px 0;
          padding: 28px 28px 22px;
          position: relative;
          border-radius: 18px;
          border: 1px solid rgba(255, 255, 255, 0.1);
          background: rgba(0, 0, 0, 0.22);
          backdrop-filter: blur(10px);
          overflow: hidden;
        }
        .gf-faqTape {
          position: absolute;
          left: -10%;
          right: -10%;
          top: 12px;
          height: 26px;
          background: repeating-linear-gradient(
              135deg,
              rgba(255, 210, 80, 0.95) 0 18px,
              rgba(14, 14, 14, 0.95) 18px 36px
            ),
            linear-gradient(90deg, rgba(255, 210, 80, 0.2), rgba(255, 210, 80, 0.1));
          opacity: 0.7;
          box-shadow: 0 8px 20px rgba(0, 0, 0, 0.45);
          transform: none;
        }
        .gf-faqHeader {
          position: relative;
          display: grid;
          gap: 8px;
          padding-top: 26px;
        }
        .gf-faqBadge {
          display: inline-flex;
          align-items: center;
          gap: 8px;
          width: fit-content;
          padding: 6px 10px;
          border-radius: 999px;
          border: 1px solid rgba(255, 210, 80, 0.6);
          background: rgba(255, 210, 80, 0.12);
          font-size: 11px;
          font-weight: 800;
          text-transform: uppercase;
          letter-spacing: 0.8px;
        }
        .gf-faqTitle {
          font-size: 22px;
          font-weight: 900;
          letter-spacing: -0.4px;
        }
        .gf-faqGrid {
          margin-top: 18px;
          display: grid;
          grid-template-columns: repeat(2, minmax(0, 1fr));
          gap: 14px;
        }
        .gf-faqCard {
          list-style: none;
          border-radius: 14px;
          border: 1px solid rgba(255, 255, 255, 0.08);
          background: rgba(0, 0, 0, 0.25);
          padding: 14px;
          display: grid;
          gap: 8px;
          position: relative;
          overflow: hidden;
        }
        .gf-faqCard::-webkit-details-marker {
          display: none;
        }
        .gf-faqCard::after {
          content: '';
          position: absolute;
          right: -20px;
          bottom: -12px;
          width: 64px;
          height: 64px;
          opacity: 0.2;
          background-image: url('data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSI2MCIgaGVpZ2h0PSI1MCIgdmlld0JveD0iMCAwIDYwIDUwIj48cGF0aCBkPSJNMjIgOGMwIDYgNiAxMCA4IDEwczgtNCA4LTEwIiBmaWxsPSJub25lIiBzdHJva2U9InJnYmEoMjIwLDIyMCwyMjAsMC43KSIgc3Ryb2tlLXdpZHRoPSI0Ii8+PHBhdGggZD0iTTE0IDE2Yy02IDEwLTYgMjItNiAzMCAwIDEwIDEwIDE2IDIyIDE2czIyLTYgMjItMTZjMC04IDAtMjAtNi0zMCIgZmlsbD0icmdiYSg0MCw0MCw0MCwwLjc1KSIgc3Ryb2tlPSJyZ2JhKDIwMCwyMDAsMjAwLDAuNSkiIHN0cm9rZS13aWR0aD0iMyIvPjwvc3ZnPg==');
          background-size: contain;
          background-repeat: no-repeat;
          background-position: center;
        }
        .gf-faqQ {
          font-weight: 800;
          cursor: pointer;
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 12px;
          font-size: 15px;
        }
        .gf-faqQ::after {
          content: '+';
          width: 26px;
          height: 26px;
          display: grid;
          place-items: center;
          border-radius: 999px;
          border: 1px solid rgba(255, 255, 255, 0.18);
          font-weight: 900;
          font-size: 14px;
          transition: transform 0.2s ease, background 0.2s ease;
        }
        .gf-faqCard[open] .gf-faqQ::after {
          content: '−';
          transform: rotate(180deg);
          background: rgba(255, 210, 80, 0.12);
          border-color: rgba(255, 210, 80, 0.4);
        }
        .gf-faqA {
          font-size: 14px;
          line-height: 1.5;
          display: grid;
          grid-template-rows: 0fr;
          transition: grid-template-rows 0.7s cubic-bezier(0.2, 0.8, 0.2, 1);
        }
        .gf-faqAInner {
          overflow: hidden;
          opacity: 0;
          transform: translateY(-6px);
          transition: opacity 0.5s ease, transform 0.5s ease;
        }
        .gf-faqCard[open] .gf-faqA {
          grid-template-rows: 1fr;
        }
        .gf-faqCard[open] .gf-faqAInner {
          opacity: 0.78;
          transform: translateY(0);
          transition-delay: 0.1s;
        }
        .gf-faqTrash {
          position: absolute;
          right: 18px;
          top: 18px;
          width: 90px;
          height: 90px;
          opacity: 0.2;
          background-image: url('data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSI2MCIgaGVpZ2h0PSI1MCIgdmlld0JveD0iMCAwIDYwIDUwIj48cGF0aCBkPSJNMjIgOGMwIDYgNiAxMCA4IDEwczgtNCA4LTEwIiBmaWxsPSJub25lIiBzdHJva2U9InJnYmEoMjIwLDIyMCwyMjAsMC43KSIgc3Ryb2tlLXdpZHRoPSI0Ii8+PHBhdGggZD0iTTE0IDE2Yy02IDEwLTYgMjItNiAzMCAwIDEwIDEwIDE2IDIyIDE2czIyLTYgMjItMTZjMC04IDAtMjAtNi0zMCIgZmlsbD0icmdiYSg0MCw0MCw0MCwwLjc1KSIgc3Ryb2tlPSJyZ2JhKDIwMCwyMDAsMjAwLDAuNSkiIHN0cm9rZS13aWR0aD0iMyIvPjwvc3ZnPg==');
          background-size: contain;
          background-repeat: no-repeat;
          background-position: center;
        }
        .gf-footerLeft {
          display: flex;
          justify-content: flex-start;
          align-items: flex-start;
          gap: 18px;
          justify-self: start;
        }
        .gf-footerBrand {
          display: flex;
          align-items: center;
          gap: 10px;
        }
        .gf-footerLogoImg {
          width: 58px;
          height: 58px;
          object-fit: contain;
          border-radius: 14px;
          box-shadow: 0 14px 24px rgba(0, 0, 0, 0.4);
        }
        .gf-footerTitle {
          font-weight: 800;
          letter-spacing: 0.2px;
          font-size: 16px;
        }
        .gf-footerDesc {
          margin-top: 4px;
          opacity: 0.7;
          max-width: 420px;
          line-height: 1.4;
          font-size: 13px;
        }
        .gf-footerCenter {
          text-align: center;
          font-size: 13px;
          font-weight: 600;
          display: grid;
          place-items: center;
          min-height: 80px;
          gap: 6px;
          justify-self: center;
        }
        .gf-footerMetaInline {
          font-size: 11px;
          opacity: 0.7;
          font-weight: 500;
          text-transform: uppercase;
          letter-spacing: 0.8px;
        }
        .gf-footerRight {
          display: grid;
          justify-items: end;
          gap: 10px;
          text-transform: uppercase;
          letter-spacing: 0.8px;
          justify-self: end;
        }
        .gf-footerSocials {
          font-size: 10px;
          opacity: 0.7;
        }
        .gf-footerMeta {
          font-size: 11px;
          opacity: 0.7;
        }
        .gf-footerText {
          text-align: center;
          max-width: 520px;
        }
        .gf-footerX {
          width: 32px;
          height: 32px;
          border-radius: 999px;
          border: 1px solid rgba(255, 255, 255, 0.18);
          display: grid;
          place-items: center;
          font-weight: 800;
          font-size: 12px;
          color: rgba(255, 255, 255, 0.85);
          background: rgba(255, 255, 255, 0.06);
          text-decoration: none;
          flex: 0 0 auto;
        }
        .gf-chip {
          font-size: 12px;
          opacity: 0.85;
          border: 1px solid rgba(255, 255, 255, 0.12);
          background: rgba(255, 255, 255, 0.05);
          padding: 8px 10px;
          border-radius: 999px;
        }
        .gf-chipStatus {
          border-color: rgba(0, 255, 120, 0.25);
          background: rgba(0, 255, 120, 0.08);
        }
        .gf-chipOfficial {
          border-color: rgba(140, 180, 255, 0.25);
          background: linear-gradient(135deg, rgba(40, 80, 120, 0.25), rgba(10, 20, 30, 0.35));
          text-transform: uppercase;
          letter-spacing: 0.8px;
          font-weight: 700;
          font-size: 10px;
        }
        .gf-btnPrimary {
          background: linear-gradient(135deg, rgba(0, 255, 140, 0.18), rgba(0, 60, 40, 0.4));
          border-color: rgba(0, 255, 160, 0.4);
          box-shadow: 0 8px 30px rgba(0, 0, 0, 0.35);
        }
        .gf-btnGhost {
          background: rgba(255, 255, 255, 0.04);
          border-color: rgba(255, 255, 255, 0.14);
        }
        .gf-btn {
          border-radius: 999px;
          border: 1px solid rgba(255, 255, 255, 0.18);
          background: rgba(255, 255, 255, 0.08);
          padding: 10px 14px;
          color: rgba(255, 255, 255, 0.92);
          font-weight: 800;
          cursor: pointer;
        }
        .gf-btn:disabled {
          opacity: 0.5;
          cursor: not-allowed;
        }
        .gf-btnSecondary {
          border-radius: 999px;
          border: 1px solid rgba(255, 255, 255, 0.14);
          background: rgba(0, 0, 0, 0.25);
          padding: 9px 12px;
          color: rgba(255, 255, 255, 0.90);
          font-weight: 700;
          cursor: pointer;
        }
        .gf-mintBar {
          margin-top: 14px;
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 16px;
          padding: 16px 18px;
          border-radius: 18px;
          border: 1px solid rgba(0, 255, 140, 0.18);
          background: linear-gradient(135deg, rgba(8, 22, 18, 0.8), rgba(2, 10, 8, 0.5));
          box-shadow: inset 0 0 24px rgba(0, 255, 140, 0.08), 0 16px 40px rgba(0, 0, 0, 0.45);
        }
        .gf-mintStatus {
          display: flex;
          flex-direction: column;
          min-width: 0;
          flex: 1;
        }
        .gf-mintStatusLabel {
          font-size: 11px;
          letter-spacing: 1px;
          text-transform: uppercase;
          opacity: 0.6;
        }
        .gf-mintStatusValue {
          margin-top: 6px;
          font-size: 13px;
          line-height: 1.4;
          color: rgba(255, 255, 255, 0.9);
          display: flex;
          flex-wrap: wrap;
          align-items: center;
          gap: 8px;
        }
        .gf-mintStatusMuted {
          min-height: 18px;
        }
        .gf-mintStatusSuccess {
          color: rgba(190, 255, 220, 0.95);
        }
        .gf-mintStatusError {
          color: rgba(255, 160, 160, 0.95);
        }
        .gf-mintBadge {
          display: inline-flex;
          align-items: center;
          padding: 4px 10px;
          border-radius: 999px;
          font-size: 10px;
          text-transform: uppercase;
          letter-spacing: 0.8px;
          font-weight: 800;
          color: rgba(10, 30, 20, 0.9);
          background: linear-gradient(135deg, rgba(120, 255, 200, 0.9), rgba(30, 180, 120, 0.9));
          box-shadow: 0 6px 18px rgba(0, 0, 0, 0.35);
        }
        .gf-mintStatusText {
          font-weight: 700;
        }
        .gf-mintCTA {
          padding: 14px 28px;
          font-size: 14px;
          font-weight: 900;
          letter-spacing: 1.2px;
          text-transform: uppercase;
          border: 1px solid rgba(0, 255, 160, 0.55);
          background: radial-gradient(circle at top, rgba(0, 255, 160, 0.35), rgba(0, 90, 60, 0.55));
          box-shadow: 0 0 18px rgba(0, 255, 140, 0.45), 0 18px 45px rgba(0, 0, 0, 0.5);
        }
        .gf-main {
          padding: 22px;
          max-width: 1180px;
          margin: 0 auto;
        }
        .gf-intro {
          display: grid;
          grid-template-columns: 1.2fr 0.8fr;
          gap: 24px;
          padding: 26px 24px;
          border-radius: 22px;
          border: 1px solid rgba(255, 255, 255, 0.1);
          background: linear-gradient(135deg, rgba(0, 0, 0, 0.45), rgba(0, 20, 15, 0.35));
          box-shadow: 0 30px 80px rgba(0, 0, 0, 0.45);
          margin-bottom: 18px;
        }
        .gf-introBadge {
          display: inline-flex;
          align-items: center;
          gap: 8px;
          padding: 6px 12px;
          border-radius: 999px;
          background: rgba(0, 255, 120, 0.12);
          border: 1px solid rgba(0, 255, 120, 0.35);
          font-size: 12px;
          font-weight: 700;
          text-transform: uppercase;
          letter-spacing: 0.8px;
        }
        .gf-introTitle {
          margin: 12px 0 0;
          font-size: 42px;
          letter-spacing: -1px;
        }
        .gf-introCopy {
          margin: 12px 0 0;
          opacity: 0.78;
          line-height: 1.6;
          max-width: 520px;
        }
        .gf-introNote {
          margin-top: 10px;
          font-size: 12px;
          opacity: 0.75;
          padding: 8px 10px;
          border-radius: 10px;
          border: 1px solid rgba(255, 255, 255, 0.12);
          background: rgba(0, 0, 0, 0.35);
          display: inline-flex;
        }
        .gf-introActions {
          display: flex;
          flex-wrap: wrap;
          gap: 10px;
          margin-top: 16px;
        }
        .gf-introMeta {
          margin-top: 14px;
          display: flex;
          gap: 12px;
          flex-wrap: wrap;
          font-size: 12px;
          opacity: 0.7;
        }
        .gf-introMeta span {
          padding: 6px 10px;
          border-radius: 999px;
          background: rgba(255, 255, 255, 0.06);
          border: 1px solid rgba(255, 255, 255, 0.12);
        }
        .gf-introRight {
          display: grid;
          align-content: center;
          justify-items: center;
          gap: 14px;
        }
        .gf-compactor {
          position: relative;
          width: 340px;
          height: 290px;
          display: grid;
          align-content: center;
          justify-items: center;
          gap: 10px;
        }
        .gf-compactorFrame {
          position: relative;
          width: 340px;
          height: 270px;
          border-radius: 20px;
          background: linear-gradient(180deg, rgba(12, 18, 16, 0.95), rgba(6, 10, 8, 0.98));
          border: 1px solid rgba(255, 255, 255, 0.08);
          box-shadow: inset 0 0 24px rgba(0, 0, 0, 0.7), 0 18px 40px rgba(0, 0, 0, 0.35);
          display: grid;
          align-content: start;
          justify-items: center;
          padding-top: 12px;
          overflow: hidden;
        }
        .gf-compactorFrame::before {
          content: '';
          position: absolute;
          inset: 10px;
          border-radius: 16px;
          border: 1px solid rgba(255, 255, 255, 0.06);
        }
        .gf-compactorFrame::after {
          content: '';
          position: absolute;
          left: 18px;
          right: 18px;
          bottom: 18px;
          height: 18px;
          border-radius: 8px;
          background: repeating-linear-gradient(
            135deg,
            rgba(255, 210, 80, 0.35) 0 10px,
            rgba(0, 0, 0, 0) 10px 20px
          );
          opacity: 0.7;
        }
        .gf-compactorPiston {
          position: absolute;
          top: 12px;
          width: 24px;
          height: 150px;
          border-radius: 10px;
          background: linear-gradient(180deg, rgba(70, 80, 72, 0.9), rgba(20, 30, 26, 0.95));
          border: 1px solid rgba(255, 255, 255, 0.08);
          box-shadow: inset 0 0 8px rgba(0, 0, 0, 0.6);
        }
        .gf-compactorPistonLeft { left: 16px; }
        .gf-compactorPistonRight { right: 16px; }
        .gf-compactorTop {
          width: 280px;
          height: 36px;
          border-radius: 10px;
          background: linear-gradient(180deg, rgba(60, 70, 62, 0.95), rgba(16, 24, 20, 0.98));
          border: 1px solid rgba(0, 255, 120, 0.22);
          box-shadow: 0 10px 24px rgba(0, 0, 0, 0.55);
          will-change: transform;
        }
        .gf-compactorChamber {
          position: relative;
          width: 280px;
          height: 145px;
          border-radius: 16px;
          background:
            linear-gradient(180deg, rgba(6, 10, 8, 0.95), rgba(18, 24, 20, 0.98)),
            linear-gradient(90deg, rgba(255, 255, 255, 0.06) 0 1px, transparent 1px 100%),
            linear-gradient(180deg, rgba(255, 255, 255, 0.04) 0 1px, transparent 1px 100%);
          background-size: auto, 24px 100%, 100% 22px;
          border: 1px solid rgba(255, 255, 255, 0.08);
          overflow: hidden;
          display: grid;
          align-items: center;
          justify-items: center;
          animation: chamberPulse 3.4s ease-in-out infinite !important;
          box-shadow: inset 0 0 24px rgba(0, 0, 0, 0.7);
        }
        .gf-compactorChamber::before {
          content: '';
          position: absolute;
          inset: 10px;
          border-radius: 12px;
          border: 1px solid rgba(255, 255, 255, 0.08);
        }
        .gf-compactorChamber::after {
          content: '';
          position: absolute;
          left: 14px;
          right: 14px;
          bottom: 10px;
          height: 18px;
          border-radius: 8px;
          background: linear-gradient(180deg, rgba(60, 70, 62, 0.85), rgba(16, 24, 20, 0.95));
          border: 1px solid rgba(0, 255, 140, 0.2);
          box-shadow: inset 0 0 8px rgba(0, 0, 0, 0.6);
        }
        .gf-compactorPressPlate {
          position: absolute;
          top: 12px;
          left: 18px;
          right: 18px;
          height: 26px;
          border-radius: 8px;
          background:
            repeating-linear-gradient(
              135deg,
              rgba(255, 210, 80, 0.9) 0 10px,
              rgba(18, 18, 18, 0.95) 10px 20px
            ),
            linear-gradient(180deg, rgba(60, 70, 62, 0.95), rgba(16, 24, 20, 0.98));
          border: 1px solid rgba(255, 255, 255, 0.1);
          box-shadow: 0 8px 18px rgba(0, 0, 0, 0.6);
          will-change: transform;
        }
        .gf-trashPile {
          position: absolute;
          bottom: 18px;
          left: 50%;
          width: 130px;
          height: 64px;
          transform: translateX(-50%);
          opacity: 0.98;
          transform-origin: center bottom;
        }
        .gf-trashPile .piece {
          position: absolute;
          background-repeat: no-repeat;
          background-size: contain;
          background-position: center;
          filter: drop-shadow(0 6px 8px rgba(0, 0, 0, 0.45));
          opacity: 0.95;
        }
        .gf-trashPile .t1 { left: 2px; top: 30px; width: 38px; height: 28px; transform: rotate(-6deg); }
        .gf-trashPile .t2 { left: 32px; top: 32px; width: 30px; height: 22px; transform: rotate(3deg); }
        .gf-trashPile .t3 { left: 56px; top: 28px; width: 26px; height: 32px; transform: rotate(-7deg); }
        .gf-trashPile .t4 { left: 82px; top: 34px; width: 32px; height: 22px; transform: rotate(5deg); }
        .gf-trashPile .t5 { left: 16px; top: 10px; width: 30px; height: 22px; transform: rotate(2deg); }
        .gf-trashPile .t6 { left: 44px; top: 6px; width: 32px; height: 22px; transform: rotate(-2deg); }
        .gf-trashPile .t1 { background-image: url('data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSI2MCIgaGVpZ2h0PSI1MCIgdmlld0JveD0iMCAwIDYwIDUwIj48cGF0aCBkPSJNMjIgOGMwIDYgNiAxMCA4IDEwczgtNCA4LTEwIiBmaWxsPSJub25lIiBzdHJva2U9InJnYmEoMjIwLDIyMCwyMjAsMC43KSIgc3Ryb2tlLXdpZHRoPSI0Ii8+PHBhdGggZD0iTTE0IDE2Yy02IDEwLTYgMjItNiAzMCAwIDEwIDEwIDE2IDIyIDE2czIyLTYgMjItMTZjMC04IDAtMjAtNi0zMCIgZmlsbD0icmdiYSg0MCw0MCw0MCwwLjc1KSIgc3Ryb2tlPSJyZ2JhKDIwMCwyMDAsMjAwLDAuNSkiIHN0cm9rZS13aWR0aD0iMyIvPjwvc3ZnPg=='); }
        .gf-trashPile .t2 { background-image: url('data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSI1MCIgaGVpZ2h0PSI0MCIgdmlld0JveD0iMCAwIDUwIDQwIj48cmVjdCB4PSIxMiIgeT0iNiIgd2lkdGg9IjI2IiBoZWlnaHQ9IjI4IiByeD0iNiIgZmlsbD0icmdiYSgxMjAsMTQwLDEzMCwwLjYpIiBzdHJva2U9InJnYmEoMjAwLDIwMCwyMDAsMC41KSIgc3Ryb2tlLXdpZHRoPSIzIi8+PHJlY3QgeD0iMTgiIHk9IjEwIiB3aWR0aD0iMTQiIGhlaWdodD0iNiIgcng9IjMiIGZpbGw9InJnYmEoNDAsNDAsNDAsMC40KSIvPjwvc3ZnPg=='); }
        .gf-trashPile .t3 { background-image: url('data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSI0MCIgaGVpZ2h0PSI1MCIgdmlld0JveD0iMCAwIDQwIDUwIj48cGF0aCBkPSJNMTQgNmgxMmwyIDRoLTE2eiIgZmlsbD0icmdiYSgxNjAsMTgwLDE3MCwwLjcpIi8+PHBhdGggZD0iTTEwIDEwaDIwdjMwYTggOCAwIDAgMS04IDhoLTRhOCA4IDAgMCAxLTgtOHoiIGZpbGw9InJnYmEoOTAsMTAwLDk1LDAuNzUpIiBzdHJva2U9InJnYmEoMjAwLDIwMCwyMDAsMC40KSIgc3Ryb2tlLXdpZHRoPSIzIi8+PC9zdmc+'); }
        .gf-trashPile .t4 { background-image: url('data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSI1MCIgaGVpZ2h0PSI0MCIgdmlld0JveD0iMCAwIDUwIDQwIj48cGF0aCBkPSJNOCAyNmMxMC04IDIwLTE0IDM0LTEwIiBzdHJva2U9InJnYmEoMjAwLDIwMCwyMDAsMC41KSIgc3Ryb2tlLXdpZHRoPSI2IiBmaWxsPSJub25lIi8+PHBhdGggZD0iTTEwIDMwYzE0LTYgMjQtOCAzMi00IiBzdHJva2U9InJnYmEoMTIwLDE0MCwxMzAsMC41KSIgc3Ryb2tlLXdpZHRoPSI0IiBmaWxsPSJub25lIi8+PC9zdmc+'); }
        .gf-trashPile .t5 { background-image: url('data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSI0MCIgaGVpZ2h0PSIzMCIgdmlld0JveD0iMCAwIDQwIDMwIj48Y2lyY2xlIGN4PSIxNSIgY3k9IjE2IiByPSI5IiBmaWxsPSJyZ2JhKDE1MCwxNjAsMTUwLDAuNikIi8+PHBhdGggZD0iTTIyIDguNWgxMCIgc3Ryb2tlPSJyZ2JhKDIwMCwyMDAsMjAwLDAuNSkiIHN0cm9rZS13aWR0aD0iMyIgLz48L3N2Zz4='); }
        .gf-trashPile .t6 { background-image: url('data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSI0NCIgaGVpZ2h0PSIzMCIgdmlld0JveD0iMCAwIDQ0IDMwIj48cmVjdCB4PSI4IiB5PSI4IiB3aWR0aD0iMjgiIGhlaWdodD0iMTQiIHJ4PSI3IiBmaWxsPSJyZ2JhKDEwMCwxMTAsMTAwLDAuNikiIHN0cm9rZT0icmdiYSgyMDAsMjAwLDIwMCwwLjQpIiBzdHJva2Utd2lkdGg9IjMiLz48L3N2Zz4='); }
        .gf-pressBale {
          position: absolute;
          bottom: 20px;
          width: 64px;
          height: 54px;
          border-radius: 8px;
          background:
            linear-gradient(145deg, rgba(28, 32, 30, 0.98), rgba(10, 12, 11, 0.98)),
            repeating-linear-gradient(90deg, rgba(255, 255, 255, 0.06) 0 6px, transparent 6px 12px);
          border: 1px solid rgba(0, 255, 160, 0.25);
          box-shadow:
            0 0 18px rgba(0, 0, 0, 0.7),
            inset 0 0 12px rgba(0, 0, 0, 0.8);
          opacity: 0;
          transform: scale(0.2);
          transform-origin: center bottom;
        }
        .gf-pressBale::before {
          content: '';
          position: absolute;
          top: 6px;
          left: 6px;
          width: 16px;
          height: 16px;
          border-radius: 4px;
          background: repeating-linear-gradient(
            45deg,
            rgba(255, 210, 80, 0.95) 0 4px,
            rgba(20, 20, 20, 0.9) 4px 8px
          );
          box-shadow: 0 0 6px rgba(0, 0, 0, 0.6);
        }
        .gf-pressBale::after {
          content: '';
          position: absolute;
          right: 6px;
          top: 0;
          bottom: 0;
          width: 6px;
          background: linear-gradient(180deg, rgba(140, 160, 150, 0.8), rgba(40, 50, 44, 0.9));
          opacity: 0.8;
        }
        .gf-pressBale .baleBit {
          position: absolute;
          background-repeat: no-repeat;
          background-size: contain;
          background-position: center;
          opacity: 0.9;
          filter: drop-shadow(0 3px 4px rgba(0, 0, 0, 0.5));
        }
        .gf-pressBale .b1 { left: 6px; bottom: 6px; width: 20px; height: 16px; transform: rotate(-8deg); }
        .gf-pressBale .b2 { left: 26px; bottom: 10px; width: 18px; height: 14px; transform: rotate(6deg); }
        .gf-pressBale .b3 { right: 8px; bottom: 8px; width: 20px; height: 16px; transform: rotate(-4deg); }
        .gf-pressBale .b1 { background-image: url('data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSI1MCIgaGVpZ2h0PSI0MCIgdmlld0JveD0iMCAwIDUwIDQwIj48cmVjdCB4PSIxMiIgeT0iNiIgd2lkdGg9IjI2IiBoZWlnaHQ9IjI4IiByeD0iNiIgZmlsbD0icmdiYSgxMjAsMTQwLDEzMCwwLjYpIiBzdHJva2U9InJnYmEoMjAwLDIwMCwyMDAsMC41KSIgc3Ryb2tlLXdpZHRoPSIzIi8+PHJlY3QgeD0iMTgiIHk9IjEwIiB3aWR0aD0iMTQiIGhlaWdodD0iNiIgcng9IjMiIGZpbGw9InJnYmEoNDAsNDAsNDAsMC40KSIvPjwvc3ZnPg=='); }
        .gf-pressBale .b2 { background-image: url('data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSI0MCIgaGVpZ2h0PSIzMCIgdmlld0JveD0iMCAwIDQwIDMwIj48Y2lyY2xlIGN4PSIxNSIgY3k9IjE2IiByPSI5IiBmaWxsPSJyZ2JhKDE1MCwxNjAsMTUwLDAuNikIi8+PHBhdGggZD0iTTIyIDguNWgxMCIgc3Ryb2tlPSJyZ2JhKDIwMCwyMDAsMjAwLDAuNSkiIHN0cm9rZS13aWR0aD0iMyIgLz48L3N2Zz4='); }
        .gf-pressBale .b3 { background-image: url('data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSI0NCIgaGVpZ2h0PSIzMCIgdmlld0JveD0iMCAwIDQ0IDMwIj48cmVjdCB4PSI4IiB5PSI4IiB3aWR0aD0iMjgiIGhlaWdodD0iMTQiIHJ4PSI3IiBmaWxsPSJyZ2JhKDEwMCwxMTAsMTAwLDAuNikiIHN0cm9rZT0icmdiYSgyMDAsMjAwLDIwMCwwLjQpIiBzdHJva2Utd2lkdGg9IjMiLz48L3N2Zz4='); }
        .gf-compactorBase {
          width: 280px;
          height: 26px;
          border-radius: 10px;
          background: linear-gradient(180deg, rgba(12, 18, 16, 0.9), rgba(5, 8, 7, 0.95));
          border: 1px solid rgba(255, 255, 255, 0.08);
          position: relative;
          overflow: hidden;
        }
        .gf-compactorBase::after {
          content: '';
          position: absolute;
          inset: 5px 10px;
          border-radius: 8px;
          background: repeating-linear-gradient(
            135deg,
            rgba(255, 210, 80, 0.28) 0 10px,
            rgba(0, 0, 0, 0) 10px 20px
          );
          opacity: 0.6;
        }
        .gf-hero {
          border: 1px solid rgba(255, 255, 255, 0.10);
          background: rgba(0, 0, 0, 0.22);
          border-radius: 18px;
          padding: 18px 18px;
          backdrop-filter: blur(10px);
        }
        .gf-h1 {
          margin: 0;
          font-size: 36px;
          letter-spacing: -0.8px;
        }
        .gf-accent {
          color: rgba(0, 255, 120, 0.95);
        }
        .gf-p {
          margin: 10px 0 0;
          opacity: 0.8;
          line-height: 1.5;
          max-width: 860px;
        }
        .gf-grid {
          display: grid;
          grid-template-columns: 1.05fr 0.95fr;
          gap: 16px;
          margin-top: 16px;
        }
        .gf-gridSingle {
          display: grid;
          grid-template-columns: 1fr;
          margin-top: 16px;
        }
        .gf-card {
          border: 1px solid rgba(255, 255, 255, 0.10);
          background: rgba(0, 0, 0, 0.22);
          border-radius: 18px;
          padding: 16px;
          backdrop-filter: blur(10px);
          min-width: 0;
        }
        .gf-cardRight {
          position: sticky;
          top: 88px;
          align-self: start;
        }
        .gf-cardTitleRow {
          display: flex;
          align-items: baseline;
          justify-content: space-between;
          gap: 10px;
          flex-wrap: wrap;
        }
        .gf-cardTitle {
          font-weight: 900;
        }
        .gf-cardMeta {
          font-size: 12px;
          opacity: 0.75;
        }
        .gf-muted {
          opacity: 0.75;
          margin-top: 10px;
          font-size: 13px;
        }
        .gf-mutedSmall {
          font-size: 12px;
          opacity: 0.75;
        }
        .gf-input {
          flex: 1;
          min-width: 0;
          border-radius: 12px;
          border: 1px solid rgba(255, 255, 255, 0.16);
          background: rgba(0, 0, 0, 0.4);
          padding: 10px 12px;
          color: rgba(255, 255, 255, 0.9);
          font-size: 12px;
        }
        .gf-warn {
          margin-top: 10px;
          border: 1px solid rgba(255, 80, 80, 0.25);
          background: rgba(255, 80, 80, 0.10);
          padding: 10px 12px;
          border-radius: 12px;
          font-size: 13px;
        }
        .gf-row {
          display: flex;
          align-items: center;
          gap: 10px;
          margin-top: 10px;
        }
        .gf-rowSpace {
          justify-content: space-between;
        }
        .gf-divider {
          height: 1px;
          background: rgba(255, 255, 255, 0.08);
          margin: 14px 0;
        }
        .gf-nftGrid {
          margin-top: 12px;
          display: grid;
          grid-template-columns: repeat(3, minmax(0, 1fr));
          gap: 12px;
          max-height: 360px;
          overflow: auto;
          padding-right: 2px;
        }
        .gf-nftTile {
          position: relative;
          border: 1px solid rgba(255, 255, 255, 0.08);
          background:
            linear-gradient(180deg, rgba(16, 18, 16, 0.95), rgba(6, 8, 7, 0.95)),
            radial-gradient(circle at 20% 10%, rgba(0, 255, 140, 0.12), transparent 60%),
            radial-gradient(circle at 80% 90%, rgba(120, 70, 20, 0.18), transparent 45%);
          border-radius: 18px;
          padding: 10px;
          cursor: pointer;
          text-align: left;
          overflow: hidden;
          transition: transform 0.18s ease, border-color 0.2s ease, box-shadow 0.2s ease;
        }
        .gf-nftTile::before {
          content: 'REFURB';
          position: absolute;
          top: 10px;
          left: 10px;
          font-size: 9px;
          letter-spacing: 1px;
          padding: 4px 6px;
          border-radius: 999px;
          background: rgba(0, 0, 0, 0.55);
          border: 1px solid rgba(0, 255, 160, 0.35);
          color: rgba(160, 255, 220, 0.9);
          text-transform: uppercase;
          z-index: 1;
        }
        .gf-nftTileActive {
          border-color: rgba(0, 255, 140, 0.5);
          box-shadow:
            0 0 0 2px rgba(0, 255, 140, 0.15) inset,
            0 10px 30px rgba(0, 0, 0, 0.45);
          transform: translateY(-2px);
        }
        .gf-nftImg {
          width: 100%;
          aspect-ratio: 1/1;
          object-fit: cover;
          border-radius: 14px;
          background: rgba(0, 0, 0, 0.35);
          border: 1px solid rgba(255, 255, 255, 0.06);
          box-shadow: inset 0 0 16px rgba(0, 0, 0, 0.35);
        }
        .gf-nftName {
          margin-top: 8px;
          font-size: 12px;
          opacity: 0.9;
          font-weight: 700;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }
        .gf-tierHeaderRow {
          display: flex;
          align-items: baseline;
          justify-content: space-between;
          gap: 12px;
        }
        .gf-tierHint {
          font-size: 12px;
          opacity: 0.6;
        }
        .gf-tierCompare {
          margin-top: 10px;
          display: flex;
          align-items: center;
          gap: 8px;
          flex-wrap: wrap;
          font-size: 11px;
          text-transform: uppercase;
          letter-spacing: 0.8px;
        }
        .gf-compareItem {
          padding: 6px 10px;
          border-radius: 999px;
          border: 1px solid rgba(255, 255, 255, 0.12);
          background: rgba(0, 0, 0, 0.35);
          font-weight: 700;
        }
        .gf-compareCommon {
          border-color: rgba(255, 210, 120, 0.35);
          color: rgba(255, 225, 170, 0.9);
        }
        .gf-compareRare {
          border-color: rgba(120, 255, 200, 0.35);
          color: rgba(140, 255, 210, 0.9);
        }
        .gf-compareMythic {
          border-color: rgba(255, 220, 120, 0.45);
          color: rgba(255, 240, 170, 0.95);
        }
        .gf-compareArrow {
          opacity: 0.4;
        }
        .gf-tierGrid {
          margin-top: 14px;
          display: grid;
          gap: 18px;
        }
        .gf-tierSectionCompact .gf-tierGrid {
          grid-template-columns: repeat(3, minmax(0, 1fr));
          gap: 14px;
        }
        .gf-tierSectionCompact .gf-tierCard {
          padding: 14px;
          gap: 10px;
        }
        .gf-tierSectionCompact .gf-tierBody {
          grid-template-columns: 1fr;
          gap: 10px;
        }
        .gf-tierSectionCompact .gf-tierPreview {
          width: 100%;
          height: 92px;
        }
        .gf-tierSectionCompact .gf-tierDesc {
          font-size: 11px;
        }
        .gf-tierSectionCompact .gf-tierChips {
          gap: 4px;
        }
        .gf-tierSectionCompact .gf-tierChips span {
          font-size: 10px;
          padding: 3px 6px;
        }
        .gf-tierSectionCompact .gf-tierMeter {
          display: grid;
        }
        .gf-tierSectionCompact .gf-tierMeterLabel {
          font-size: 10px;
        }
        .gf-tierSectionCompact .gf-tierMeterHint {
          font-size: 10px;
        }
        .gf-tierSectionCompact .gf-tierFooter {
          grid-template-columns: 1fr auto;
          align-items: end;
        }
        .gf-tierSectionCompact .gf-tierOddsBar {
          width: 120px;
        }
        .gf-tierSectionCompact .gf-tierMeterBar {
          width: 120px;
        }
        .gf-tierSectionCompact .gf-tierCTA {
          margin-top: 0;
        }
        .gf-tierCard {
          position: relative;
          border: 1px solid rgba(255, 255, 255, 0.14);
          border-radius: 22px;
          padding: 18px;
          text-align: left;
          color: rgba(255, 255, 255, 0.95);
          background:
            linear-gradient(160deg, rgba(10, 12, 12, 0.98), rgba(6, 10, 8, 0.96)),
            radial-gradient(circle at 15% 10%, rgba(0, 255, 180, 0.12), transparent 55%);
          box-shadow: inset 0 0 40px rgba(0, 0, 0, 0.35);
          display: grid;
          gap: 14px;
          overflow: hidden;
          cursor: pointer;
          transition: transform 0.2s ease, border-color 0.2s ease, box-shadow 0.2s ease;
        }
        .gf-tierCard:hover {
          transform: translateY(-2px);
        }
        .gf-tierActive {
          border-color: rgba(0, 255, 180, 0.6);
          box-shadow:
            0 0 0 2px rgba(0, 255, 180, 0.18) inset,
            0 18px 50px rgba(0, 0, 0, 0.6);
          transform: translateY(-3px);
        }
        .gf-tierTop {
          display: flex;
          align-items: center;
          justify-content: space-between;
        }
        .gf-tierBadge {
          font-size: 11px;
          font-weight: 800;
          letter-spacing: 1px;
          text-transform: uppercase;
          padding: 6px 10px;
          border-radius: 999px;
          background: rgba(0, 0, 0, 0.35);
          border: 1px solid rgba(255, 255, 255, 0.16);
        }
        .gf-tierBadgeRare {
          border-color: rgba(120, 255, 200, 0.35);
          color: rgba(160, 255, 210, 0.9);
        }
        .gf-tierBadgeMythic {
          border-color: rgba(255, 220, 120, 0.45);
          color: rgba(255, 240, 170, 0.95);
        }
        .gf-tierSelected {
          font-size: 11px;
          font-weight: 800;
          text-transform: uppercase;
          letter-spacing: 1px;
          padding: 6px 10px;
          border-radius: 999px;
          color: rgba(0, 255, 180, 0.9);
          border: 1px solid rgba(0, 255, 180, 0.45);
          background: rgba(0, 255, 180, 0.12);
        }
        .gf-tierBody {
          display: grid;
          grid-template-columns: 120px 1fr;
          gap: 14px;
          align-items: center;
        }
        .gf-tierPreview {
          position: relative;
          width: 120px;
          height: 120px;
          border-radius: 18px;
          border: 1px solid rgba(255, 255, 255, 0.16);
          overflow: hidden;
          box-shadow: inset 0 0 18px rgba(0, 0, 0, 0.6);
          background-size: 140% 140%;
          animation: previewShift 6s ease-in-out infinite;
        }
        .gf-tierPreview::before {
          content: '';
          position: absolute;
          inset: -30%;
          background: radial-gradient(circle at 30% 30%, rgba(255, 255, 255, 0.25), transparent 55%);
          animation: previewPulse 3.6s ease-in-out infinite;
        }
        .gf-tierPreview::after {
          content: '';
          position: absolute;
          inset: 0;
          background: repeating-linear-gradient(45deg, rgba(255, 255, 255, 0.06) 0 8px, transparent 8px 16px);
          opacity: 0.45;
          mix-blend-mode: screen;
        }
        .gf-tierPreviewTag {
          position: absolute;
          left: 8px;
          bottom: 8px;
          font-size: 10px;
          font-weight: 800;
          text-transform: uppercase;
          letter-spacing: 0.8px;
          padding: 4px 6px;
          border-radius: 999px;
          background: rgba(0, 0, 0, 0.6);
          border: 1px solid rgba(255, 255, 255, 0.2);
        }
        .gf-tierPreviewConveyor {
          background:
            radial-gradient(circle at 20% 20%, rgba(255, 200, 80, 0.6), transparent 50%),
            linear-gradient(140deg, rgba(24, 18, 10, 0.95), rgba(8, 10, 8, 0.9));
        }
        .gf-tierPreviewCompactor {
          background:
            radial-gradient(circle at 20% 20%, rgba(120, 255, 200, 0.6), transparent 50%),
            linear-gradient(140deg, rgba(12, 20, 18, 0.95), rgba(6, 10, 8, 0.9));
        }
        .gf-tierPreviewHazmat {
          background:
            radial-gradient(circle at 20% 20%, rgba(255, 230, 120, 0.65), transparent 50%),
            linear-gradient(140deg, rgba(18, 18, 10, 0.95), rgba(8, 10, 8, 0.9));
          box-shadow: 0 0 18px rgba(255, 220, 120, 0.35);
        }
        .gf-tierInfo {
          display: grid;
          gap: 8px;
        }
        .gf-tierName {
          font-weight: 900;
          font-size: 16px;
        }
        .gf-tierDesc {
          font-size: 12px;
          opacity: 0.78;
          line-height: 1.5;
        }
        .gf-tierChips {
          display: flex;
          flex-wrap: wrap;
          gap: 6px;
          font-size: 11px;
        }
        .gf-tierChips span {
          padding: 4px 8px;
          border-radius: 999px;
          background: rgba(255, 255, 255, 0.06);
          border: 1px solid rgba(255, 255, 255, 0.12);
        }
        .gf-tierMeter {
          display: grid;
          gap: 6px;
        }
        .gf-tierMeterLabel {
          font-size: 11px;
          text-transform: uppercase;
          letter-spacing: 0.8px;
          opacity: 0.7;
        }
        .gf-tierMeterBar {
          width: 140px;
          height: 6px;
          border-radius: 999px;
          background: rgba(255, 255, 255, 0.08);
          overflow: hidden;
        }
        .gf-tierMeterBar span {
          display: block;
          height: 100%;
          border-radius: 999px;
          background: linear-gradient(90deg, rgba(255, 200, 80, 0.9), rgba(255, 120, 80, 0.7));
        }
        .gf-tierMeterMid span {
          background: linear-gradient(90deg, rgba(120, 255, 200, 0.9), rgba(60, 180, 140, 0.7));
        }
        .gf-tierMeterHigh span {
          background: linear-gradient(90deg, rgba(255, 220, 120, 0.95), rgba(120, 255, 140, 0.8));
        }
        .gf-tierMeterHint {
          font-size: 11px;
          opacity: 0.7;
        }
        .gf-tierFooter {
          display: grid;
          grid-template-columns: 1fr auto;
          align-items: end;
          gap: 12px;
        }
        .gf-tierOdds {
          display: grid;
          gap: 6px;
          font-size: 11px;
          justify-items: end;
          text-align: right;
        }
        .gf-tierOddsLabel {
          text-transform: uppercase;
          letter-spacing: 0.8px;
          opacity: 0.7;
        }
        .gf-tierOddsBar {
          width: 140px;
          height: 6px;
          border-radius: 999px;
          background: rgba(255, 255, 255, 0.08);
          overflow: hidden;
        }
        .gf-tierOddsBar span {
          display: block;
          height: 100%;
          background: linear-gradient(90deg, rgba(255, 200, 80, 0.9), rgba(255, 120, 80, 0.7));
        }
        .gf-tierOddsBarRare span {
          background: linear-gradient(90deg, rgba(120, 255, 200, 0.9), rgba(60, 180, 140, 0.7));
        }
        .gf-tierOddsBarMythic span {
          background: linear-gradient(90deg, rgba(255, 220, 120, 0.95), rgba(120, 255, 140, 0.8));
        }
        .gf-tierOddsText {
          opacity: 0.8;
        }
        .gf-tierPrice {
          text-align: left;
          font-size: 11px;
        }
        .gf-tierPriceLabel {
          text-transform: uppercase;
          letter-spacing: 0.8px;
          opacity: 0.7;
        }
        .gf-tierPriceValue {
          font-size: 16px;
          font-weight: 800;
        }
        .gf-tierLeft {
          display: grid;
          gap: 8px;
          justify-items: start;
        }
        .gf-tierCTA {
          margin-top: 6px;
          padding: 10px 12px;
          border-radius: 14px;
          background: rgba(255, 255, 255, 0.06);
          border: 1px solid rgba(255, 255, 255, 0.16);
          font-size: 11px;
          font-weight: 800;
          text-transform: uppercase;
          letter-spacing: 1px;
          text-align: center;
        }
        .gf-tierActive .gf-tierCTA {
          border-color: rgba(0, 255, 180, 0.45);
          color: rgba(0, 255, 180, 0.95);
          background: rgba(0, 255, 180, 0.12);
          box-shadow: 0 10px 24px rgba(0, 0, 0, 0.45);
        }
        .gf-tierConveyor::after,
        .gf-tierCompactor::after,
        .gf-tierHazmat::after {
          content: '';
          position: absolute;
          inset: 0;
          background: radial-gradient(circle at 85% 15%, rgba(255, 255, 255, 0.08), transparent 40%);
          opacity: 0.5;
          pointer-events: none;
        }
        .gf-tierConveyor {
          border-left: 4px solid rgba(255, 200, 80, 0.7);
        }
        .gf-tierCompactor {
          border-left: 4px solid rgba(120, 255, 200, 0.7);
        }
        .gf-tierHazmat {
          border-left: 4px solid rgba(255, 220, 120, 0.9);
          background:
            linear-gradient(160deg, rgba(14, 16, 10, 0.98), rgba(6, 12, 8, 0.96)),
            radial-gradient(circle at 15% 10%, rgba(120, 255, 140, 0.18), transparent 55%),
            radial-gradient(circle at 80% 80%, rgba(255, 230, 120, 0.12), transparent 50%);
        }
        .gf-nftTile::after {
          content: '';
          position: absolute;
          inset: 0;
          background:
            radial-gradient(circle at 80% 0%, rgba(0, 255, 160, 0.2), transparent 40%),
            linear-gradient(160deg, rgba(120, 70, 20, 0.2), transparent 50%);
          opacity: 0;
          transition: opacity 0.2s ease;
          pointer-events: none;
        }
        .gf-nftTile:hover,
        .gf-tierCard:hover {
          transform: translateY(-2px);
        }
        .gf-nftTile:hover::after {
          opacity: 1;
        }
        .gf-liveDot {
          display: inline-flex;
          align-items: center;
          gap: 8px;
        }
        .gf-liveDotInner {
          width: 9px;
          height: 9px;
          border-radius: 999px;
          background: rgba(0, 255, 120, 0.85);
          box-shadow: 0 0 16px rgba(0, 255, 120, 0.35);
        }
        .gf-previewFrame {
          margin-top: 12px;
          border: 1px solid rgba(255, 255, 255, 0.10);
          background: rgba(255, 255, 255, 0.03);
          border-radius: 16px;
          padding: 12px;
          min-height: 420px;
          display: flex;
          align-items: stretch;
          justify-content: stretch;
          overflow: hidden;
        }
        .gf-previewCanvas {
          width: 100%;
          height: 100%;
          border-radius: 12px;
          display: block;
        }
        .gf-previewBadge {
          margin-top: 10px;
          font-size: 12px;
          opacity: 0.75;
        }
        .gf-effectLine {
          display: flex;
          align-items: center;
          gap: 10px;
        }
        .gf-effectText {
          display: inline-block;
          animation: effectFade 2.8s ease-in-out;
        }
        .gf-effectExtras {
          font-size: 11px;
          opacity: 0.6;
          text-transform: uppercase;
          letter-spacing: 0.8px;
        }
        .gf-previewStack {
          position: relative;
          width: 100%;
          height: 100%;
        }
        .gf-previewImg {
          width: 100%;
          height: auto;
          border-radius: 12px;
          object-fit: contain;
          display: block;
        }
        .gf-previewOverlay,
        .gf-previewScanlines,
        .gf-previewGrain,
        .gf-previewGlow,
        .gf-previewGlitch,
        .gf-previewTexture,
        .gf-previewEdge,
        .gf-previewBg,
        .gf-previewVignette,
        .gf-previewPrimary,
        .gf-previewDecal,
        .gf-previewBurn,
        .gf-previewColorWash {
          position: absolute;
          inset: 0;
          border-radius: 12px;
          pointer-events: none;
          transition: opacity 0.6s ease, filter 0.6s ease;
        }
        .gf-previewOverlay {
          mix-blend-mode: screen;
          opacity: 0.6;
        }
        .gf-previewScanlines {
          background: repeating-linear-gradient(
            0deg,
            rgba(255, 255, 255, 0.04) 0 1px,
            rgba(0, 0, 0, 0) 1px 3px
          );
          opacity: 0.35;
        }
        .gf-previewGrain {
          background: radial-gradient(circle at 20% 20%, rgba(255, 255, 255, 0.04), transparent 40%),
            radial-gradient(circle at 80% 80%, rgba(255, 255, 255, 0.05), transparent 45%);
          opacity: 0.5;
          filter: blur(0.2px);
        }
        .gf-previewGlow {
          background: radial-gradient(circle at 50% 10%, rgba(0, 255, 180, 0.35), transparent 55%);
          opacity: 0.5;
          mix-blend-mode: screen;
        }
        .gf-previewGlitch {
          background: linear-gradient(90deg, rgba(255, 0, 120, 0.12), transparent 40%),
            linear-gradient(180deg, rgba(0, 255, 200, 0.1), transparent 50%);
          opacity: 0;
          mix-blend-mode: screen;
          animation: glitchPulse 4.2s steps(1) infinite;
        }
        .gf-previewBg {
          opacity: 0.6;
          mix-blend-mode: multiply;
        }
        .gf-previewColorWash {
          opacity: 0.35;
          mix-blend-mode: screen;
          background: radial-gradient(circle at 20% 30%, rgba(0, 255, 200, 0.25), transparent 55%),
            radial-gradient(circle at 80% 80%, rgba(255, 120, 200, 0.2), transparent 60%);
        }
        .gf-effectConveyor .gf-previewBg {
          background:
            radial-gradient(circle at 20% 20%, rgba(70, 40, 20, 0.35), transparent 55%),
            radial-gradient(circle at 80% 80%, rgba(20, 50, 40, 0.35), transparent 60%);
        }
        .gf-effectCompactor .gf-previewBg {
          background:
            radial-gradient(circle at 30% 30%, rgba(0, 80, 60, 0.45), transparent 55%),
            radial-gradient(circle at 70% 70%, rgba(80, 30, 10, 0.35), transparent 60%);
        }
        .gf-effectHazmat .gf-previewBg {
          background:
            radial-gradient(circle at 30% 30%, rgba(60, 90, 40, 0.45), transparent 55%),
            radial-gradient(circle at 70% 70%, rgba(100, 50, 10, 0.35), transparent 60%);
        }
        .gf-previewPrimary {
          opacity: 0.5;
          mix-blend-mode: screen;
        }
        .gf-previewDecal {
          opacity: 0.35;
          mix-blend-mode: screen;
          background-repeat: no-repeat;
          background-position: 80% 20%;
          background-size: 160px 160px;
        }
        .gf-previewDecalA {
          background-position: 82% 18%;
        }
        .gf-previewDecalB {
          background-position: 18% 78%;
          background-size: 120px 120px;
          opacity: 0.28;
        }
        .gf-previewBurn {
          opacity: 0.45;
          mix-blend-mode: multiply;
          background:
            radial-gradient(circle at 10% 90%, rgba(60, 20, 10, 0.5), transparent 40%),
            radial-gradient(circle at 90% 10%, rgba(40, 15, 10, 0.45), transparent 45%),
            radial-gradient(circle at 80% 80%, rgba(20, 10, 8, 0.55), transparent 45%);
        }
        .gf-primaryDefault {
          background: radial-gradient(circle at 50% 30%, rgba(255, 255, 255, 0.08), transparent 55%);
        }
        .gf-primaryInvert {
          mix-blend-mode: normal;
          opacity: 0.9;
        }
        .gf-primaryGraffiti {
          background:
            linear-gradient(130deg, rgba(255, 120, 180, 0.28), transparent 45%),
            linear-gradient(220deg, rgba(0, 255, 200, 0.22), transparent 40%),
            repeating-linear-gradient(90deg, rgba(255, 255, 255, 0.12) 0 2px, transparent 2px 6px);
          opacity: 0.75;
        }
        .gf-primaryRust {
          background: radial-gradient(circle at 40% 40%, rgba(180, 90, 30, 0.35), transparent 55%),
            radial-gradient(circle at 70% 70%, rgba(80, 40, 20, 0.25), transparent 60%);
        }
        .gf-primaryOil {
          background: radial-gradient(circle at 60% 30%, rgba(20, 40, 80, 0.35), transparent 55%),
            radial-gradient(circle at 30% 70%, rgba(20, 80, 60, 0.25), transparent 60%);
        }
        .gf-primarySlime {
          background: radial-gradient(circle at 50% 40%, rgba(0, 255, 160, 0.5), transparent 55%);
          opacity: 0.7;
        }
        .gf-primaryBio {
          background: radial-gradient(circle at 50% 40%, rgba(0, 255, 200, 0.55), transparent 55%),
            radial-gradient(circle at 70% 70%, rgba(40, 255, 120, 0.25), transparent 60%);
          opacity: 0.7;
        }
        .gf-primaryVoid {
          background: radial-gradient(circle at 50% 50%, rgba(0, 0, 0, 0.45), transparent 60%);
          mix-blend-mode: multiply;
          opacity: 0.6;
        }
        .gf-primaryGold {
          background: radial-gradient(circle at 50% 40%, rgba(255, 220, 120, 0.6), transparent 55%);
          opacity: 0.75;
        }
        .gf-primaryHazard {
          background:
            repeating-linear-gradient(135deg, rgba(255, 220, 80, 0.35) 0 14px, rgba(20, 20, 20, 0.35) 14px 28px);
          opacity: 0.6;
        }
        .gf-primaryBag {
          background:
            radial-gradient(circle at 50% 50%, rgba(20, 20, 20, 0.6), transparent 60%),
            radial-gradient(circle at 50% 70%, rgba(40, 40, 40, 0.5), transparent 55%);
          opacity: 0.6;
        }
        .gf-previewTexture {
          opacity: 0.7;
          mix-blend-mode: multiply;
        }
        .gf-previewVignette {
          background: radial-gradient(circle at 50% 50%, transparent 55%, rgba(0, 0, 0, 0.45) 100%);
          opacity: 0.6;
          mix-blend-mode: multiply;
        }
        .gf-textureGrime {
          background: radial-gradient(circle at 30% 20%, rgba(30, 60, 40, 0.5), transparent 50%),
            radial-gradient(circle at 70% 80%, rgba(60, 30, 10, 0.35), transparent 55%);
        }
        .gf-textureOil {
          background: radial-gradient(circle at 60% 40%, rgba(30, 30, 60, 0.55), transparent 55%),
            radial-gradient(circle at 20% 80%, rgba(10, 40, 60, 0.45), transparent 50%);
        }
        .gf-textureSmog {
          background: linear-gradient(180deg, rgba(40, 50, 50, 0.35), transparent 60%);
        }
        .gf-textureMold {
          background: radial-gradient(circle at 20% 30%, rgba(40, 80, 30, 0.5), transparent 50%),
            radial-gradient(circle at 80% 70%, rgba(20, 60, 40, 0.4), transparent 55%);
        }
        .gf-textureDrip {
          background: linear-gradient(180deg, rgba(10, 50, 40, 0.45), transparent 70%),
            repeating-linear-gradient(180deg, transparent 50%, rgba(20, 60, 40, 0.35) 62%, transparent 74%);
        }
        .gf-textureSoot {
          background: radial-gradient(circle at 50% 60%, rgba(10, 10, 10, 0.45), transparent 55%);
        }
        .gf-previewEdge {
          opacity: 0.7;
          mix-blend-mode: screen;
        }
        .gf-edgeClean {
          box-shadow: inset 0 0 0 2px rgba(255, 255, 255, 0.08);
        }
        .gf-edgePitted {
          box-shadow: inset 0 0 14px rgba(0, 0, 0, 0.5), inset 0 0 0 2px rgba(80, 110, 90, 0.2);
        }
        .gf-edgeBurnt {
          box-shadow:
            inset 0 0 34px rgba(0, 0, 0, 0.75),
            inset 0 0 0 2px rgba(140, 40, 20, 0.55),
            inset 0 0 18px rgba(120, 60, 20, 0.35);
        }
        .gf-edgeSticker {
          box-shadow: inset 0 0 0 2px rgba(0, 255, 160, 0.18), inset 0 0 12px rgba(0, 255, 160, 0.15);
        }
        .gf-effectConveyor .gf-previewImg {
          filter: saturate(1.3) contrast(1.3) brightness(0.98);
        }
        .gf-effectConveyor .gf-previewOverlay,
        .gf-effectCompactor .gf-previewOverlay,
        .gf-effectHazmat .gf-previewOverlay {
          animation: previewPulse 3.6s ease-in-out infinite;
        }
        .gf-effectConveyor .gf-previewOverlay {
          background: radial-gradient(circle at 30% 10%, rgba(255, 200, 80, 0.55), transparent 55%),
            radial-gradient(circle at 80% 90%, rgba(120, 180, 255, 0.45), transparent 60%);
        }
        .gf-effectConveyor .gf-previewGlow {
          opacity: 0.45;
        }
        .gf-effectConveyor .gf-previewEdge {
          opacity: 0.85;
        }
        .gf-effectCompactor .gf-previewImg {
          filter: contrast(1.7) saturate(1.6) hue-rotate(-20deg) brightness(0.95);
        }
        .gf-effectCompactor .gf-previewOverlay {
          background: linear-gradient(135deg, rgba(80, 255, 200, 0.35), rgba(10, 40, 30, 0.6)),
            radial-gradient(circle at 70% 30%, rgba(255, 160, 40, 0.55), transparent 60%);
        }
        .gf-effectCompactor .gf-previewGlow {
          background: radial-gradient(circle at 30% 20%, rgba(0, 255, 220, 0.5), transparent 55%);
          opacity: 0.75;
        }
        .gf-effectCompactor .gf-previewEdge {
          opacity: 0.9;
        }
        .gf-effectHazmat .gf-previewImg {
          filter: saturate(1.2) contrast(1.2) brightness(1.02);
        }
        .gf-effectConveyor .gf-previewDecal {
          opacity: 0.3;
        }
        .gf-effectCompactor .gf-previewDecal {
          opacity: 0.45;
        }
        .gf-effectHazmat .gf-previewDecal {
          opacity: 0.65;
          background-size: 180px 180px;
        }
        .gf-primaryHazard.gf-previewDecal {
          opacity: 0.7;
          background-image: url("data:image/svg+xml;base64,PHN2ZyB4bWxucz0naHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmcnIHdpZHRoPScxNDAnIGhlaWdodD0nMTQwJyB2aWV3Qm94PScwIDAgMTQwIDE0MCc+PGcgZmlsbD0nbm9uZScgc3Ryb2tlPSdyZ2JhKDI1NSwyMjAsMTIwLDAuOSknIHN0cm9rZS13aWR0aD0nNic+PGNpcmNsZSBjeD0nNzAnIGN5PSc3MCcgcj0nNTgnLz48cGF0aCBkPSdNNzAgMjAgMTAwIDcwIDQwIDcweicvPjxjaXJjbGUgY3g9JzcwJyBjeT0nNzAnIHI9JzEwJy8+PC9nPjwvc3ZnPg==");
        }
        .gf-primaryBag.gf-previewDecal {
          opacity: 0.5;
          background-image: url('data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIxNDAiIGhlaWdodD0iMTQwIiB2aWV3Qm94PSIwIDAgMTQwIDE0MCI+PHBhdGggZD0iTTUwIDMwYzAgOCA2IDE0IDIwIDE0czIwLTYgMjAtMTQiIGZpbGw9Im5vbmUiIHN0cm9rZT0icmdiYSgyMDAsMjAwLDIwMCwwLjgpIiBzdHJva2Utd2lkdGg9IjYiLz48cGF0aCBkPSJNNDUgNDRjLTYgMTItOCAyNi04IDQwIDAgMjggMjAgNDYgMzMgNDZzMzMtMTggMzMtNDZjMC0xNC0yLTI4LTgtNDAiIGZpbGw9InJnYmEoNDAsNDAsNDAsMC41KSIgc3Ryb2tlPSJyZ2JhKDIwMCwyMDAsMjAwLDAuNikiIHN0cm9rZS13aWR0aD0iNCIvPjwvc3ZnPg==');
        }
        .gf-primaryGraffiti.gf-previewDecal {
          opacity: 0.6;
          background-image: url('data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIxNDAiIGhlaWdodD0iMTQwIiB2aWV3Qm94PSIwIDAgMTQwIDE0MCI+PHBhdGggZD0iTTEwIDkwYzIwLTMwIDUwLTUwIDkwLTQwIiBzdHJva2U9InJnYmEoMjU1LDEyMCwxODAsMC44KSIgc3Ryb2tlLXdpZHRoPSIxMCIgZmlsbD0ibm9uZSIvPjxwYXRoIGQ9Ik0yMCAxMTBjMzAtMTAgNjAtMjAgMTAwLTEwIiBzdHJva2U9InJnYmEoMCwyNTUsMjAwLDAuNykiIHN0cm9rZS13aWR0aD0iOCIgZmlsbD0ibm9uZSIvPjwvc3ZnPg==');
        }
        .gf-primaryHazard.gf-previewDecalB {
          opacity: 0.5;
          background-image: url("data:image/svg+xml;base64,PHN2ZyB4bWxucz0naHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmcnIHdpZHRoPScxMjAnIGhlaWdodD0nMTIwJyB2aWV3Qm94PScwIDAgMTIwIDEyMCc+PGcgZmlsbD0nbm9uZScgc3Ryb2tlPSdyZ2JhKDI1NSwyMjAsMTIwLDAuNzUpJyBzdHJva2Utd2lkdGg9JzUnPjxwYXRoIGQ9J002MCAxMCAxMTAgMTAwIDEwIDEwMHonLz48Y2lyY2xlIGN4PSc2MCcgY3k9JzYwJyByPScxMCcvPjwvZz48L3N2Zz4=");
        }
        .gf-primaryBag.gf-previewDecalB {
          opacity: 0.4;
          background-image: url('data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIxMjAiIGhlaWdodD0iMTIwIiB2aWV3Qm94PSIwIDAgMTIwIDEyMCI+PHBhdGggZD0iTTQwIDI2YzAgNiA1IDEwIDIwIDEwczIwLTQgMjAtMTAiIGZpbGw9Im5vbmUiIHN0cm9rZT0icmdiYSgyMDAsMjAwLDIwMCwwLjYpIiBzdHJva2Utd2lkdGg9IjYiLz48cGF0aCBkPSJNMzQgMzhjLTUgMTAtNiAyMi02IDM0IDAgMjQgMTYgMzggMzIgMzhzMzItMTQgMzItMzhjMC0xMi0yLTI0LTYtMzQiIGZpbGw9InJnYmEoMzAsMzAsMzAsMC41KSIgc3Ryb2tlPSJyZ2JhKDIwMCwyMDAsMjAwLDAuNSkiIHN0cm9rZS13aWR0aD0iNCIvPjwvc3ZnPg==');
        }
        .gf-primaryGraffiti.gf-previewDecalB {
          opacity: 0.5;
          background-image: url('data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIxMjAiIGhlaWdodD0iMTIwIiB2aWV3Qm94PSIwIDAgMTIwIDEyMCI+PHBhdGggZD0iTTEwIDcwYzIwLTIwIDUwLTMwIDkwLTIwIiBzdHJva2U9InJnYmEoMjU1LDEyMCwxODAsMC43KSIgc3Ryb2tlLXdpZHRoPSI4IiBmaWxsPSJub25lIi8+PHBhdGggZD0iTTE4IDkwYzI2LTggNTItMTQgODItNiIgc3Ryb2tlPSJyZ2JhKDAsMjU1LDIwMCwwLjYpIiBzdHJva2Utd2lkdGg9IjciIGZpbGw9Im5vbmUiLz48L3N2Zz4=');
        }
        .gf-tier-tier3 .gf-previewBurn {
          opacity: 0.65;
        }
        .gf-tier-tier3 .gf-previewDecal {
          opacity: 0.75;
        }
        .gf-tier-tier3 .gf-previewImg {
          filter: saturate(1.6) contrast(1.4) hue-rotate(18deg) brightness(1.08);
        }
        .gf-tier-tier3 .gf-previewColorWash {
          opacity: 0.6;
          background: radial-gradient(circle at 30% 20%, rgba(255, 120, 220, 0.35), transparent 55%),
            radial-gradient(circle at 70% 80%, rgba(0, 255, 200, 0.35), transparent 60%);
        }
        .gf-effectHazmat .gf-previewOverlay {
          background: radial-gradient(circle at 40% 20%, rgba(0, 255, 200, 0.7), transparent 60%),
            radial-gradient(circle at 60% 80%, rgba(255, 120, 220, 0.45), transparent 60%);
        }
        .gf-effectHazmat .gf-previewGlow {
          background: radial-gradient(circle at 50% 50%, rgba(255, 220, 120, 0.6), transparent 55%);
          opacity: 0.75;
        }
        .gf-effectHazmat .gf-previewGlitch {
          opacity: 0.35;
          animation-duration: 2.8s;
        }
        .gf-previewEmpty {
          opacity: 0.65;
          font-size: 13px;
          margin: auto;
          text-align: center;
        }
        @keyframes beltMove {
          0% {
            background-position: 0 0, 0 0;
          }
          100% {
            background-position: -640px 0, 0 0;
          }
        }
        @keyframes beltStripe {
          0% {
            transform: translateX(0);
          }
          100% {
            transform: translateX(-120px);
          }
        }
        @keyframes beltTrashMove {
          0% {
            transform: translateX(-60px) rotate(-4deg);
            opacity: 0;
          }
          20% {
            opacity: 0.6;
          }
          80% {
            opacity: 0.6;
          }
          100% {
            transform: translateX(calc(100vw - 140px)) rotate(4deg);
            opacity: 0;
          }
        }
        @keyframes previewPulse {
          0%,
          100% {
            opacity: 0.45;
          }
          50% {
            opacity: 0.75;
          }
        }
        @keyframes previewShift {
          0% {
            background-position: 0% 0%;
          }
          50% {
            background-position: 100% 100%;
          }
          100% {
            background-position: 0% 0%;
          }
        }
        @keyframes effectFade {
          0% {
            opacity: 0;
            transform: translateY(6px);
          }
          20% {
            opacity: 1;
            transform: translateY(0);
          }
          80% {
            opacity: 0.9;
          }
          100% {
            opacity: 0.25;
          }
        }
        @keyframes glitchPulse {
          0%,
          100% {
            opacity: 0;
            transform: translateX(0);
          }
          20% {
            opacity: 0.2;
            transform: translateX(-2px);
          }
          21% {
            opacity: 0;
            transform: translateX(0);
          }
          55% {
            opacity: 0.25;
            transform: translateX(2px);
          }
          56% {
            opacity: 0;
            transform: translateX(0);
          }
        }
        @keyframes chamberPulse {
          0%,
          100% {
            box-shadow: inset 0 0 10px rgba(0, 255, 160, 0.1);
          }
          50% {
            box-shadow: inset 0 0 18px rgba(0, 255, 160, 0.25);
          }
        }
        @media (max-width: 980px) {
          .gf-grid {
            grid-template-columns: 1fr;
          }
          .gf-intro {
            grid-template-columns: 1fr;
          }
          .gf-cardRight {
            position: static;
            top: auto;
          }
          .gf-faqGrid {
            grid-template-columns: 1fr;
          }
          .gf-tierSectionCompact .gf-tierGrid {
            grid-template-columns: 1fr;
          }
          .gf-tierBody {
            grid-template-columns: 1fr;
          }
          .gf-tierPreview {
            width: 100%;
            height: 140px;
          }
          .gf-tierFooter {
            flex-direction: column;
            align-items: flex-start;
          }
          .gf-tierOddsBar {
            width: 100%;
          }
          .gf-supplyRow {
            grid-template-columns: 1fr;
            align-items: flex-start;
          }
          .gf-supplyMeta {
            align-items: flex-start;
          }
          .gf-nftGrid {
            grid-template-columns: repeat(2, minmax(0, 1fr));
            max-height: 320px;
          }
          .gf-previewFrame {
            min-height: 320px;
          }
        }
        @media (max-width: 720px) {
          .gf-introRight {
            width: 100%;
            justify-items: center;
          }
          .gf-header {
            position: static;
            padding: 14px 16px;
            flex-direction: column;
            align-items: flex-start;
          }
          .gf-headerRight {
            width: 100%;
            flex-wrap: wrap;
            justify-content: flex-start;
          }
          .gf-chip {
            font-size: 11px;
            padding: 6px 8px;
          }
          .gf-title {
            font-size: 16px;
          }
          .gf-subtitle {
            font-size: 11px;
          }
          .gf-main {
            padding: 16px;
          }
          .gf-intro {
            padding: 18px;
          }
          .gf-introTitle {
            font-size: 30px;
          }
          .gf-introCopy {
            font-size: 13px;
          }
          .gf-introNote {
            font-size: 11px;
          }
          .gf-introActions {
            flex-direction: column;
            align-items: stretch;
          }
          .gf-introActions .gf-btn {
            width: 100%;
            text-align: center;
          }
          .gf-compactor {
            width: 100%;
            height: 240px;
          }
          .gf-compactorFrame {
            margin: 0 auto;
            transform: scale(0.78);
            transform-origin: top center;
          }
          .gf-hero {
            padding: 14px;
          }
          .gf-h1 {
            font-size: 28px;
          }
          .gf-p {
            font-size: 13px;
          }
          .gf-nftGrid {
            grid-template-columns: 1fr;
            max-height: 280px;
          }
          .gf-previewFrame {
            min-height: 240px;
          }
          .gf-mintBar {
            flex-direction: column;
            align-items: stretch;
          }
          .gf-mintCTA {
            width: 100%;
          }
          .gf-tierSectionCompact .gf-tierCard {
            padding: 12px;
          }
          .gf-tierSectionCompact .gf-tierPreview {
            height: 84px;
          }
          .gf-tierFooter {
            grid-template-columns: 1fr;
            gap: 10px;
          }
          .gf-tierOdds {
            align-items: flex-start;
          }
          .gf-tierSectionCompact .gf-tierOddsBar,
          .gf-tierSectionCompact .gf-tierMeterBar {
            width: 100%;
          }
          .gf-supply,
          .gf-faq,
          .gf-footer {
            margin-left: 16px;
            margin-right: 16px;
          }
          .gf-footer {
            grid-template-columns: 1fr;
            text-align: center;
          }
          .gf-footerLeft,
          .gf-footerRight {
            justify-self: center;
            align-items: center;
          }
          .gf-footerRight {
            justify-items: center;
          }
          .gf-footerCenter {
            order: 2;
          }
          .gf-footerLeft {
            order: 1;
            flex-direction: column;
          }
          .gf-footerRight {
            order: 3;
          }
          .gf-footerText {
            max-width: none;
          }
          .gf-bgGlow {
            width: 560px;
            height: 560px;
          }
          .gf-belt {
            bottom: 12%;
            height: 60px;
          }
          .gf-beltBack {
            bottom: 22%;
            height: 46px;
          }
          .gf-beltTrash {
            bottom: 18%;
            height: 40px;
          }
          .gf-beltTrashBack {
            bottom: 28%;
            height: 30px;
          }
        }
        @media (max-width: 520px) {
          .gf-title {
            font-size: 15px;
          }
          .gf-subtitle {
            font-size: 10px;
          }
          .gf-introTitle {
            font-size: 26px;
          }
          .gf-h1 {
            font-size: 24px;
          }
          .gf-card {
            padding: 12px;
          }
          .gf-tierCompare {
            font-size: 10px;
          }
          .gf-tierName {
            font-size: 14px;
          }
          .gf-tierDesc {
            font-size: 11px;
          }
          .gf-mintStatusValue {
            font-size: 12px;
          }
          .gf-beltTrash,
          .gf-beltTrashBack {
            display: none;
          }
        }
      `}</style>
    </div>
  );
}
