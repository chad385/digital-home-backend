'use client';

/**
 * Social studio — the short-form distribution calendar. Schedule a vertical
 * video or a multi-slide carousel once, pick platforms, and the engine
 * publishes it: videos to Instagram Reels, Facebook Reels, and YouTube
 * Shorts; carousels to Instagram and Facebook (YouTube has no analogue).
 *
 * Two views over the same posts: the month calendar, and a GHL-style list
 * with search, status, and date-range filters. The choice sticks per browser.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  api,
  EmptyState,
  Field,
  fmtDate,
  GhostBtn,
  Loading,
  Modal,
  PageHeader,
  PrimaryBtn,
  Select,
  StatusDot,
  TextArea,
  TextInput,
  useToast,
} from '@/components/crm/kit';
import {
  type AccountRow,
  type MediaRow,
  type PostRow,
  fmtCount,
  PLATFORM_META,
  PlatformBadge,
  POST_STATUS_DOTS,
  postMetric,
  PostTypeBadge,
  SocialNav,
  TARGET_STATUS_DOTS,
} from './social-kit';

const CAPTION_LIMIT = 2200;
const MAX_SLIDES = 10;

// ── date helpers (calendar is Monday-first) ──────────────────────────────────

function startOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}
function dayKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
    d.getDate()
  ).padStart(2, '0')}`;
}
function monthGrid(cursor: Date): Date[] {
  const first = startOfMonth(cursor);
  const start = new Date(first);
  start.setDate(first.getDate() - ((first.getDay() + 6) % 7)); // back to Monday
  return Array.from({ length: 42 }, (_, i) => {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    return d;
  });
}
function toLocalInput(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(
    d.getHours()
  )}:${pad(d.getMinutes())}`;
}
/** The date a post lives under — scheduled first, then published, then created. */
function postDate(p: PostRow): string {
  return p.scheduled_at || p.published_at || p.created_at;
}

// ── uploads (direct browser → storage, with progress) ────────────────────────

async function uploadToStorage(
  file: File,
  onProgress: (pct: number) => void
): Promise<{ path: string; publicUrl: string }> {
  const { signedUrl, path, publicUrl } = await api<{
    signedUrl: string;
    path: string;
    publicUrl: string;
  }>('/api/social/upload', {
    method: 'POST',
    body: JSON.stringify({ filename: file.name, contentType: file.type }),
  });
  await new Promise<void>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', signedUrl);
    xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream');
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100));
    };
    xhr.onload = () =>
      xhr.status >= 200 && xhr.status < 300
        ? resolve()
        : reject(new Error(`Upload failed (${xhr.status})`));
    xhr.onerror = () => reject(new Error('Upload failed — network error'));
    xhr.send(file);
  });
  return { path, publicUrl };
}

function useVideoUpload(show: (t: string, k?: 'ok' | 'err') => void) {
  const [progress, setProgress] = useState<number | null>(null);
  const [video, setVideo] = useState<{ path: string; publicUrl: string } | null>(null);

  const upload = useCallback(
    async (file: File) => {
      setProgress(0);
      try {
        setVideo(await uploadToStorage(file, setProgress));
        setProgress(null);
      } catch (e) {
        setProgress(null);
        show(e instanceof Error ? e.message : 'Upload failed', 'err');
      }
    },
    [show]
  );

  return { progress, video, setVideo, upload };
}

// ── composer ─────────────────────────────────────────────────────────────────

type Slide = { path: string | null; url: string };

