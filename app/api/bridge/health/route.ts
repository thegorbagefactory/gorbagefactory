import { NextResponse } from "next/server";

export const runtime = "nodejs";

export async function GET() {
  const enabled =
    (process.env.BRIDGE_ENABLED || process.env.NEXT_PUBLIC_BRIDGE_ENABLED || "false").toLowerCase() === "true";

  return NextResponse.json(
    {
      ok: true,
      feature: "bridge",
      enabled,
      phase: "A",
      mode: "scaffold",
    },
    { status: 200 }
  );
}
