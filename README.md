# BoardLink — tablet app (Android APK)

This folder is the Android project for the BoardLink tablet app.
GitHub builds the APK for you (same as Arcane Arena): you never need Android Studio.

The app contains everything: the drawing board, the AI window, and the small server
that the PC connects to. The PC only needs the file **BoardLink-PC.html** and Chrome.

## 1. Build the APK on GitHub (once)

1. Go to https://github.com → **New repository** → name it `BoardLink` → **Create repository**.
2. On the new repository page click **uploading an existing file**.
3. Unzip `BoardLink-Tablet-APK.zip` on your PC, open the folder, select **everything inside it**
   (including the hidden `.github` folder — in Windows Explorer: *View → Show → Hidden items*)
   and drag it onto the GitHub page. Click **Commit changes**.
   - Check that GitHub shows the folder `.github/workflows/build-apk.yml`. Without it nothing builds.
4. Open the **Actions** tab. The job **Build BoardLink APK** starts by itself (about 3–5 minutes).
   If it does not start, click it and press **Run workflow**.
5. When it shows a green tick, click the run → at the bottom, under **Artifacts**, download
   **BoardLink-APK**. It is a zip containing **BoardLink.apk**.

If the run turns red, open it, click the failed step and send me the red error text.

## 2. Install it on the tablet

1. Copy `BoardLink.apk` to the tablet (USB cable, Google Drive, WhatsApp to yourself…).
2. Open it on the tablet → if asked, allow **Install unknown apps** for that app → **Install**.
3. Open **BoardLink**. The first time you tap the microphone, allow it.

## 3. Connect to the PC (every time)

1. Plug the tablet into the PC with a USB **data** cable.
2. On the tablet: **Settings → Network & internet (Connections) → Hotspot & tethering → USB tethering** → ON.
3. In the BoardLink app tap **Settings** (gear, bottom right): it shows the address, e.g. `192.168.42.129`.
4. On the PC double-click **BoardLink-PC.html** → type the address → **Connect**.
   Next time it finds the tablet by itself.

No cable? Put both on the same Wi-Fi and use the Wi-Fi address shown in the app.

Note: with USB tethering on, Windows may use the tablet's internet. If the tablet is on Wi-Fi this is fine;
if it is on mobile data, watch your data, or connect the PC to Wi-Fi first.

## 4. The AI window

On the PC menu click **AI settings** (or the gear on the tablet) and paste your Claude API key from
https://console.anthropic.com. The key is stored on the tablet only. The AI and voice typing need
internet on the tablet.

## What's inside

| Path | What it is |
|---|---|
| `.github/workflows/build-apk.yml` | Tells GitHub how to build the APK |
| `app/src/main/java/.../MainActivity.java` | The Android app: full-screen board, microphone, voice, image picker |
| `app/src/main/java/.../BoardServer.java` | Built-in server the PC connects to (port 8765) + AI calls |
| `app/src/main/java/.../Json.java` | Small JSON helper |
| `app/src/main/assets/web/tablet.*` | Tablet screen (tools left, AI right) |
| `app/src/main/assets/web/pc.*` | PC screen (menu, Board, Video + draw) — sent to Chrome on the PC |
| `app/src/main/assets/web/shared.js` | Drawing engine used by both |
| `app/src/main/res/mipmap-*` | App icon |

To change the design or text later, edit the files in `app/src/main/assets/web/`, upload them to
GitHub again, and download the new APK from **Actions**.

## Debugging

The app allows Chrome remote debugging: plug the tablet in, open `chrome://inspect` on the PC and
click **inspect** under BoardLink to see the tablet screen's console.