function Composer({
  accounts,
  editing,
  prefillDate,
  onClose,
  onSaved,
  show,
}: {
  accounts: AccountRow[];
  editing: PostRow | null;
  prefillDate: string | null; // yyyy-mm-dd
  onClose: () => void;
  onSaved: () => void;
  show: (t: string, k?: 'ok' | 'err') => void;
}) {
  // Post type is chosen at creation and fixed once the post exists.
  const [postType, setPostType] = useState<'video' | 'carousel'>(editing?.post_type || 'video');
  const [title, setTitle] = useState(editing?.title || '');
  const [caption, setCaption] = useState(editing?.caption || '');
  const [when, setWhen] = useState(
    editing?.scheduled_at
      ? toLocalInput(editing.scheduled_at)
      : prefillDate
        ? `${prefillDate}T09:00`
        : ''
  );
  const [selected, setSelected] = useState<Set<string>>(
    new Set(editing?.targets.map((t) => t.account_id) || accounts.filter((a) => a.status === 'active').map((a) => a.id))
  );
  const [busy, setBusy] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const slideInput = useRef<HTMLInputElement>(null);
  const { progress, video, setVideo, upload } = useVideoUpload(show);

  const [slides, setSlides] = useState<Slide[]>(
    (editing?.media || []).map((m: MediaRow) => ({ path: m.path, url: m.url }))
  );
  const [slideStatus, setSlideStatus] = useState<string | null>(null);

  useEffect(() => {
    if (editing?.video_url && editing.video_path) {
      setVideo({ path: editing.video_path, publicUrl: editing.video_url });
    }
  }, [editing, setVideo]);

  const active = accounts.filter((a) => a.status === 'active');
  const carousel = postType === 'carousel';

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const switchType = (type: 'video' | 'carousel') => {
    if (editing) return;
    setPostType(type);
    if (type === 'carousel') {
      // YouTube can't take a carousel — drop it from the selection.
      setSelected((prev) => {
        const next = new Set(prev);
        for (const a of accounts) if (a.platform === 'youtube') next.delete(a.id);
        return next;
      });
    }
  };

  const addSlides = async (files: FileList) => {
    const room = MAX_SLIDES - slides.length;
    const list = Array.from(files).slice(0, room);
    if (files.length > room) show(`Carousels cap at ${MAX_SLIDES} slides`, 'err');
    for (let i = 0; i < list.length; i++) {
      setSlideStatus(`Uploading ${i + 1}/${list.length}…`);
      try {
        const { path, publicUrl } = await uploadToStorage(list[i], () => {});
        setSlides((prev) => [...prev, { path, url: publicUrl }]);
      } catch (e) {
        show(e instanceof Error ? e.message : 'Upload failed', 'err');
        break;
      }
    }
    setSlideStatus(null);
    if (slideInput.current) slideInput.current.value = '';
  };

  const moveSlide = (i: number, dir: -1 | 1) => {
    setSlides((prev) => {
      const j = i + dir;
      if (j < 0 || j >= prev.length) return prev;
      const next = [...prev];
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });
  };

  const [publishing, setPublishing] = useState(false);

  const save = async (mode: 'draft' | 'scheduled' | 'now') => {
    if (mode !== 'draft') {
      if (carousel && slides.length < 1) return show('Add at least 1 photo', 'err');
      if (!carousel && !video) return show('Upload a video first', 'err');
      if (mode === 'scheduled' && !when) return show('Pick a date and time', 'err');
      if (selected.size === 0) return show('Pick at least one platform', 'err');
    }
    setBusy(true);
    if (mode === 'now') setPublishing(true);
    try {
      const payload = {
        title: title || undefined,
        caption,
        post_type: postType,
        video_path: carousel ? undefined : video?.path,
        video_url: carousel ? undefined : video?.publicUrl,
        media: carousel
          ? slides.map((s) => ({ url: s.url, path: s.path, kind: 'image' as const }))
          : undefined,
        scheduled_at:
          mode === 'now'
            ? new Date().toISOString()
            : when
              ? new Date(when).toISOString()
              : null,
        account_ids: Array.from(selected),
        status: mode === 'draft' ? ('draft' as const) : ('scheduled' as const),
      };
      let postId = editing?.id;
      if (editing) {
        await api(`/api/social/posts/${editing.id}`, {
          method: 'PATCH',
          body: JSON.stringify(payload),
        });
      } else {
        const { post } = await api<{ post: { id: string } }>('/api/social/posts', {
          method: 'POST',
          body: JSON.stringify(payload),
        });
        postId = post.id;
      }

      if (mode === 'now' && postId) {
        // Same engine run as the detail modal's "Publish now" — inline, so
        // Instagram usually finishes within this call.
        const res = await api<{ targetsPublished: number; targetsProcessing: number }>(
          `/api/social/posts/${postId}/publish`,
          { method: 'POST', body: '{}' }
        );
        show(
          res.targetsProcessing > 0
            ? `Publishing — ${res.targetsPublished} live, ${res.targetsProcessing} still processing (finishes on the next engine run)`
            : `Published ✓ (${res.targetsPublished} platform${res.targetsPublished === 1 ? '' : 's'})`
        );
      } else {
        show(mode === 'scheduled' ? 'Scheduled ✓' : 'Draft saved');
      }
      onSaved();
      onClose();
    } catch (e) {
      show(e instanceof Error ? e.message : 'Save failed', 'err');
    } finally {
      setBusy(false);
      setPublishing(false);
    }
  };

  return (
    <Modal title={editing ? 'Edit post' : 'New post'} onClose={onClose} wide>
      <div className="grid grid-cols-[220px_1fr] gap-6">
        {/* media slot */}
        <div className="flex flex-col gap-3">
          {!editing && (
            <div className="grid grid-cols-2 rounded-lg border border-minimal-border overflow-hidden">
              {(['video', 'carousel'] as const).map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => switchType(t)}
                  className={`px-2 py-1.5 text-[12px] font-medium transition-colors ${
                    postType === t
                      ? 'bg-minimal-row text-white'
                      : 'text-minimal-muted hover:text-white'
                  }`}
                >
                  {t === 'video' ? 'Reel' : 'Photos'}
                </button>
              ))}
            </div>
          )}
          {editing && <PostTypeBadge type={postType} slides={slides.length} />}

          {!carousel ? (
            <>
              <input
                ref={fileInput}
                type="file"
                accept="video/mp4,video/quicktime,video/webm"
                className="hidden"
                onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])}
              />
              <button
                type="button"
                onClick={() => fileInput.current?.click()}
                className="w-full aspect-[9/16] border border-dashed border-minimal-border rounded-xl overflow-hidden relative hover:border-zinc-500 transition-colors bg-minimal-row"
              >
                {video ? (
                  <video
                    src={video.publicUrl}
                    className="absolute inset-0 w-full h-full object-cover"
                    muted
                    playsInline
                  />
                ) : (
                  <span className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-minimal-muted text-[12px] px-4">
                    {progress !== null ? (
                      <>
                        <span className="font-semibold text-white">{progress}%</span>
                        <span className="w-24 h-1 rounded bg-minimal-border overflow-hidden">
                          <span
                            className="block h-full bg-white transition-[width]"
                            style={{ width: `${progress}%` }}
                          />
                        </span>
                      </>
                    ) : (
                      <>
                        <span className="text-lg">⬆</span>
                        Upload video
                        <span className="text-zinc-600">MP4 · 9:16 vertical</span>
                      </>
                    )}
                  </span>
                )}
              </button>
              {video && progress === null && (
                <button
                  type="button"
                  onClick={() => fileInput.current?.click()}
                  className="w-full text-[12px] text-minimal-muted hover:text-white transition-colors"
                >
                  Replace video
                </button>
              )}
            </>
          ) : (
            <>
              <input
                ref={slideInput}
                type="file"
                accept="image/jpeg,image/png,image/webp"
                multiple
                className="hidden"
                onChange={(e) => e.target.files?.length && addSlides(e.target.files)}
              />
              <div className="flex flex-col gap-2">
                {slides.map((s, i) => (
                  <div
                    key={`${s.url}-${i}`}
                    className="flex items-center gap-2 border border-minimal-border rounded-lg p-1.5"
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={s.url}
                      alt={`Slide ${i + 1}`}
                      className="w-10 h-12 object-cover rounded shrink-0"
                    />
                    <span className="text-[11px] text-zinc-500 flex-1">Slide {i + 1}</span>
                    <button
                      type="button"
                      onClick={() => moveSlide(i, -1)}
                      disabled={i === 0}
                      className="text-zinc-500 hover:text-white disabled:opacity-30 px-1"
                      title="Move up"
                    >
                      ↑
                    </button>
                    <button
                      type="button"
                      onClick={() => moveSlide(i, 1)}
                      disabled={i === slides.length - 1}
                      className="text-zinc-500 hover:text-white disabled:opacity-30 px-1"
                      title="Move down"
                    >
                      ↓
                    </button>
                    <button
                      type="button"
                      onClick={() => setSlides((prev) => prev.filter((_, j) => j !== i))}
                      className="text-zinc-500 hover:text-red-400 px-1"
                      title="Remove slide"
                    >
                      ✕
                    </button>
                  </div>
                ))}
                {slides.length < MAX_SLIDES && (
                  <button
                    type="button"
                    onClick={() => slideInput.current?.click()}
                    disabled={slideStatus !== null}
                    className="w-full py-4 border border-dashed border-minimal-border rounded-xl text-[12px] text-minimal-muted hover:border-zinc-500 hover:text-white transition-colors"
                  >
                    {slideStatus ?? `+ Add slides · ${slides.length}/${MAX_SLIDES}`}
                  </button>
                )}
                <span className="text-[11px] text-zinc-600">
                  JPG recommended — Instagram only guarantees JPEG ingest. 1 slide posts a
                  single photo; 2–10 become a carousel, ordered top to bottom.
                </span>
              </div>
            </>
          )}
        </div>

        {/* fields */}
        <div className="flex flex-col gap-4">
          <Field label="Title" hint={carousel ? 'Internal label' : 'Internal label — also used as the YouTube title (100 chars)'}>
            <TextInput
              value={title}
              maxLength={100}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="e.g. 3 hooks that doubled our reach"
            />
          </Field>
          <Field label={`Caption · ${caption.length}/${CAPTION_LIMIT}`}>
            <TextArea
              value={caption}
              rows={6}
              maxLength={CAPTION_LIMIT}
              onChange={(e) => setCaption(e.target.value)}
              placeholder={
                carousel
                  ? 'The caption that goes out with the carousel…\n\n#hashtags welcome'
                  : 'The caption that goes out with the video…\n\n#hashtags welcome'
              }
            />
          </Field>
          <Field label="Platforms">
            {active.length === 0 ? (
              <p className="text-[13px] text-zinc-500">
                No accounts connected yet — head to the Accounts tab first.
              </p>
            ) : (
              <div className="flex flex-col gap-2">
                {active.map((a) => {
                  const unavailable = carousel && a.platform === 'youtube';
                  return (
                    <label
                      key={a.id}
                      className={`flex items-center gap-3 px-3 py-2 border rounded-lg transition-colors ${
                        unavailable
                          ? 'border-minimal-border opacity-40 cursor-not-allowed'
                          : selected.has(a.id)
                            ? 'border-zinc-500 bg-minimal-row cursor-pointer'
                            : 'border-minimal-border hover:border-zinc-600 cursor-pointer'
                      }`}
                    >
                      <input
                        type="checkbox"
                        checked={!unavailable && selected.has(a.id)}
                        disabled={unavailable}
                        onChange={() => toggle(a.id)}
                        className="accent-white"
                      />
                      <PlatformBadge platform={a.platform} />
                      <span className="text-[13px] text-zinc-300 flex-1 truncate">
                        {a.username ? `@${a.username}` : a.name}
                      </span>
                      <span className="text-[11px] text-zinc-600">
                        {unavailable ? 'No carousel format' : PLATFORM_META[a.platform].hint}
                      </span>
                    </label>
                  );
                })}
              </div>
            )}
          </Field>
          <Field label="Schedule for">
            <TextInput type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} />
          </Field>
          <div className="flex items-center justify-end gap-3 pt-2">
            <GhostBtn onClick={() => save('draft')} disabled={busy || progress !== null || slideStatus !== null}>
              Save draft
            </GhostBtn>
            <GhostBtn onClick={() => save('now')} disabled={busy || progress !== null || slideStatus !== null}>
              {publishing ? 'Publishing…' : 'Post now'}
            </GhostBtn>
            <PrimaryBtn onClick={() => save('scheduled')} disabled={busy || progress !== null || slideStatus !== null}>
              {busy && !publishing ? 'Saving…' : 'Schedule'}
            </PrimaryBtn>
          </div>
        </div>
      </div>
    </Modal>
  );
}

