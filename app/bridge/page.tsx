const BRIDGE_ENABLED =
  (process.env.BRIDGE_ENABLED || process.env.NEXT_PUBLIC_BRIDGE_ENABLED || "false").toLowerCase() === "true";

export default function BridgePage() {
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
        <h1 className="bridge-title">Bridge Sol NFTs to GOR with a Remix</h1>
        <p className="bridge-copy">
          Phase A will lock a Sol NFT, run the same remix engine, and mint a fresh GOR output in the bridge collection.
        </p>

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

        <div className="bridge-panels">
          <div className="panel">
            <div className="panel-title">Source NFT (Sol)</div>
            <div className="panel-box muted">Selection UI next</div>
          </div>
          <div className="panel">
            <div className="panel-title">Remixed Output (GOR)</div>
            <div className="panel-box muted">Preview UI next</div>
          </div>
        </div>

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
        }
        .muted {
          opacity: 0.7;
          font-size: 13px;
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
        }
      `}</style>
    </main>
  );
}
