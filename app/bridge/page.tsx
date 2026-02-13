const BRIDGE_ENABLED =
  (process.env.BRIDGE_ENABLED || process.env.NEXT_PUBLIC_BRIDGE_ENABLED || "false").toLowerCase() === "true";

export default function BridgePage() {
  return (
    <main style={styles.root}>
      <section style={styles.card}>
        <div style={styles.badge}>Trash Bridge</div>
        <h1 style={styles.title}>Solana to GOR Bridge</h1>
        <p style={styles.copy}>
          Phase A is being built behind a feature flag so live remix flow on the home page stays stable.
        </p>
        <div style={styles.row}>
          <span style={styles.label}>Status</span>
          <span style={BRIDGE_ENABLED ? styles.statusOn : styles.statusOff}>
            {BRIDGE_ENABLED ? "Enabled (internal testing)" : "Coming soon"}
          </span>
        </div>
        <div style={styles.row}>
          <span style={styles.label}>Path</span>
          <span style={styles.value}>/api/bridge/health</span>
        </div>
        <a href="/" style={styles.link}>
          Back to Remix Engine
        </a>
      </section>
    </main>
  );
}

const styles: Record<string, CSSProperties> = {
  root: {
    minHeight: "100vh",
    display: "grid",
    placeItems: "center",
    padding: "24px",
    background:
      "radial-gradient(1200px 700px at 10% 10%, rgba(0,180,120,0.18), transparent), #04090b",
    color: "rgba(255,255,255,0.92)",
    fontFamily: "DM Sans, sans-serif",
  },
  card: {
    width: "min(760px, 100%)",
    borderRadius: "18px",
    border: "1px solid rgba(0, 255, 160, 0.22)",
    background: "rgba(2, 14, 10, 0.8)",
    boxShadow: "0 20px 60px rgba(0,0,0,0.4)",
    padding: "24px",
  },
  badge: {
    display: "inline-block",
    borderRadius: "999px",
    border: "1px solid rgba(0,255,160,0.35)",
    background: "rgba(0,255,160,0.1)",
    padding: "6px 10px",
    fontSize: "12px",
    marginBottom: "12px",
  },
  title: {
    margin: "0 0 10px 0",
    fontSize: "34px",
    lineHeight: 1.1,
  },
  copy: {
    margin: "0 0 18px 0",
    opacity: 0.86,
    fontSize: "16px",
  },
  row: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    borderTop: "1px solid rgba(255,255,255,0.08)",
    padding: "12px 0",
    gap: "16px",
  },
  label: {
    opacity: 0.78,
    fontSize: "13px",
    textTransform: "uppercase",
    letterSpacing: "0.05em",
  },
  value: {
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
    fontSize: "13px",
  },
  statusOn: {
    color: "rgba(0,255,160,0.95)",
    fontWeight: 700,
  },
  statusOff: {
    color: "rgba(255,220,120,0.95)",
    fontWeight: 700,
  },
  link: {
    display: "inline-block",
    marginTop: "16px",
    color: "rgba(0,255,160,0.95)",
    textDecoration: "none",
    border: "1px solid rgba(0,255,160,0.3)",
    borderRadius: "999px",
    padding: "8px 12px",
  },
};
import type { CSSProperties } from "react";
