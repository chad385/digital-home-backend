/**
 * POST /api/social/upload — mint a signed upload URL for the social-videos
 * bucket so the browser streams the file straight to Supabase Storage
 * (videos are far bigger than anything we want transiting the worker).
 * Also takes carousel slide images (JPEG strongly preferred — Instagram's
 * ingest only guarantees JPEG).
 * Body: { filename, contentType } → { path, token, publicUrl }
 */
import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { authenticateSessionOrApiKey, unauthorizedResponse } from "@/lib/api/auth";
import { createAdminClient } from "@/lib/supabase/server";

const BUCKET = "social-videos";
const ALLOWED_TYPES = [
  "video/mp4",
  "video/quicktime",
  "video/webm",
  "image/jpeg",
  "image/png",
  "image/webp",
];

export async function POST(request: NextRequest) {
  const auth = await authenticateSessionOrApiKey(request, { allowRoles: ["admin", "social"] });
  if (!auth.authenticated) return unauthorizedResponse(auth.error);

  const body = (await request.json().catch(() => null)) as {
    filename?: string;
    contentType?: string;
  } | null;
  if (!body?.filename) {
    return NextResponse.json({ error: "filename is required" }, { status: 400 });
  }
  if (body.contentType && !ALLOWED_TYPES.includes(body.contentType)) {
    return NextResponse.json(
      { error: "Upload an MP4, MOV, or WebM video — or a JPEG, PNG, or WebP image" },
      { status: 400 }
    );
  }

  const safeName = body.filename.replace(/[^a-zA-Z0-9._-]/g, "_").slice(-80);
  const path = `${randomUUID()}/${safeName}`;

  const supabase = createAdminClient();
  const { data, error } = await supabase.storage.from(BUCKET).createSignedUploadUrl(path);
  if (error || !data) {
    return NextResponse.json(
      { error: error?.message || "Could not create upload URL — is the social-videos bucket created (migration 019)?" },
      { status: 500 }
    );
  }

  const base = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  return NextResponse.json({
    path,
    token: data.token,
    signedUrl: data.signedUrl,
    publicUrl: `${base}/storage/v1/object/public/${BUCKET}/${path}`,
  });
}
