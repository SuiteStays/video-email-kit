"""Make recorded videos play instantly everywhere.

Chrome records "fragmented" MP4: fine while recording, but it has no index,
so a browser must read through the whole file just to learn its length -
a long black screen on slower connections, and some browsers give up.
Here the same pictures and sound are re-packed (not re-encoded, so it is
quick even on the small server) into a normal MP4 with the index at the front.
"""
from __future__ import annotations

import logging
from pathlib import Path

log = logging.getLogger("video_email.media")


def make_email_preview(src: Path, gif_out: Path, thumb_out: Path | None = None, start: float = 0.0) -> bool:
    """The 3-second moving preview (with a play button) for emails, made on the
    server - used when the browser couldn't make one (long recordings)."""
    try:
        import av
        from PIL import Image, ImageDraw
    except ImportError:
        return False
    try:
        frames: list[Image.Image] = []
        with av.open(str(src)) as inp:
            vs = inp.streams.video[0]
            vs.thread_type = "AUTO"
            if start:
                inp.seek(int(start * 1_000_000), any_frame=False)
            next_t = start
            for frame in inp.decode(vs):
                t = float(frame.time or 0)
                if t < next_t:
                    continue
                img = frame.to_image()
                w = 400
                frames.append(img.resize((w, max(1, round(img.height * w / img.width)))))
                if thumb_out is not None and len(frames) == 4:
                    big = img.copy()
                    big.thumbnail((1280, 1280))
                    big.convert("RGB").save(thumb_out, "JPEG", quality=85)
                next_t += 0.125
                if len(frames) >= 24:
                    break
        if not frames:
            return False
        out = []
        for f in frames:
            d = ImageDraw.Draw(f)
            r = round(min(f.width, f.height) * 0.13)
            cx, cy = f.width / 2, f.height / 2
            d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=(255, 255, 255))
            d.polygon([(cx - r * .32, cy - r * .45), (cx - r * .32, cy + r * .45), (cx + r * .5, cy)], fill=(15, 92, 140))
            out.append(f.convert("P", palette=Image.ADAPTIVE, colors=255))
        out[0].save(gif_out, save_all=True, append_images=out[1:], duration=125, loop=0, optimize=True)
        return True
    except Exception:  # noqa: BLE001
        log.exception("could not make the email preview for %s", src)
        return False


def remux_to_faststart(src: Path) -> float | None:
    """Re-pack src in place. Returns the duration in seconds, or None if it couldn't."""
    try:
        import av
    except ImportError:
        log.warning("PyAV not installed; videos are served as recorded")
        return None
    tmp = src.with_suffix(".faststart.tmp")
    try:
        with av.open(str(src)) as inp:
            if inp.format.name.split(",")[0] not in ("mov", "mp4", "m4a", "3gp", "3g2", "mj2"):
                return None  # e.g. WebM: would need re-encoding; leave it as it is
            streams = [s for s in inp.streams if s.type in ("video", "audio")]
            if not streams:
                return None
            with av.open(str(tmp), "w", format="mp4", options={"movflags": "faststart"}) as out:
                mapping = {s.index: out.add_stream_from_template(s) for s in streams}
                for packet in inp.demux(*streams):
                    if packet.dts is None:
                        continue
                    packet.stream = mapping[packet.stream.index]
                    out.mux(packet)
        with av.open(str(tmp)) as check:
            duration = float(check.duration / 1_000_000) if check.duration else None
            if not check.streams.video and not check.streams.audio:
                raise RuntimeError("re-packed file has no streams")
        tmp.replace(src)
        return duration
    except Exception:  # noqa: BLE001 -- the original still plays (slowly); never lose it
        log.exception("could not re-pack %s", src)
        tmp.unlink(missing_ok=True)
        return None