// ── post detail ──────────────────────────────────────────────────────────────

function PostDetail({
  post,
  onClose,
  onEdit,
  onChanged,
  show,
}: {
  post: PostRow;
  onClose: () => void;
  onEdit: () => void;
  onChanged: () => void;
  show: (t: string, k?: 'ok' | 'err') => void;
}) {
  const [busy, setBusy] = useState(false);
  const [slide, setSlide] = useState(0);
  const editable = ['draft', 'scheduled', 'canceled', 'failed'].includes(post.status);
  const publishable = ['draft', 'scheduled', 'failed', 'partial', 'canceled'].includes(post.status);
  const media = post.media || [];

  const act = async (fn: () => Promise<unknown>, done: string) => {
    setBusy(true);
    try {
      await fn();
      show(done);
      onChanged();
      onClose();
    } catch (e) {
      show(e instanceof Error ? e.message : 'Action failed', 'err');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={post.title || 'Untitled post'} onClose={onClose} wide>
      <div className="grid grid-cols-[180px_1fr] gap-6">
        <div className="flex flex-col gap-2">
          <div className="aspect-[9/16] rounded-xl overflow-hidden bg-minimal-row border border-minimal-border">
            {post.post_type === 'carousel' ? (
              media[slide] ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={media[slide].url}
                  alt={`Slide ${slide + 1}`}
                  className="w-full h-full object-cover"
                />
              ) : null
            ) : (
              post.video_url && (
                <video src={post.video_url} className="w-full h-full object-cover" controls playsInline />
              )
            )}
          </div>
          {post.post_type === 'carousel' && media.length > 1 && (
            <div className="flex gap-1.5 flex-wrap">
              {media.map((m, i) => (
                <button
                  key={m.id}
                  type="button"
                  onClick={() => setSlide(i)}
                  className={`w-8 h-10 rounded overflow-hidden border transition-colors ${
                    i === slide ? 'border-white' : 'border-minimal-border opacity-60 hover:opacity-100'
                  }`}
                  title={`Slide ${i + 1}`}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={m.url} alt="" className="w-full h-full object-cover" />
                </button>
              ))}
            </div>
          )}
        </div>
        <div className="flex flex-col gap-4 min-w-0">
          <div className="flex items-center gap-4">
            <StatusDot status={post.status} map={POST_STATUS_DOTS} />
            <PostTypeBadge type={post.post_type} slides={media.length} />
            <span className="text-[12px] text-zinc-500">
              {post.status === 'published' || post.status === 'partial'
                ? `Published ${fmtDate(post.published_at)}`
                : post.scheduled_at
                  ? `Scheduled ${fmtDate(post.scheduled_at)}`
                  : `Created ${fmtDate(post.created_at)}`}
            </span>
          </div>

          {post.caption && (
            <p className="text-[13px] text-zinc-400 whitespace-pre-wrap leading-relaxed max-h-32 overflow-y-auto">
              {post.caption}
            </p>
          )}

          <div className="flex flex-col gap-2">
            {post.targets.map((t) => (
              <div
                key={t.id}
                className="flex items-center gap-3 px-3 py-2 border border-minimal-border rounded-lg"
              >
                <PlatformBadge platform={t.platform} />
                <StatusDot status={t.status} map={TARGET_STATUS_DOTS} />
                {t.latest_metrics && (
                  <span className="text-[12px] text-zinc-500">
                    {fmtCount(t.latest_metrics.views)} views · {fmtCount(t.latest_metrics.likes)}{' '}
                    likes · {fmtCount(t.latest_metrics.comments)} comments
                  </span>
                )}
                <span className="flex-1" />
                {t.external_url && (
                  <a
                    href={t.external_url}
                    target="_blank"
                    rel="noreferrer"
                    className="text-[12px] text-zinc-400 hover:text-white underline underline-offset-2"
                  >
                    View ↗
                  </a>
                )}
                {t.error && (
                  <span className="text-[11px] text-red-400 max-w-[220px] truncate" title={t.error}>
                    {t.error}
                  </span>
                )}
              </div>
            ))}
          </div>

          {post.error && <p className="text-[12px] text-red-400">{post.error}</p>}

          <div className="flex items-center gap-3 pt-2 flex-wrap">
            {publishable && (
              <PrimaryBtn
                disabled={busy}
                onClick={() =>
                  act(
                    () => api(`/api/social/posts/${post.id}/publish`, { method: 'POST', body: '{}' }),
                    post.status === 'failed' || post.status === 'partial'
                      ? 'Retrying failed platforms…'
                      : 'Publishing…'
                  )
                }
              >
                {post.status === 'failed' || post.status === 'partial' ? 'Retry now' : 'Publish now'}
              </PrimaryBtn>
            )}
            {editable && <GhostBtn onClick={onEdit}>Edit</GhostBtn>}
            {post.status === 'scheduled' && (
              <GhostBtn
                disabled={busy}
                onClick={() =>
                  act(
                    () =>
                      api(`/api/social/posts/${post.id}`, {
                        method: 'PATCH',
                        body: JSON.stringify({ status: 'canceled' }),
                      }),
                    'Canceled'
                  )
                }
              >
                Cancel
              </GhostBtn>
            )}
            {post.status !== 'publishing' && (
              <GhostBtn
                danger
                disabled={busy}
                onClick={() => {
                  if (!confirm('Delete this post? Published content stays live on the platforms.')) return;
                  act(() => api(`/api/social/posts/${post.id}`, { method: 'DELETE' }), 'Deleted');
                }}
              >
                Delete
              </GhostBtn>
            )}
          </div>
        </div>
      </div>
    </Modal>
  );
}

