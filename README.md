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
- A **"Saved" toast** with one-click **Open folder** (via the optional helper)
- A clean **in-page settings panel** (gear button, bottom-right)

---

## 📋 Requirements

- **Google Chrome** or **Microsoft Edge** (the direct-to-folder saving needs the File System Access API)
- **[Tampermonkey](https://www.tampermonkey.net/)** browser extension
- *(Optional)* **Python 3** — only needed for the "Open folder" button to launch Windows Explorer

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

## 📂 Optional: "Open folder" helper

After a download, a toast shows an **Open folder** button. Browsers can't open Windows Explorer
on their own, so a tiny Python helper does it. Setup is one-time:

1. **Install Python 3** from [python.org](https://www.python.org/downloads/) — tick **"Add Python to PATH"** during install.
2. **Run `setup_autostart.bat`** (double-click) once. This:
   - registers an `artlist://` handler so the helper **auto-starts** when you open Artlist (no console window),
   - adds it to your Windows Startup folder.
   The first time the script triggers it, Chrome asks *"Allow artlist.io to open Artlist DL Helper?"* — click **Open** and tick **Always allow**.
3. In the script's **Settings → Download folders**, paste the **full path** of each folder
   (e.g. `C:\Users\You\Music`) so "Open folder" knows where to go.

The helper shuts itself down ~5 seconds after your last Artlist tab closes.
To remove it later, run **`uninstall_helper.bat`**.

> Without the helper, the **Open folder** button still works — it just lists the saved files inside the toast instead of opening Explorer.

---

## 🎬 Usage at a glance

| Where | What you get |
|---|---|
| Any track row | A colored download button (green = music, pink = SFX, blue = footage) |
| Bottom-right | **⬇ Download all** for the current page/pack |
| Footage clip | Click **Download** → pick a resolution → saves to `Footage/<Clip Name>/` |
| Footage pack (story) | One click grabs every clip in the pack |
| Yellow button | You already downloaded this one |

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
