"use client";

export function getBackpackProvider() {
  const p = (window as any)?.backpack?.solana;
  if (!p) throw new Error("Backpack not found. Install/unlock Backpack extension.");
  return p;
}

export async function connectBackpack(): Promise<string> {
  const p = getBackpackProvider();
  const res = await p.connect();
  const pk = res?.publicKey ?? p.publicKey;
  if (!pk) throw new Error("Backpack connected but no publicKey returned.");
  return pk.toString();
}

export async function disconnectBackpack() {
  const p = getBackpackProvider();
  if (p.disconnect) await p.disconnect();
}

export function isBackpackInstalled() {
  return !!(window as any)?.backpack?.solana;
}
