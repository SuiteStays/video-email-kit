"""Bake the server address and company name into the Chrome button and zip it
for download from the Settings page.

    python deploy/package_extension.py                       (reads PUBLIC_URL and COMPANY_NAME from .env)
    python deploy/package_extension.py https://video.example.com "My Company"
"""
import io
import os
import sys
import zipfile
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "extension"
OUT = ROOT / "src" / "video_email" / "static" / "gmail-button.zip"


def icon(size: int) -> bytes:
    brand = (15, 92, 140)
    im = Image.new("RGB", (size, size), brand)
    d = ImageDraw.Draw(im)
    r, c = size * 0.30, size / 2
    d.ellipse([c - r, c - r, c + r, c + r], fill="white")
    d.polygon([(c - r * .32, c - r * .45), (c - r * .32, c + r * .45), (c + r * .5, c)], fill=brand)
    buf = io.BytesIO()
    im.save(buf, "PNG")
    return buf.getvalue()


def safe_name(name: str) -> str:
    for ch in ('"', chr(92), '`', '<', '>', '$'):
        name = name.replace(ch, "")
    return name.replace("'", "’").strip() or "My Company"


def from_env(key: str, default: str = "") -> str:
    if os.environ.get(key):
        return os.environ[key]
    env = ROOT / ".env"
    if env.exists():
        for line in env.read_text(encoding="utf-8").splitlines():
            k, _, v = line.strip().partition("=")
            if k.strip() == key:
                return v.strip().strip('"').strip("'")
    return default


def main(server: str, company: str) -> None:
    server = server.rstrip("/")
    if not server.startswith("http"):
        sys.exit("Set PUBLIC_URL in .env first (your https web address), or pass it as the first argument.")
    company = safe_name(company)
    with zipfile.ZipFile(OUT, "w", zipfile.ZIP_DEFLATED) as z:
        for f in SRC.iterdir():
            data = f.read_bytes()
            if f.suffix in (".js", ".json", ".html"):  # every file that might name the server
                data = data.replace(b"__SERVER__", server.encode()).replace(b"__COMPANY__", company.encode("utf-8"))
            z.writestr(f"gmail-button/{f.name}", data)
        z.writestr("gmail-button/icon-48.png", icon(48))
        z.writestr("gmail-button/icon-128.png", icon(128))
    print(f"wrote {OUT}")


if __name__ == "__main__":
    args = sys.argv[1:]
    main(args[0] if args else from_env("PUBLIC_URL"),
         args[1] if len(args) > 1 else from_env("COMPANY_NAME", "My Company"))
