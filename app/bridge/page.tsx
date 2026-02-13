'use client';
import { useEffect, useMemo, useState } from "react";

const BRIDGE_ENABLED = (process.env.NEXT_PUBLIC_BRIDGE_ENABLED || "false").toLowerCase() === "true";
type Machine = "CONVEYOR" | "COMPACTOR" | "HAZMAT";

const MACHINE_OPTIONS: Array<{
  id: Machine;
  pull: string;
  name: string;
  cost: number;
  odds: string;
  intensity: number;
  effects: string[];
}> = [
  {
    id: "CONVEYOR",
    pull: "Common Pull",
    name: "Conveyor Bin",
    cost: 3000,
    odds: "80/18/2",
    intensity: 0.42,
    effects: ["Rust Chrome", "Oil Slick", "Grime Wash", "Smog Streaks"],
  },
  {
    id: "COMPACTOR",
    pull: "Rare Pull",
    name: "Forge Compactor",
    cost: 4250,
    odds: "65/30/5",
    intensity: 0.72,
    effects: ["Toxic Slime Glow", "Dumpster Drip", "Mold Bloom", "Leachate Sheen"],
  },
  {
    id: "HAZMAT",
    pull: "Mythic Pull",
    name: "Hazmat Shrine",
    cost: 5000,
    odds: "45/45/10",
    intensity: 1,
    effects: ["Biohazard Aura", "Nuclear Afterglow", "Gamma Bloom", "Golden Dumpster"],
  },
];

const SAMPLE_SOURCE = [
  { id: "s1", name: "Gorigin #4077", image: "/gorbage-logo.png" },
  { id: "s2", name: "Gorigin #2867", image: "/gorbage-logo.png" },
  { id: "s3", name: "Trashscan OG #14", image: "/gorbage-logo.png" },
];

