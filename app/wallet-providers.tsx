"use client";

import React, { useMemo } from "react";
import { ConnectionProvider, WalletProvider } from "@solana/wallet-adapter-react";
import { WalletModalProvider } from "@solana/wallet-adapter-react-ui";
import { BaseMessageSignerWalletAdapter, WalletReadyState, WalletName } from "@solana/wallet-adapter-base";
import { PublicKey, Connection, Transaction, VersionedTransaction } from "@solana/web3.js";

import "@solana/wallet-adapter-react-ui/styles.css";

declare global {
  interface Window {
    backpack?: any;
    solana?: any;
  }
}

class BackpackAdapter extends BaseMessageSignerWalletAdapter {
  name: WalletName<string> = "Backpack" as WalletName<string>;
  url = "https://backpack.app/";
  icon =
    "data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMzIiIGhlaWdodD0iMzIiIHZpZXdCb3g9IjAgMCAzMiAzMiIgZmlsbD0ibm9uZSIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj48cmVjdCB3aWR0aD0iMzIiIGhlaWdodD0iMzIiIHJ4PSI4IiBmaWxsPSIjMTAxNDI1Ii8+PHBhdGggZD0iTTEwIDE2YzAtMy4zMTQgMi42ODYtNiA2LTZzNiAyLjY4NiA2IDYtMi42ODYgNi02IDYtNi0yLjY4Ni02LTZaIiBmaWxsPSIjNEY4M0Y1Ii8+PC9zdmc+";

  supportedTransactionVersions = undefined;

  private _provider: any = null;
  private _pk: PublicKey | null = null;
  private _readyState: WalletReadyState = WalletReadyState.NotDetected;
  private _connecting = false;

  constructor() {
    super();
    if (typeof window !== "undefined") {
      this._updateReadyState();
      window.addEventListener("load", this._updateReadyState);
      // Backpack doesn't document a custom init event; re-check shortly after load.
      setTimeout(this._updateReadyState, 0);
    }
  }

  get readyState() {
    return this._readyState;
  }

  get publicKey() {
    return this._pk;
  }

  get connecting() {
    return this._connecting;
  }

  async connect() {
    try {
      this._connecting = true;
      this._provider = this._getProvider();
      if (!this._provider) throw new Error("Backpack not found. Install + unlock Backpack extension.");

      const res = await this._provider.connect();
      const pk = res?.publicKey ?? this._provider.publicKey;
      if (!pk) throw new Error("Backpack connected but no publicKey was returned.");

      this._pk = new PublicKey(pk.toString());
      this.emit("connect", this._pk);
    } catch (e: any) {
      console.error("[BackpackAdapter.connect] error:", e);
      this.emit("error", e);
      throw e;
    } finally {
      this._connecting = false;
    }
  }

  async disconnect() {
    try {
      const p = this._getProvider();
      if (p?.disconnect) await p.disconnect();
    } finally {
      this._provider = null;
      this._pk = null;
      this._connecting = false;
      this.emit("disconnect");
    }
  }

  async signTransaction<T extends Transaction | VersionedTransaction>(transaction: T): Promise<T> {
    const p = this._getProvider();
    if (!p?.signTransaction) throw new Error("Backpack provider missing signTransaction");
    return await p.signTransaction(transaction);
  }

  async signAllTransactions<T extends Transaction | VersionedTransaction>(transactions: T[]): Promise<T[]> {
    const p = this._getProvider();
    if (!p?.signAllTransactions) throw new Error("Backpack provider missing signAllTransactions");
    return await p.signAllTransactions(transactions);
  }

  async signMessage(message: Uint8Array): Promise<Uint8Array> {
    const p = this._getProvider();
    if (!p?.signMessage) throw new Error("Backpack provider missing signMessage");
    const res = await p.signMessage(message);
    return res?.signature ?? res;
  }

  async sendTransaction(
    transaction: Transaction | VersionedTransaction,
    connection: Connection,
    options?: any
  ): Promise<string> {
    const p = this._getProvider();
    if (p?.signAndSendTransaction) {
      const res = await p.signAndSendTransaction(transaction, options);
      return res?.signature ?? res;
    }
    const signed = await this.signTransaction(transaction);
    return await connection.sendRawTransaction(signed.serialize(), options);
  }

  private _updateReadyState = () => {
    const next = this._getProvider() ? WalletReadyState.Installed : WalletReadyState.NotDetected;
    if (next !== this._readyState) {
      this._readyState = next;
      this.emit("readyStateChange", this._readyState);
    }
  };

  private _getProvider() {
    if (window?.backpack?.solana) return window.backpack.solana;

    const providers = window?.solana?.providers;
    if (Array.isArray(providers)) {
      const found = providers.find((p: any) => p?.isBackpack);
      if (found) return found;
    }
    if (window?.solana?.isBackpack) return window.solana;

    return null;
  }
}

export default function WalletProviders({ children }: { children: React.ReactNode }) {
  const rpc = process.env.NEXT_PUBLIC_GORBAGANA_RPC_URL || "https://rpc.gorbagana.wtf/";

  const wallets = useMemo(() => [new BackpackAdapter()], []);

  return (
    <ConnectionProvider endpoint={rpc}>
      <WalletProvider wallets={wallets} autoConnect={false}>
        <WalletModalProvider>{children}</WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
}
