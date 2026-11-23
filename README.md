# Video Email

Record a short video (camera, screen, or both), send it by email or text, and see
who opened it and how much they watched. A free, run-it-yourself alternative to
paid video-email services.

What it does:

- Record from the browser or phone, or upload a video you already have.
- Paste the video into Gmail as a moving preview picture that links to a watch page.
- Alerts when someone opens the email or watches the video.
- Screenshots (whole page, an area, any monitor) with a mark-up editor.
- "Record a video for us" links and QR codes, playlists, questions, approve/decline buttons.
- A Chrome button for the toolbar and inside Gmail, and a phone home-screen app.
- A team: each person signs in and sees their own videos; the admin sees everything.

Everything runs on one small computer of your own. Your videos and your list of
viewers stay with you.

## What you need

1. **An always-on computer** running Linux, with Python 3.12 or newer. A free cloud
   server works; so does a spare mini PC. About 1 GB of memory is plenty.
2. **A web address with https.** People need to open your watch pages from anywhere,
   and browsers only allow camera recording on https. The simplest free way is a
   [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/)
   pointed at a domain name you own (for example `video.yourbusiness.com`).
3. **Optional:** a Gmail address with an
   [app password](https://myaccount.google.com/apppasswords) if you want email alerts.

## Set it up

On the always-on computer:

```bash
git clone https://github.com/SuiteStays/video-email-kit.git ~/video-email
cd ~/video-email
python3 -m venv .venv
.venv/bin/pip install -e .
cp .env.example .env
nano .env
```

In `.env`, fill in at least these three lines:

```
COMPANY_NAME=Your Business Name
COMPANY_URL=https://www.yourbusiness.com/
PUBLIC_URL=https://video.yourbusiness.com
```

Create your own login. It prints a link; open that link in your browser to choose your password.

```bash
.venv/bin/python -m video_email.app create-admin you@yourbusiness.com Your Name
```

Build the Chrome button with your web address and name inside it:

```bash
.venv/bin/python deploy/package_extension.py
```

Start it, and keep it running across restarts:

```bash
mkdir -p ~/.config/systemd/user
cp deploy/video-email.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now video-email
sudo loginctl enable-linger $USER
```

The program now listens on this computer at `http://127.0.0.1:8772`. Point your
Cloudflare Tunnel (or other https front door) at that address, using the same web
address you put in `PUBLIC_URL`.

Open `https://video.yourbusiness.com`, sign in, and go to **Settings** to:

- turn on alerts for this device,
- upload your email-signature picture (shown under every video),
- install the Chrome button,
- add the app to your phone's home screen.

Add team members on the **Team** page.

## If you put Cloudflare in front of it

- Do **not** put a sign-in wall (Cloudflare Access) on the address. Your recipients
  have to be able to open their video. Staff sign in inside the program itself.
- Do not let Cloudflare cache addresses that start with `/g/`. Those are the
  preview pictures that tell you an email was opened.

## Where things are kept

- `data/video_email.db` is the list of users, videos and who watched.
- `data/videos/` holds the videos and pictures themselves.
- `.env` holds your settings and passwords.

Back up the `data` folder and `.env`. Neither is ever part of this repository.

When storage goes over the limit in `.env` (`STORAGE_LIMIT_GB`), videos nobody has
watched for more than six months are cleared first.

## Updating

```bash
cd ~/video-email
git pull
.venv/bin/pip install -e .
.venv/bin/python deploy/package_extension.py
systemctl --user restart video-email
```

## For developers

```bash
pip install -e ".[dev]"
pytest
```

The server is FastAPI with SQLite. The pages are plain HTML and JavaScript with no
build step. `extension/` is the Chrome button; `deploy/package_extension.py` zips it
into the static folder with the server address filled in.
