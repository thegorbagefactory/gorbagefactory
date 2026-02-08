"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";

export type Machine = "CONVEYOR" | "COMPACTOR" | "HAZMAT";
export type TierId = "tier1" | "tier2" | "tier3" | "tier4" | "tier5";

type TierEffect = { label: string; on: string[] };

type TierDef = {
  id: TierId;
  name: string;
  meta: string;
  cycleMs: number;
  effects: TierEffect[];
};

const TIERS: TierDef[] = [
  {
    id: "tier1",
    name: "Scrap",
    meta: "ENTRY",
    cycleMs: 1200,
    effects: [
      { label: "Scanlines", on: ["scanlines"] },
      { label: "Soft Glow", on: ["scanlines", "glow"] },
      { label: "Scan Beam", on: ["scanlines", "scanbeam"] },
    ],
  },
  {
    id: "tier2",
    name: "Steel",
    meta: "+",
    cycleMs: 1050,
    effects: [
      { label: "Glow + Beam", on: ["scanlines", "glow", "scanbeam"] },
      { label: "Chromatic Edge", on: ["scanlines", "chromatic"] },
      { label: "Beam + Edge", on: ["scanlines", "scanbeam", "chromatic"] },
    ],
  },
  {
    id: "tier3",
    name: "Chrome",
    meta: "PREMIUM",
    cycleMs: 950,
    effects: [
      { label: "Particles", on: ["scanlines", "particles"] },
      { label: "Glow + Particles", on: ["scanlines", "glow", "particles"] },
      { label: "Edge + Particles", on: ["scanlines", "chromatic", "particles"] },
    ],
  },
  {
    id: "tier4",
    name: "Obsidian",
    meta: "ELITE",
    cycleMs: 850,
    effects: [
      { label: "Holo Shimmer", on: ["scanlines", "holo"] },
      { label: "Holo + Particles", on: ["scanlines", "holo", "particles"] },
      { label: "Holo + Edge", on: ["scanlines", "holo", "chromatic"] },
    ],
  },
  {
    id: "tier5",
    name: "Ascended",
    meta: "TOP",
    cycleMs: 760,
    effects: [
      { label: "Gold Filigree", on: ["scanlines", "filigree", "glow"] },
      { label: "Filigree + Holo", on: ["scanlines", "filigree", "holo", "particles"] },
      { label: "Plasma Overdrive", on: ["scanlines", "plasma", "holo", "filigree"] },
    ],
  },
];

function weightedPick<T>(items: Array<{ item: T; weight: number }>): T {
  const total = items.reduce((sum, x) => sum + x.weight, 0);
  const r = Math.random() * total;
  let acc = 0;
  for (const x of items) {
    acc += x.weight;
    if (r <= acc) return x.item;
  }
  return items[items.length - 1].item;
}

function rollTier(machine: Machine): TierId {
  // machine == odds (tune anytime)
  if (machine === "CONVEYOR") {
    return weightedPick([
      { item: "tier1", weight: 78 },
      { item: "tier2", weight: 17 },
      { item: "tier3", weight: 4 },
      { item: "tier4", weight: 0.9 },
      { item: "tier5", weight: 0.1 },
    ]);
  }
  if (machine === "COMPACTOR") {
    return weightedPick([
      { item: "tier1", weight: 55 },
      { item: "tier2", weight: 28 },
      { item: "tier3", weight: 12 },
      { item: "tier4", weight: 4.5 },
      { item: "tier5", weight: 0.5 },
    ]);
  }
  // HAZMAT
  return weightedPick([
    { item: "tier1", weight: 35 },
    { item: "tier2", weight: 30 },
    { item: "tier3", weight: 20 },
    { item: "tier4", weight: 13 },
    { item: "tier5", weight: 2 },
  ]);
}

export type FactoryTierPreviewProps = {
  selectedImageUrl?: string | null;
  selectedName?: string | null;

  /** Machine drives odds (no manual tier picking) */
  machine: Machine;

  /** Optional: parent-controlled rolled tier */
  rolledTier?: TierId | null;

  /** Called when the component rolls a tier */
  onTierRolled?: (tier: TierId) => void;

  rollButtonLabel?: string;

  /** Optional: parent-controlled handler for Run the Line (e.g. pay + verify) */
  onRunLine?: () => void | Promise<void>;
};