// ── list view (GHL-style planner table) ──────────────────────────────────────

function MediaThumb({ post }: { post: PostRow }) {
  const first = post.media?.[0];
  if (post.post_type === 'carousel' && first) {
    return (
      <span className="relative inline-block w-9 h-12 rounded overflow-hidden bg-minimal-row border border-minimal-border shrink-0">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={first.url} alt="" className="w-full h-full object-cover" />
        {post.media.length > 1 && (
          <span className="absolute bottom-0 right-0 px-1 text-[9px] font-semibold bg-black/70 text-white rounded-tl">
            {post.media.length}
          </span>
        )}
      </span>
    );
  }
  if (post.video_url) {
    return (
      <span className="inline-block w-9 h-12 rounded overflow-hidden bg-minimal-row border border-minimal-border shrink-0">
        <video src={post.video_url} className="w-full h-full object-cover" muted playsInline preload="metadata" />
      </span>
    );
  }
  return (
    <span className="inline-flex items-center justify-center w-9 h-12 rounded bg-minimal-row border border-minimal-border text-zinc-600 text-[10px] shrink-0">
      —
    </span>
  );
}

const STATUS_LABELS: Record<string, string> = {
  draft: 'Draft',
  scheduled: 'Scheduled',
  publishing: 'Publishing',
  published: 'Published',
  partial: 'Partial',
  failed: 'Failed',
  canceled: 'Canceled',
};

