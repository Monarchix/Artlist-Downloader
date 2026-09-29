# Artlist DL

A [Tampermonkey](https://www.tampermonkey.net/) userscript that adds **download buttons** to [Artlist.io](https://artlist.io) — for music, SFX, albums, packs, similar tracks, and stock footage — with folder routing, genre sorting, bulk "Download all", a footage resolution picker, and more.

> ### Credit
> This is a **vibe-coded** enhanced fork of [**xNasuni/artlist-downloader**](https://github.com/xNasuni/artlist-downloader) by **Mia (xNasuni)**.
> All credit for the original work and the core download mechanism goes to her — this fork was built iteratively on top of that foundation.

---

## ✨ Features

- **Download buttons** on every music / SFX / album / pack / "similar" row
- **Stock footage** download (preview HLS stream) with a **resolution picker**
- **Footage packs** (story pages): download the entire pack in **one click**
- **"Download all"** — grab a whole page at once (saved to a folder or a `.zip`)
- **Direct-to-folder saving** — pick a folder once, files save straight there (no Save dialog)
- Separate **Music / SFX / Footage** folders + optional **genre sub-folders**
- **Related SFX** on a footage page download into the **same folder as the clip**
- **Already-downloaded tracking** (yellow buttons) + **local folder sync**
- **Download history** with **CSV / M3U** export
- Optional **ID3 / Vorbis tag** embedding + cover art
- **Pause / resume / retry** queue with per-track progress
- A **"Saved" toast** that **auto-opens the folder** in Explorer the moment a download finishes — no click, no extra step (toggle it off in Settings if you'd rather click manually)
- A clean **in-page settings panel** (gear button, bottom-right)

---

## 📋 Requirements

- **Google Chrome** or **Microsoft Edge** (the direct-to-folder saving needs the File System Access API)
- **[Tampermonkey](https://www.tampermonkey.net/)** browser extension
- **Python 3** — for the "Open folder" button to launch a real Windows Explorer window. Skippable, but then folder-opening falls back to a browser tab and needs Tampermonkey's "Allow access to file URLs" turned on

---

## 🚀 Installation

### 1. Install Tampermonkey
Get it for your browser from **[tampermonkey.net](https://www.tampermonkey.net/)**.

### 2. Install the script
Click this link — Tampermonkey will open an install page, then click **Install**:

**➡️ [Install artlist-downloader.user.js](https://github.com/Monarchix/artlist-downloader/raw/main/artlist-downloader.user.js)**

That's it. Open [artlist.io](https://artlist.io) and you'll see download buttons appear.

### 3. Pick your download folders (recommended)
Click the **gear button** (bottom-right of any Artlist page) → **Download folders** →
choose a folder for **Music**, **SFX**, and **Footage**. Files then save straight there with no dialog.

---

## 📂 Auto-open the save folder

After a download, the toast opens the exact save folder by itself — no button click. Two things
have to be in place:

**1. Tell the script where the folder actually is.** Click the **gear button** → **Download
folders** → paste the **full path** for each folder you use (e.g. `C:\Users\You\Music`) into the
small text box under that folder's picker. Browsers deliberately never reveal the OS path of a
folder you picked through a dialog, so the script cannot work this out on its own.

**2. Install the helper** — see below. It's what turns the path into a real Explorer window.

Turn the whole thing off under **Settings → Download folders → "Auto-open folder after download"**.
With no path set, the toast still lists the saved files inline; it just can't open a folder view.

### The helper (recommended — this is what makes "Open folder" work)

1. **Install Python 3** from [python.org](https://www.python.org/downloads/) — tick **"Add
   python.exe to PATH"** during install.
2. **Double-click `setup_autostart.bat`** once. It prints four checks and tells you if any of them
   fail. It registers an `artlist://` handler, adds a silent startup entry so the helper runs from
   every login, and then proves the helper is answering before it says "Setup complete".
3. Confirm in the script: **gear → Debug → Check helper** should read **"Helper running"**.

If the helper is ever down mid-session, click **Open folder** on the toast (or **gear → Debug →
Start helper**) and Chrome will ask *"Allow artlist.io to open Artlist DL Helper?"* — click
**Open** and tick **Always allow**. That prompt only appears from a real click; that is why there
is a button for it rather than the script doing it silently at page load.

To remove it later, run **`uninstall_helper.bat`**.

### Fallback without the helper

With a full path set but no helper, the script opens a **browser tab** at the folder instead of an
Explorer window. This needs one Chrome setting that is **off by default**: `chrome://extensions` →
**Tampermonkey** → **Details** → enable **"Allow access to file URLs"**. Without it Chrome silently
drops the tab and the toast will tell you so.

---

## 🎬 Usage at a glance

| Where | What you get |
|---|---|
| Any track row | A colored download button (green = music, pink = SFX, blue = footage) |
| Bottom-right | **⬇ Download all** for the current page/pack |
| Footage clip | Click **Download** → pick a resolution → saves to `Footage/<Clip Name>/` |
| Footage pack (story) | One click grabs every clip in the pack |
| Yellow button with a ✓ | You already downloaded this one. **Click** opens its folder; **Shift + Click** downloads it again |
| **⬇ Download all** on a mixed page | Skips what you already have and fetches only the new ones. **Shift + Click** the button to include everything |

`Alt + Click` a button to copy its download URL instead of saving.

---

## ⚠️ Disclaimer

- Stock **footage** is downloaded as the **preview-quality HLS stream**, not the full 4K source
  (the source files require a paid Artlist subscription and aren't exposed in the page).
- This tool is for **personal and educational use**. Respect [Artlist's Terms of Service](https://artlist.io/terms)
  and only download content you're entitled to.

---

## 📜 License

[BSD 3-Clause](LICENSE). Original work © **Mia (xNasuni)**; fork modifications © **Monarchix**.

## 🙏 Credits

- **Original author:** [Mia (xNasuni)](https://github.com/xNasuni/artlist-downloader) — the core script this fork is based on.
- **Fork & enhancements:** [Monarchix](https://github.com/Monarchix).
