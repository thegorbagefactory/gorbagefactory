import { NextResponse } from "next/server";

type RateEntry = { count: number; resetAt: number };
const buckets = new Map<string, RateEntry>();

export function getClientIp(req: Request) {
  const forwarded = req.headers.get("x-forwarded-for") || "";
  const realIp = req.headers.get("x-real-ip") || "";
  const cfIp = req.headers.get("cf-connecting-ip") || "";
  const ip = (forwarded.split(",")[0] || realIp || cfIp || "").trim();
  return ip || "unknown";
}

export function rateLimit(req: Request, key: string, max: number, windowMs: number) {
  const ip = getClientIp(req);
  const now = Date.now();
  const bucketKey = `${key}:${ip}`;
  const entry = buckets.get(bucketKey);
  if (!entry || now > entry.resetAt) {
    buckets.set(bucketKey, { count: 1, resetAt: now + windowMs });
    return true;
  }
  if (entry.count >= max) return false;
  entry.count += 1;
  return true;
}

export function rateLimitResponse() {
  return NextResponse.json({ error: "Too many requests. Please slow down." }, { status: 429 });
}