function ListView({
  posts,
  onOpen,
}: {
  posts: PostRow[];
  onOpen: (p: PostRow) => void;
}) {
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return posts
      .filter((p) => {
        if (status && p.status !== status) return false;
        if (needle.length >= 3) {
          const hay = `${p.title || ''}\n${p.caption}`.toLowerCase();
          if (!hay.includes(needle)) return false;
        }
        const d = postDate(p);
        if (from && d < from) return false;
        if (to && d > `${to}T23:59:59`) return false;
        return true;
      })
      .sort((a, b) => postDate(b).localeCompare(postDate(a)));
  }, [posts, q, status, from, to]);

  return (
    <div>
      {/* filters */}
      <div className="flex items-center gap-3 mb-4 flex-wrap">
        <div className="w-64">
          <TextInput
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search by caption (min 3 chars)"
          />
        </div>
        <Select value={status} onChange={(e) => setStatus(e.target.value)} className="w-40">
          <option value="">All statuses</option>
          {Object.entries(STATUS_LABELS).map(([v, l]) => (
            <option key={v} value={v}>
              {l}
            </option>
          ))}
        </Select>
        <div className="flex items-center gap-2 text-[12px] text-zinc-500">
          <TextInput type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          <span>→</span>
          <TextInput type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </div>
        {(q || status || from || to) && (
          <GhostBtn
            onClick={() => {
              setQ('');
              setStatus('');
              setFrom('');
              setTo('');
            }}
          >
            Clear
          </GhostBtn>
        )}
        <span className="text-[12px] text-zinc-600 ml-auto">
          {rows.length} post{rows.length === 1 ? '' : 's'}
        </span>
      </div>

      {/* table */}
      {rows.length === 0 ? (
        <EmptyState title="No posts match" hint="Loosen the filters or schedule something new." />
      ) : (
        <div className="border border-minimal-border rounded-xl overflow-hidden">
          <table className="w-full text-left">
            <thead>
              <tr className="border-b border-minimal-border text-[11px] uppercase tracking-wider text-zinc-500">
                <th className="px-4 py-2.5 font-semibold">Caption</th>
                <th className="px-3 py-2.5 font-semibold">Media</th>
                <th className="px-3 py-2.5 font-semibold">Status</th>
                <th className="px-3 py-2.5 font-semibold">Type</th>
                <th className="px-3 py-2.5 font-semibold">Date</th>
                <th className="px-3 py-2.5 font-semibold">Social</th>
                <th className="px-3 py-2.5 font-semibold text-right">Views</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((p) => (
                <tr
                  key={p.id}
                  onClick={() => onOpen(p)}
                  className="border-b border-minimal-border/60 last:border-b-0 cursor-pointer hover:bg-minimal-row/50 transition-colors"
                >
                  <td className="px-4 py-2.5 max-w-[320px]">
                    <span className="block text-[13px] text-white truncate">
                      {p.title || p.caption.split('\n')[0] || 'Untitled'}
                    </span>
                    {p.title && p.caption && (
                      <span className="block text-[11px] text-zinc-600 truncate">
                        {p.caption.split('\n')[0]}
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2.5">
                    <MediaThumb post={p} />
                  </td>
                  <td className="px-3 py-2.5 whitespace-nowrap">
                    <span className="inline-flex items-center gap-2">
                      <span className={`w-1.5 h-1.5 rounded-full ${POST_STATUS_DOTS[p.status]}`} />
                      <span className="text-[12px] text-zinc-400">{STATUS_LABELS[p.status]}</span>
                    </span>
                  </td>
                  <td className="px-3 py-2.5">
                    <PostTypeBadge type={p.post_type} slides={p.media?.length} />
                  </td>
                  <td className="px-3 py-2.5 text-[12px] text-zinc-400 whitespace-nowrap">
                    {fmtDate(postDate(p))}
                  </td>
                  <td className="px-3 py-2.5">
                    <span className="flex items-center gap-2">
                      {p.targets.map((t) => (
                        <PlatformBadge key={t.id} platform={t.platform} muted />
                      ))}
                    </span>
                  </td>
                  <td className="px-3 py-2.5 text-[12px] text-zinc-500 text-right whitespace-nowrap">
                    {['published', 'partial'].includes(p.status)
                      ? fmtCount(postMetric(p, 'views'))
                      : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ── page ─────────────────────────────────────────────────────────────────────

export default function SocialStudioPage() {
  const { show, node: toastNode } = useToast();
  const [posts, setPosts] = useState<PostRow[] | null>(null);
  const [accounts, setAccounts] = useState<AccountRow[]>([]);
  const [cursor, setCursor] = useState(() => startOfMonth(new Date()));
  const [view, setView] = useState<'calendar' | 'list'>('calendar');
  const [composer, setComposer] = useState<{ editing: PostRow | null; date: string | null } | null>(
    null
  );
  const [detail, setDetail] = useState<PostRow | null>(null);
  const [ticking, setTicking] = useState(false);

  useEffect(() => {
    try {
      const stored = localStorage.getItem('dh-social-view');
      if (stored === 'list' || stored === 'calendar') setView(stored);
    } catch {}
  }, []);

  const switchView = (v: 'calendar' | 'list') => {
    setView(v);
    try {
      localStorage.setItem('dh-social-view', v);
    } catch {}
  };

  const load = useCallback(async () => {
    try {
      const [postsRes, accountsRes] = await Promise.all([
        api<{ posts: PostRow[] }>('/api/social/posts?limit=200'),
        api<{ accounts: AccountRow[] }>('/api/social/accounts'),
      ]);
      setPosts(postsRes.posts);
      setAccounts(accountsRes.accounts);
    } catch (e) {
      show(e instanceof Error ? e.message : 'Failed to load — has migration 019 been applied?', 'err');
      setPosts([]);
    }
  }, [show]);

  useEffect(() => {
    load();
  }, [load]);

  const runEngine = async () => {
    setTicking(true);
    try {
      const res = await api<{ targetsPublished: number; targetsProcessing: number }>(
        '/api/social/tick',
        { method: 'POST', body: '{}' }
      );
      show(`Engine ran — ${res.targetsPublished} published, ${res.targetsProcessing} processing`);
      load();
    } catch (e) {
      show(e instanceof Error ? e.message : 'Tick failed', 'err');
    } finally {
      setTicking(false);
    }
  };

  const byDay = useMemo(() => {
    const map = new Map<string, PostRow[]>();
    for (const p of posts || []) {
      const iso = p.scheduled_at || p.published_at;
      if (!iso) continue;
      const key = dayKey(new Date(iso));
      map.set(key, [...(map.get(key) || []), p]);
    }
    for (const list of map.values()) {
      list.sort((a, b) =>
        (a.scheduled_at || a.published_at || '').localeCompare(b.scheduled_at || b.published_at || '')
      );
    }
    return map;
  }, [posts]);

  const drafts = (posts || []).filter((p) => p.status === 'draft');
  const upNext = (posts || [])
    .filter((p) => ['scheduled', 'publishing'].includes(p.status))
    .sort((a, b) => (a.scheduled_at || '').localeCompare(b.scheduled_at || ''))
    .slice(0, 8);

  if (posts === null) {
    return (
      <div className="flex flex-col h-full">
        <PageHeader title="Social" />
        <SocialNav />
        <Loading />
      </div>
    );
  }

  const grid = monthGrid(cursor);
  const todayKey = dayKey(new Date());
  const monthLabel = cursor.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });

  const viewToggle = (
    <div className="flex rounded-lg border border-minimal-border overflow-hidden">
      <button
        type="button"
        onClick={() => switchView('list')}
        title="List view"
        className={`px-2.5 py-1.5 transition-colors ${
          view === 'list' ? 'bg-minimal-row text-white' : 'text-minimal-muted hover:text-white'
        }`}
      >
        <svg xmlns="http://www.w3.org/2000/svg" className="w-4 h-4" viewBox="0 0 256 256" fill="currentColor">
          <path d="M224,64a8,8,0,0,1-8,8H88a8,8,0,0,1,0-16H216A8,8,0,0,1,224,64Zm-8,56H88a8,8,0,0,0,0,16H216a8,8,0,0,0,0-16Zm0,64H88a8,8,0,0,0,0,16H216a8,8,0,0,0,0-16ZM48,56a12,12,0,1,0,12,12A12,12,0,0,0,48,56Zm0,60a12,12,0,1,0,12,12A12,12,0,0,0,48,116Zm0,64a12,12,0,1,0,12,12A12,12,0,0,0,48,180Z" />
        </svg>
      </button>
      <button
        type="button"
        onClick={() => switchView('calendar')}
        title="Calendar view"
        className={`px-2.5 py-1.5 transition-colors ${
          view === 'calendar' ? 'bg-minimal-row text-white' : 'text-minimal-muted hover:text-white'
        }`}
      >
        <svg xmlns="http://www.w3.org/2000/svg" className="w-4 h-4" viewBox="0 0 256 256" fill="currentColor">
          <path d="M208,32H184V24a8,8,0,0,0-16,0v8H88V24a8,8,0,0,0-16,0v8H48A16,16,0,0,0,32,48V208a16,16,0,0,0,16,16H208a16,16,0,0,0,16-16V48A16,16,0,0,0,208,32ZM72,48v8a8,8,0,0,0,16,0V48h80v8a8,8,0,0,0,16,0V48h24V80H48V48ZM208,208H48V96H208V208Z" />
        </svg>
      </button>
    </div>
  );

  return (
    <div className="flex flex-col h-full">
      {toastNode}
      <PageHeader title="Social">
        {viewToggle}
        <GhostBtn onClick={runEngine} disabled={ticking}>
          {ticking ? 'Running…' : 'Run engine'}
        </GhostBtn>
        <PrimaryBtn onClick={() => setComposer({ editing: null, date: null })}>New post</PrimaryBtn>
      </PageHeader>
      <SocialNav />

      <div className="flex-1 overflow-y-auto px-12 py-8">
        {accounts.filter((a) => a.status === 'active').length === 0 && (
          <div className="mb-6 px-4 py-3 border border-yellow-500/30 bg-yellow-500/5 rounded-lg text-[13px] text-yellow-400">
            No platform accounts connected yet — open the Accounts tab to link Instagram, Facebook,
            and YouTube before scheduling.
          </div>
        )}

        {view === 'list' ? (
          <ListView posts={posts} onOpen={setDetail} />
        ) : (
          <>
            {/* calendar header */}
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-[15px] font-semibold text-white">{monthLabel}</h2>
              <div className="flex items-center gap-2">
                <GhostBtn onClick={() => setCursor(new Date(cursor.getFullYear(), cursor.getMonth() - 1, 1))}>
                  ←
                </GhostBtn>
                <GhostBtn onClick={() => setCursor(startOfMonth(new Date()))}>Today</GhostBtn>
                <GhostBtn onClick={() => setCursor(new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1))}>
                  →
                </GhostBtn>
              </div>
            </div>

            {/* calendar */}
            <div className="border border-minimal-border rounded-xl overflow-hidden">
              <div className="grid grid-cols-7 border-b border-minimal-border">
                {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d) => (
                  <div key={d} className="px-3 py-2 text-[11px] font-semibold text-zinc-500 uppercase tracking-wider">
                    {d}
                  </div>
                ))}
              </div>
              <div className="grid grid-cols-7">
                {grid.map((day, i) => {
                  const key = dayKey(day);
                  const inMonth = day.getMonth() === cursor.getMonth();
                  const dayPosts = byDay.get(key) || [];
                  return (
                    <div
                      key={i}
                      onClick={() => setComposer({ editing: null, date: key })}
                      className={`min-h-[96px] p-1.5 border-b border-r border-minimal-border/60 cursor-pointer transition-colors hover:bg-minimal-row/50 ${
                        inMonth ? '' : 'opacity-40'
                      } ${i % 7 === 6 ? 'border-r-0' : ''} ${i >= 35 ? 'border-b-0' : ''}`}
                    >
                      <div
                        className={`text-[11px] font-medium mb-1 px-1 ${
                          key === todayKey
                            ? 'text-black bg-white rounded w-5 h-5 flex items-center justify-center'
                            : 'text-zinc-500'
                        }`}
                      >
                        {day.getDate()}
                      </div>
                      <div className="flex flex-col gap-1">
                        {dayPosts.slice(0, 3).map((p) => (
                          <button
                            key={p.id}
                            onClick={(e) => {
                              e.stopPropagation();
                              setDetail(p);
                            }}
                            className="w-full text-left px-1.5 py-1 rounded bg-minimal-row hover:bg-minimal-border/60 transition-colors"
                          >
                            <span className="flex items-center gap-1.5">
                              <span
                                className={`w-1.5 h-1.5 rounded-full shrink-0 ${POST_STATUS_DOTS[p.status]}`}
                              />
                              {p.post_type === 'carousel' && (
                                <span className="text-[9px] text-zinc-500 shrink-0" title="Carousel">
                                  ▦
                                </span>
                              )}
                              <span className="text-[11px] text-zinc-300 truncate">
                                {p.title || p.caption.split('\n')[0] || 'Untitled'}
                              </span>
                            </span>
                            <span className="flex items-center gap-1.5 mt-0.5 pl-3">
                              {p.targets.map((t) => (
                                <span
                                  key={t.id}
                                  className={`w-1 h-1 rounded-full ${PLATFORM_META[t.platform].dot}`}
                                  title={PLATFORM_META[t.platform].label}
                                />
                              ))}
                            </span>
                          </button>
                        ))}
                        {dayPosts.length > 3 && (
                          <span className="text-[10px] text-zinc-600 px-1.5">
                            +{dayPosts.length - 3} more
                          </span>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* queue + drafts */}
            <div className="grid grid-cols-2 gap-8 mt-8">
              <section>
                <h2 className="text-[13px] font-semibold text-zinc-300 mb-3">Up next</h2>
                {upNext.length === 0 ? (
                  <EmptyState title="Nothing scheduled" hint="Click a day on the calendar or hit New post." />
                ) : (
                  <div className="flex flex-col gap-2">
                    {upNext.map((p) => (
                      <button
                        key={p.id}
                        onClick={() => setDetail(p)}
                        className="flex items-center gap-3 px-4 py-3 border border-minimal-border rounded-lg text-left hover:border-zinc-600 transition-colors"
                      >
                        <StatusDot status={p.status} map={POST_STATUS_DOTS} />
                        <span className="text-[13px] text-white flex-1 truncate">
                          {p.title || p.caption.split('\n')[0] || 'Untitled'}
                        </span>
                        <span className="flex items-center gap-2">
                          {p.targets.map((t) => (
                            <PlatformBadge key={t.id} platform={t.platform} muted />
                          ))}
                        </span>
                        <span className="text-[12px] text-zinc-500 w-36 text-right">
                          {fmtDate(p.scheduled_at)}
                        </span>
                      </button>
                    ))}
                  </div>
                )}
              </section>
              <section>
                <h2 className="text-[13px] font-semibold text-zinc-300 mb-3">Drafts</h2>
                {drafts.length === 0 ? (
                  <EmptyState title="No drafts" hint="Save a post without scheduling to park it here." />
                ) : (
                  <div className="flex flex-col gap-2">
                    {drafts.map((p) => (
                      <button
                        key={p.id}
                        onClick={() => setDetail(p)}
                        className="flex items-center gap-3 px-4 py-3 border border-minimal-border rounded-lg text-left hover:border-zinc-600 transition-colors"
                      >
                        <span className="text-[13px] text-zinc-300 flex-1 truncate">
                          {p.title || p.caption.split('\n')[0] || 'Untitled'}
                        </span>
                        <span className="text-[12px] text-zinc-600">{fmtDate(p.created_at)}</span>
                      </button>
                    ))}
                  </div>
                )}
              </section>
            </div>

            {/* recently published */}
            <section className="mt-8 mb-12">
              <h2 className="text-[13px] font-semibold text-zinc-300 mb-3">Recently published</h2>
              {(posts || []).filter((p) => ['published', 'partial'].includes(p.status)).length === 0 ? (
                <EmptyState title="Nothing published yet" />
              ) : (
                <div className="flex flex-col gap-2">
                  {(posts || [])
                    .filter((p) => ['published', 'partial'].includes(p.status))
                    .slice(0, 10)
                    .map((p) => (
                      <button
                        key={p.id}
                        onClick={() => setDetail(p)}
                        className="flex items-center gap-3 px-4 py-3 border border-minimal-border rounded-lg text-left hover:border-zinc-600 transition-colors"
                      >
                        <StatusDot status={p.status} map={POST_STATUS_DOTS} />
                        <span className="text-[13px] text-white flex-1 truncate">
                          {p.title || p.caption.split('\n')[0] || 'Untitled'}
                        </span>
                        <span className="text-[12px] text-zinc-500">
                          {fmtCount(postMetric(p, 'views'))} views
                        </span>
                        <span className="text-[12px] text-zinc-500 w-36 text-right">
                          {fmtDate(p.published_at)}
                        </span>
                      </button>
                    ))}
                </div>
              )}
            </section>
          </>
        )}
      </div>

      {composer && (
        <Composer
          accounts={accounts}
          editing={composer.editing}
          prefillDate={composer.date}
          onClose={() => setComposer(null)}
          onSaved={load}
          show={show}
        />
      )}
      {detail && (
        <PostDetail
          post={detail}
          onClose={() => setDetail(null)}
          onEdit={() => {
            setComposer({ editing: detail, date: null });
            setDetail(null);
          }}
          onChanged={load}
          show={show}
        />
      )}
    </div>
  );
}