export default function BridgePage() {
  const [machine, setMachine] = useState<Machine>("CONVEYOR");
  const [selected, setSelected] = useState(SAMPLE_SOURCE[0]);
  const [effectIndex, setEffectIndex] = useState(0);
  const [wallet, setWallet] = useState("");
  const [walletErr, setWalletErr] = useState("");
  const [connecting, setConnecting] = useState(false);

  const machineData = useMemo(
    () => MACHINE_OPTIONS.find((m) => m.id === machine) || MACHINE_OPTIONS[0],
    [machine]
  );
  const effectName = machineData.effects[effectIndex % machineData.effects.length];

  useEffect(() => {
    const id = window.setInterval(() => {
      setEffectIndex((v) => v + 1);
    }, 2800);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => {
    setEffectIndex(0);
  }, [machine]);

  async function onConnectWallet() {
    setWalletErr("");
    if (connecting) return;
    try {
      setConnecting(true);
      const anyWindow = window as any;
      const provider = anyWindow?.backpack?.solana || anyWindow?.solana;
      if (!provider?.connect) throw new Error("Backpack is not available");
      const res = await provider.connect();
      const key = res?.publicKey?.toString?.() || provider?.publicKey?.toString?.() || "";
      if (!key) throw new Error("Wallet connected but no public key returned");
      setWallet(key);
    } catch (err: any) {
      setWalletErr(err?.message || "Wallet connection failed");
    } finally {
      setConnecting(false);
    }
  }

  return (
    <main className="bridge-root">
      <div className="bridge-bg">
        <div className="bridge-glow bridge-glow-a" />
        <div className="bridge-glow bridge-glow-b" />
        <div className="bridge-belt">
          <div className="bridge-belt-treads" />
        </div>
        <div className="bridge-belt bridge-belt-back">
          <div className="bridge-belt-treads" />
        </div>
      </div>

      <section className="bridge-shell">
        <div className="bridge-badge">Trash Bridge</div>
        <h1 className="bridge-title">Turn your Solana NFT into fresh GOR-grade garbage.</h1>
        <p className="bridge-copy">
          Lock it, remix it, and mint a brand-new Trash Bridge output.
        </p>
        <div className="bridge-wallet-row">
          <div className={`bridge-chip ${wallet ? "online" : ""}`}>
            {wallet ? `Wallet: ${wallet.slice(0, 4)}...${wallet.slice(-4)}` : "Wallet Offline"}
          </div>
          <button className="btn btn-wallet" onClick={wallet ? () => setWallet("") : onConnectWallet}>
            {connecting ? "Connecting..." : wallet ? "Disconnect Backpack" : "Connect Backpack"}
          </button>
        </div>
        {walletErr ? <div className="bridge-wallet-err">{walletErr}</div> : null}

        <div className="bridge-grid">
          <article className="bridge-card">
            <div className="bridge-step">1. Connect Sol Wallet</div>
            <p>Connect source wallet and read eligible NFTs.</p>
          </article>
          <article className="bridge-card">
            <div className="bridge-step">2. Lock Source NFT</div>
            <p>Lock original in bridge escrow (not destroyed).</p>
          </article>
          <article className="bridge-card">
            <div className="bridge-step">3. Mint on GOR</div>
            <p>Mint remixed output into dedicated bridge collection.</p>
          </article>
        </div>

        <div className="bridge-rail">
          <div className="bridge-rail-title">Bridge Status</div>
          <div className="bridge-nodes">
            <span className="node active">Idle</span>
            <span className="node">Locking</span>
            <span className="node">Verifying</span>
            <span className="node">Minting</span>
            <span className="node">Complete</span>
          </div>
          <div className="bridge-flag">
            Feature flag:{" "}
            <strong>{BRIDGE_ENABLED ? "Enabled (internal testing)" : "Disabled (coming soon)"}</strong>
          </div>
        </div>

        <div className="bridge-panels bridge-panels-top">
          <div className="panel">
            <div className="panel-title">Pick source NFT (Sol)</div>
            <div className="bridge-nft-grid">
              {SAMPLE_SOURCE.map((item) => (
                <button
                  key={item.id}
                  className={`bridge-nft-tile ${selected.id === item.id ? "active" : ""}`}
                  onClick={() => setSelected(item)}
                >
                  <img src={item.image} alt={item.name} />
                  <span>{item.name}</span>
                </button>
              ))}
            </div>
          </div>
          <div className="panel">
            <div className="panel-title">Factory Screen (GOR output)</div>
            <div className="bridge-preview-meta">
              <span>{machineData.name}</span>
              <span>
                Effect: {effectName} <em>+ 3 traits</em>
              </span>
            </div>
            <div className={`panel-box bridge-preview ${machine.toLowerCase()}`}>
              <img src={selected.image} alt={selected.name} />
              <div className="preview-grime" />
              <div className="preview-vignette" />
              <div className="preview-overlay" />
            </div>
            <div className="bridge-preview-picked">Selected: {selected.name}</div>
          </div>
        </div>

        <section className="bridge-machine">
          <div className="bridge-machine-head">
            <div className="bridge-machine-title">Pick your remix machine</div>
            <div className="bridge-machine-sub">Tap a bay to preview its strongest effects</div>
          </div>
          <div className="bridge-machine-grid">
            {MACHINE_OPTIONS.map((m) => (
              <button
                key={m.id}
                className={`machine-tile ${machine === m.id ? "active" : ""} ${m.id.toLowerCase()}`}
                onClick={() => setMachine(m.id)}
              >
                <div className="machine-pull">{m.pull}</div>
                <div className="machine-name">{m.name}</div>
                <div className="machine-meter">
                  <span>Effect Intensity</span>
                  <div className="meter-track">
                    <div className="meter-fill" style={{ width: `${m.intensity * 100}%` }} />
                  </div>
                </div>
                <div className="machine-bottom">
                  <span>{m.cost} $GOR</span>
                  <span>ODDS {m.odds}</span>
                </div>
              </button>
            ))}
          </div>
        </section>

        <div className="bridge-actions">
          <button className="btn btn-primary" disabled>
            Start Bridge (Soon)
          </button>
          <a className="btn btn-ghost" href="/">
            Back to Remix Engine
          </a>
        </div>
      </section>

      <style jsx>{`
        .bridge-root {
          min-height: 100vh;
          position: relative;
          color: rgba(255, 255, 255, 0.94);
          font-family: 'DM Sans', sans-serif;
          overflow: hidden;
        }
        .bridge-bg {
          position: absolute;
          inset: 0;
          background: radial-gradient(1200px 650px at 15% 10%, rgba(0, 255, 160, 0.12), transparent 65%),
            radial-gradient(900px 520px at 85% 0%, rgba(0, 120, 255, 0.1), transparent 70%), #03090c;
        }
        .bridge-glow {
          position: absolute;
          border-radius: 999px;
          filter: blur(46px);
          opacity: 0.25;
        }
        .bridge-glow-a {
          width: 380px;
          height: 180px;
          left: -80px;
          top: 40px;
          background: rgba(0, 255, 180, 0.28);
        }
        .bridge-glow-b {
          width: 340px;
          height: 160px;
          right: -70px;
          top: 140px;
          background: rgba(0, 180, 255, 0.24);
        }
        .bridge-belt {
          position: absolute;
          left: 0;
          right: 0;
          bottom: 84px;
          height: 38px;
          overflow: hidden;
          border-top: 1px solid rgba(0, 255, 170, 0.15);
          border-bottom: 1px solid rgba(0, 255, 170, 0.15);
          background: linear-gradient(90deg, rgba(8, 14, 17, 0.8), rgba(10, 20, 24, 0.9));
        }
        .bridge-belt-back {
          bottom: 134px;
          height: 26px;
          opacity: 0.75;
        }
        .bridge-belt-treads {
          position: absolute;
          inset: 0;
          background: repeating-linear-gradient(
            90deg,
            rgba(20, 40, 45, 0.6) 0,
            rgba(20, 40, 45, 0.6) 22px,
            rgba(8, 18, 22, 0.65) 22px,
            rgba(8, 18, 22, 0.65) 44px
          );
          animation: beltMove 8s linear infinite;
        }
        .bridge-belt-back .bridge-belt-treads {
          animation-duration: 10s;
        }
        .bridge-shell {
          position: relative;
          z-index: 2;
          width: min(1140px, 94vw);
          margin: 34px auto 170px;
          border: 1px solid rgba(0, 255, 170, 0.18);
          border-radius: 20px;
          background: linear-gradient(180deg, rgba(4, 13, 16, 0.9), rgba(4, 10, 13, 0.88));
          box-shadow: 0 30px 90px rgba(0, 0, 0, 0.5);
          padding: 28px;
        }
        .bridge-badge {
          display: inline-flex;
          border: 1px solid rgba(0, 255, 160, 0.34);
          border-radius: 999px;
          padding: 7px 12px;
          font-size: 12px;
          letter-spacing: 0.06em;
          text-transform: uppercase;
          background: rgba(0, 255, 160, 0.1);
        }
        .bridge-title {
          margin: 14px 0 8px;
          font-size: clamp(30px, 5vw, 48px);
          line-height: 1.05;
        }
        .bridge-copy {
          margin: 0 0 18px;
          max-width: 760px;
          opacity: 0.84;
          font-size: clamp(15px, 2.1vw, 18px);
        }
        .bridge-grid {
          display: grid;
          grid-template-columns: repeat(3, minmax(0, 1fr));
          gap: 12px;
          margin-bottom: 16px;
        }
        .bridge-wallet-row {
          display: flex;
          gap: 10px;
          align-items: center;
          margin-bottom: 16px;
          flex-wrap: wrap;
        }
        .bridge-chip {
          border: 1px solid rgba(255, 255, 255, 0.16);
          border-radius: 999px;
          padding: 10px 12px;
          font-size: 12px;
          background: rgba(255, 255, 255, 0.06);
          color: rgba(255, 255, 255, 0.9);
        }
        .bridge-chip.online {
          border-color: rgba(0, 255, 160, 0.45);
          background: rgba(0, 255, 160, 0.12);
          color: rgba(170, 255, 220, 0.95);
        }
        .bridge-wallet-err {
          margin: -6px 0 12px;
          font-size: 12px;
          color: rgba(255, 130, 130, 0.95);
        }
        .bridge-card {
          border: 1px solid rgba(255, 255, 255, 0.11);
          border-radius: 14px;
          background: rgba(255, 255, 255, 0.03);
          padding: 14px;
        }
        .bridge-card p {
          margin: 0;
          opacity: 0.78;
          font-size: 14px;
        }
        .bridge-step {
          font-size: 14px;
          margin-bottom: 6px;
          font-weight: 700;
        }
        .bridge-rail {
          border: 1px solid rgba(0, 255, 170, 0.2);
          border-radius: 14px;
          padding: 14px;
          background: rgba(0, 255, 170, 0.04);
          margin-bottom: 16px;
        }
        .bridge-rail-title {
          font-weight: 700;
          margin-bottom: 10px;
        }
        .bridge-nodes {
          display: grid;
          grid-template-columns: repeat(5, minmax(0, 1fr));
          gap: 8px;
          margin-bottom: 10px;
        }
        .node {
          border: 1px solid rgba(255, 255, 255, 0.14);
          border-radius: 999px;
          padding: 8px 10px;
          text-align: center;
          font-size: 12px;
          opacity: 0.8;
          background: rgba(255, 255, 255, 0.04);
        }
        .node.active {
          border-color: rgba(0, 255, 160, 0.5);
          background: rgba(0, 255, 160, 0.14);
          color: rgba(220, 255, 240, 0.96);
          opacity: 1;
        }
        .bridge-flag {
          font-size: 13px;
          opacity: 0.85;
        }
        .bridge-panels {
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 12px;
          margin-bottom: 18px;
        }
        .bridge-panels-top {
          align-items: start;
        }
        .panel {
          border: 1px solid rgba(255, 255, 255, 0.12);
          border-radius: 14px;
          background: rgba(255, 255, 255, 0.02);
          padding: 12px;
        }
        .panel-title {
          font-size: 13px;
          text-transform: uppercase;
          letter-spacing: 0.05em;
          opacity: 0.76;
          margin-bottom: 10px;
        }
        .panel-box {
          border-radius: 12px;
          min-height: 180px;
          display: grid;
          place-items: center;
          border: 1px dashed rgba(255, 255, 255, 0.16);
          background: rgba(0, 0, 0, 0.2);
          overflow: hidden;
          position: relative;
        }
        .muted {
          opacity: 0.7;
          font-size: 13px;
        }
        .bridge-nft-grid {
          display: grid;
          grid-template-columns: repeat(3, minmax(0, 1fr));
          gap: 8px;
        }
        .bridge-nft-tile {
          background: rgba(255, 255, 255, 0.03);
          border: 1px solid rgba(255, 255, 255, 0.12);
          border-radius: 10px;
          padding: 8px;
          color: rgba(255, 255, 255, 0.92);
          text-align: left;
          cursor: pointer;
        }
        .bridge-nft-tile.active {
          border-color: rgba(0, 255, 170, 0.5);
          box-shadow: 0 0 0 1px rgba(0, 255, 170, 0.2) inset;
        }
        .bridge-nft-tile img {
          width: 100%;
          aspect-ratio: 1 / 1;
          object-fit: cover;
          border-radius: 8px;
          margin-bottom: 6px;
        }
        .bridge-nft-tile span {
          display: block;
          font-size: 12px;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
          opacity: 0.86;
        }
        .bridge-preview-meta {
          display: flex;
          justify-content: space-between;
          gap: 10px;
          font-size: 12px;
          opacity: 0.86;
          margin-bottom: 8px;
        }
        .bridge-preview-meta em {
          font-style: normal;
          opacity: 0.7;
          margin-left: 6px;
        }
        .bridge-preview img {
          width: 100%;
          height: 100%;
          object-fit: cover;
          image-rendering: pixelated;
          z-index: 1;
          position: relative;
        }
        .preview-grime,
        .preview-vignette,
        .preview-overlay {
          position: absolute;
          inset: 0;
          z-index: 2;
          pointer-events: none;
        }
        .preview-grime {
          background-image: radial-gradient(rgba(20, 20, 20, 0.28) 2px, transparent 2px);
          background-size: 18px 18px;
          mix-blend-mode: multiply;
          opacity: 0.45;
        }
        .preview-vignette {
          background: radial-gradient(circle at center, transparent 45%, rgba(0, 0, 0, 0.45) 100%);
        }
        .bridge-preview.conveyor .preview-overlay {
          background: linear-gradient(155deg, rgba(240, 170, 40, 0.18), rgba(50, 120, 170, 0.12));
          mix-blend-mode: overlay;
        }
        .bridge-preview.compactor .preview-overlay {
          background: linear-gradient(140deg, rgba(20, 255, 190, 0.2), rgba(255, 140, 30, 0.1));
          mix-blend-mode: screen;
        }
        .bridge-preview.hazmat .preview-overlay {
          background: linear-gradient(130deg, rgba(255, 0, 180, 0.18), rgba(80, 255, 110, 0.18), rgba(40, 160, 255, 0.16));
          mix-blend-mode: screen;
          animation: huePulse 2.8s linear infinite;
        }
        .bridge-preview-picked {
          margin-top: 8px;
          font-size: 12px;
          opacity: 0.82;
        }
        .bridge-machine {
          margin-bottom: 18px;
        }
        .bridge-machine-head {
          display: flex;
          justify-content: space-between;
          align-items: baseline;
          margin-bottom: 10px;
          gap: 10px;
        }
        .bridge-machine-title {
          font-size: 18px;
          font-weight: 800;
        }
        .bridge-machine-sub {
          font-size: 12px;
          opacity: 0.72;
        }
        .bridge-machine-grid {
          display: grid;
          grid-template-columns: repeat(3, minmax(0, 1fr));
          gap: 10px;
        }
        .machine-tile {
          border: 1px solid rgba(255, 255, 255, 0.14);
          border-radius: 14px;
          background: rgba(255, 255, 255, 0.03);
          padding: 12px;
          color: rgba(255, 255, 255, 0.94);
          text-align: left;
          cursor: pointer;
        }
        .machine-tile.active {
          border-color: rgba(0, 255, 160, 0.5);
          box-shadow: 0 0 0 1px rgba(0, 255, 160, 0.24) inset, 0 10px 26px rgba(0, 0, 0, 0.3);
        }
        .machine-tile.conveyor {
          border-left: 4px solid rgba(255, 200, 80, 0.8);
          background: linear-gradient(160deg, rgba(26, 18, 10, 0.45), rgba(8, 10, 8, 0.92));
        }
        .machine-tile.compactor {
          border-left: 4px solid rgba(120, 255, 200, 0.82);
          background: linear-gradient(160deg, rgba(10, 24, 20, 0.52), rgba(8, 10, 8, 0.92));
        }
        .machine-tile.hazmat {
          border-left: 4px solid rgba(255, 255, 255, 0.35);
          background: linear-gradient(160deg, rgba(18, 18, 10, 0.55), rgba(8, 10, 8, 0.94));
        }
        .machine-pull {
          font-size: 11px;
          letter-spacing: 0.06em;
          text-transform: uppercase;
          opacity: 0.72;
          margin-bottom: 6px;
        }
        .machine-tile.hazmat .machine-pull {
          background: linear-gradient(
            90deg,
            #ff5f6d 0%,
            #ffc371 16%,
            #d4ff6b 32%,
            #6bffb8 48%,
            #5ecbff 64%,
            #8b7bff 80%,
            #ff6bcb 100%
          );
          -webkit-background-clip: text;
          background-clip: text;
          color: transparent;
          animation: rainbowSlide 3.2s linear infinite;
          background-size: 200% 100%;
          opacity: 1;
        }
        .machine-name {
          font-size: 18px;
          font-weight: 800;
          margin-bottom: 10px;
        }
        .machine-tile.hazmat .machine-name {
          background: linear-gradient(
            90deg,
            #ff5f6d 0%,
            #ffc371 16%,
            #d4ff6b 32%,
            #6bffb8 48%,
            #5ecbff 64%,
            #8b7bff 80%,
            #ff6bcb 100%
          );
          -webkit-background-clip: text;
          background-clip: text;
          color: transparent;
          background-size: 200% 100%;
          animation: rainbowSlide 3.2s linear infinite;
        }
        .machine-meter {
          font-size: 12px;
          opacity: 0.86;
          margin-bottom: 10px;
        }
        .meter-track {
          height: 8px;
          border-radius: 999px;
          background: rgba(255, 255, 255, 0.1);
          margin-top: 5px;
          overflow: hidden;
        }
        .meter-fill {
          height: 100%;
          border-radius: 999px;
          background: linear-gradient(90deg, rgba(0, 255, 170, 0.8), rgba(90, 255, 200, 0.8));
        }
        .machine-tile.conveyor .meter-fill {
          background: linear-gradient(90deg, rgba(255, 200, 80, 0.95), rgba(255, 120, 80, 0.78));
        }
        .machine-tile.compactor .meter-fill {
          background: linear-gradient(90deg, rgba(120, 255, 200, 0.95), rgba(60, 180, 140, 0.78));
        }
        .machine-tile.hazmat .meter-fill {
          background: linear-gradient(
            90deg,
            #ff5f6d 0%,
            #ffc371 16%,
            #d4ff6b 32%,
            #6bffb8 48%,
            #5ecbff 64%,
            #8b7bff 80%,
            #ff6bcb 100%
          );
          background-size: 200% 100%;
          animation: rainbowSlide 3.2s linear infinite;
        }
        .machine-bottom {
          display: flex;
          justify-content: space-between;
          gap: 8px;
          font-size: 12px;
          opacity: 0.85;
        }
        .machine-tile.conveyor.active {
          border-color: rgba(255, 210, 120, 0.4);
          box-shadow: 0 0 0 1px rgba(255, 200, 80, 0.2) inset, 0 10px 26px rgba(0, 0, 0, 0.35);
        }
        .machine-tile.compactor.active {
          border-color: rgba(120, 255, 200, 0.4);
          box-shadow: 0 0 0 1px rgba(120, 255, 200, 0.22) inset, 0 10px 26px rgba(0, 0, 0, 0.35);
        }
        .machine-tile.hazmat.active {
          border-color: rgba(255, 255, 255, 0.42);
          box-shadow: 0 0 0 1px rgba(210, 110, 255, 0.25) inset, 0 0 24px rgba(170, 120, 255, 0.35);
          animation: mythicGlow 5s linear infinite;
        }
        .bridge-actions {
          display: flex;
          gap: 10px;
          flex-wrap: wrap;
        }
        .btn {
          border-radius: 999px;
          padding: 10px 14px;
          border: 1px solid rgba(255, 255, 255, 0.15);
          color: rgba(255, 255, 255, 0.93);
          text-decoration: none;
          font-weight: 700;
          font-size: 13px;
        }
        .btn-primary {
          background: linear-gradient(135deg, rgba(0, 255, 160, 0.18), rgba(0, 80, 60, 0.36));
          border-color: rgba(0, 255, 170, 0.42);
        }
        .btn-wallet {
          background: radial-gradient(circle at 20% 0%, rgba(0, 255, 180, 0.24), rgba(0, 0, 0, 0.12)),
            linear-gradient(140deg, rgba(0, 40, 30, 0.8), rgba(0, 16, 12, 0.9));
          border-color: rgba(0, 255, 170, 0.55);
          box-shadow: 0 0 18px rgba(0, 255, 140, 0.2);
        }
        .btn-primary:disabled {
          opacity: 0.65;
          cursor: not-allowed;
        }
        .btn-ghost {
          background: rgba(255, 255, 255, 0.06);
        }
        @keyframes beltMove {
          from {
            transform: translate3d(0, 0, 0);
          }
          to {
            transform: translate3d(-220px, 0, 0);
          }
        }
        @keyframes huePulse {
          from {
            filter: hue-rotate(0deg);
          }
          to {
            filter: hue-rotate(360deg);
          }
        }
        @keyframes rainbowSlide {
          from {
            background-position: 0% 50%;
          }
          to {
            background-position: 200% 50%;
          }
        }
        @keyframes mythicGlow {
          0%,
          100% {
            filter: hue-rotate(0deg);
          }
          50% {
            filter: hue-rotate(60deg);
          }
        }
        @media (max-width: 900px) {
          .bridge-grid {
            grid-template-columns: 1fr;
          }
          .bridge-panels {
            grid-template-columns: 1fr;
          }
          .bridge-nodes {
            grid-template-columns: 1fr 1fr;
          }
          .bridge-nft-grid {
            grid-template-columns: 1fr 1fr;
          }
          .bridge-machine-grid {
            grid-template-columns: 1fr;
          }
          .bridge-machine-head {
            flex-direction: column;
            align-items: flex-start;
          }
          .bridge-wallet-row {
            flex-direction: column;
            align-items: stretch;
          }
          .bridge-preview-meta {
            flex-direction: column;
            gap: 4px;
          }
        }
      `}</style>
    </main>
  );
}
