import "./globals.css";
import type { Metadata } from "next";
import WalletProviders from "./wallet-providers";

export const metadata: Metadata = {
  title: "GorbageFactory",
  description: "Refurbished Trash — pay in GOR, remix your NFT with clean effects.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <WalletProviders>
          {children}
        </WalletProviders>
      </body>
    </html>
  );
}
