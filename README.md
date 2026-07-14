# DropCull

**Drop it in. Keep the best. Edit sooner.**

DropCull is a free culling studio that lives on your own computer. You drop in a whole card dump — camera photos, drone shots, RAW files, video clips — and it does the boring first pass for you:

- Sorts everything into **shoots** by date and time
- Flags **blurry** shots and **too-dark / too-bright** shots automatically
- Stacks **burst duplicates** and picks the sharpest frame of each
- Lets you fly through the rest with **arrow keys** (P = pick, X = reject, 1–5 = stars)
- Plays your **videos** right in the app

When you're done choosing:

- **Send ratings to Lightroom** — your stars show up automatically when you import (RAW files get a tiny `.xmp` sidecar file; the originals are never touched)
- **Copy picks to Selects** — keepers copied into a clean folder, sorted by shoot
- **Client proof JPEGs** — one click makes web-sized previews to send a client
- **Auto-edit picks** — one click batch-edits every keeper into full-resolution JPEGs in `_DropCull/Edited`, sorted by shoot — originals never touched. Free and offline
- **Five looks, chosen per photo** — in the big view, tap a look to preview it on that photo: **Costa Rica** (vivid ocean blues + lush greens — the default), **Natural** (invisible polish), **Golden Hour** (warm sunset glow), **Bold** (maximum pop), **Black & White**. The batch edit applies each photo's chosen look
- **Sweep rejects** — junk moves into a `_DropCull/Rejects` folder. Nothing is ever deleted, and one click brings it all back

Everything runs locally. No account, no upload, no subscription, no internet needed after setup.

---

## Getting started (one time, ~3 minutes)

1. Install **Node.js** (free): <https://nodejs.org> — click the big green button, open the download, keep clicking Continue / Next.
2. Double-click the launcher in this folder:
   - **Mac:** `DropCull.command`. First time only: if your Mac says it "can't be opened because it is from an unidentified developer," that's just the Mac being careful with downloaded files. **Right-click** it, choose **Open**, then click **Open** in the pop-up. After that, normal double-click works forever.
   - **Windows:** `DropCull.bat`. First time only: if Windows shows a blue "Windows protected your PC" box, click **More info**, then **Run anyway** — same deal, Windows being careful with downloaded files.
3. Your browser opens with DropCull running. That's it.

Next time, just double-click the launcher again — it even reopens your last folder with all your picks saved.

**Updates are automatic.** Every launch, DropCull quietly checks for a newer version and installs it before starting. No internet? It just starts normally.

## Two ways to load photos

- **Best for big card dumps:** click **"Choose a folder"** and point at the folder — DropCull works on the files right where they are, no copying.
- **Quick and dirty:** drag files or a folder straight onto the DropCull window — it copies them into `Pictures/DropCull Inbox` first.

## Keyboard cheat sheet

| Key | Does |
|---|---|
| ← → ↑ ↓ | Move through shots |
| **P** | Pick (keeper) |
| **X** | Reject |
| **U** | Clear flag |
| **1–5** / **0** | Stars / clear stars |
| **Enter** | Big view |
| **Space** | Zoom 100% (in big view) |
| **Esc** | Close big view |
| **Del** | Remove photo from DropCull — the file on your computer is untouched |

## Don't have an editing app?

DropCull sorts and rates — it doesn't edit. If you don't have Lightroom, grab **darktable** (free, no account, no subscription): <https://www.darktable.org>

It's a full pro-grade editor, and it automatically picks up the star ratings DropCull writes — open your folder in darktable after culling and your keepers are already starred.

## Good to know

- Closed the browser but the launcher window is still open? Double-click the launcher again — it notices DropCull is already running and just reopens it in your browser. (Or type `localhost:4621` in the address bar.)
- Pressed **Del** on the wrong photo? A **"Restore removed photos"** button appears in the sidebar whenever something's been removed — one click brings everything back. (Removing never touches the actual file anyway.)
- The first scan of a folder takes a bit (it builds previews and inspects every shot). Reopening the same folder is instant.
- Your picks/rejects/stars save automatically inside a `_DropCull` folder next to your photos. Delete that folder and every trace of DropCull is gone.
- RAW previews (CR3, NEF, ARW, DNG…) work on both systems: Macs convert natively; Windows uses the full-size JPEG preview your camera already saves inside every RAW file — the same trick the pro culling apps use.
- iPhone **HEIC** photos preview best on a Mac. On Windows they may show no preview (the photos themselves are fine and untouched).
- "Sweep rejects" **moves** files, never deletes. "Bring rejects back" restores every one of them.