export default function FactoryTierPreview({
  selectedImageUrl,
  selectedName,
  machine,
  rolledTier,
  onTierRolled,
  rollButtonLabel = "Run the Line",
  onRunLine,
}: FactoryTierPreviewProps) {
  const [activeTierId, setActiveTierId] = useState<TierId>("tier1");
  const [isRolling, setIsRolling] = useState(false);

  useEffect(() => {
    if (rolledTier) setActiveTierId(rolledTier);
  }, [rolledTier]);

  const activeTier = useMemo(
    () => TIERS.find((t) => t.id === activeTierId) ?? TIERS[0],
    [activeTierId]
  );

  const [cycleIndex, setCycleIndex] = useState(0);
  const [effectLabel, setEffectLabel] = useState(activeTier.effects[0]?.label ?? "—");
  const intervalRef = useRef<number | null>(null);

  useEffect(() => {
    setCycleIndex(0);
    setEffectLabel(activeTier.effects[0]?.label ?? "—");
    if (intervalRef.current) window.clearInterval(intervalRef.current);

    const tick = () => {
      setCycleIndex((prev) => {
        const next = prev + 1;
        const entry = activeTier.effects[next % activeTier.effects.length];
        setEffectLabel(entry?.label ?? "—");
        return next;
      });
    };

    intervalRef.current = window.setInterval(tick, activeTier.cycleMs);

    return () => {
      if (intervalRef.current) window.clearInterval(intervalRef.current);
      intervalRef.current = null;
    };
  }, [activeTierId, activeTier.cycleMs, activeTier.effects]);

  const activeFxKeys = useMemo(() => {
    const entry = activeTier.effects[cycleIndex % activeTier.effects.length];
    return new Set(entry?.on ?? []);
  }, [activeTier, cycleIndex]);

  const imgSrc =
    selectedImageUrl && selectedImageUrl.trim().length > 0
      ? selectedImageUrl
      : "https://picsum.photos/900?grayscale";

  const nameText = selectedName && selectedName.trim().length > 0 ? selectedName : "No NFT Selected";

  const runRoll = () => {
    if (isRolling) return;
    setIsRolling(true);

    const spinOrder: TierId[] = ["tier1", "tier2", "tier3", "tier4", "tier5"];
    let i = 0;
    const spinMs = 65;
    const spinFor = 900;
    const spins = Math.floor(spinFor / spinMs);

    const id = window.setInterval(() => {
      setActiveTierId(spinOrder[i % spinOrder.length]);
      i++;
      if (i >= spins) {
        window.clearInterval(id);
        const finalTier = rollTier(machine);
        setActiveTierId(finalTier);
        onTierRolled?.(finalTier);
        setIsRolling(false);
      }
    }, spinMs);
  };

  return (
    <div className="gf-card gf-preview">
      <div className="gf-previewTop">
        <div className="gf-title">Factory Screen</div>
        <div className="gf-status">
          <span className="gf-dot" /> LIVE PREVIEW
        </div>
      </div>

      <div className="gf-screen" id="factoryScreen">
        <div className="gf-nftSlot">
          <img className="gf-nftImg" alt="Selected NFT preview" src={imgSrc} />
          <div className="gf-nftLabel">
            <div className="gf-name">{nameText}</div>
            <div className="gf-sub">
              Machine: <b style={{ color: "rgba(255,255,255,.92)" }}>{machine}</b> • Rolled tier:{" "}
              <b style={{ color: "rgba(255,255,255,.92)" }}>{activeTier.name}</b>
            </div>
          </div>
          <div className="gf-effectBadge">
            Effect: <strong>{effectLabel}</strong>
          </div>
        </div>

        <div className={"gf-fx gf-scanlines " + (activeFxKeys.has("scanlines") ? "on" : "")} />
        <div className={"gf-fx gf-glow " + (activeFxKeys.has("glow") ? "on" : "")} />
        <div className={"gf-fx gf-scanbeam " + (activeFxKeys.has("scanbeam") ? "on" : "")} />
        <div className={"gf-fx gf-chromatic " + (activeFxKeys.has("chromatic") ? "on" : "")} />
        <div className={"gf-fx gf-particles " + (activeFxKeys.has("particles") ? "on" : "")} />
        <div className={"gf-fx gf-holo " + (activeFxKeys.has("holo") ? "on" : "")} />
        <div className={"gf-fx gf-filigree " + (activeFxKeys.has("filigree") ? "on" : "")} />
        <div className={"gf-fx gf-plasma " + (activeFxKeys.has("plasma") ? "on" : "")} />
      </div>

      <div style={{ marginTop: 12, display: "flex", gap: 10, alignItems: "center", justifyContent: "space-between" }}>
        <div style={{ fontSize: 12, color: "rgba(255,255,255,.62)", letterSpacing: ".08em", textTransform: "uppercase" }}>
          Tier is random — machine sets odds.
        </div>

        <button
          type="button"
          className="btn btnPrimary"
          onClick={onRunLine ?? runRoll}
          disabled={isRolling}
          style={{ whiteSpace: "nowrap" }}
        >
          {isRolling ? "Rolling…" : rollButtonLabel}
        </button>
      </div>
    </div>
  );
}
