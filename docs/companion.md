# The Android companion

A small Android app for a board repo's cards when you're away from the desktop: look at your boards, jot a card down, move it along. It doesn't tackle cards or run Claude; that stays on the desktop.

It talks to GitHub, not git: it reads and writes the board repo's card files through GitHub's API, one commit per change, and the desktop's sync picks those commits up like any other machine's. So it works with board repos whose remote is on GitHub.

## What it does today

It signs in with GitHub and shows the repos it can reach. Browsing the boards, and making and changing cards, come next.

## Signing in

*Sign in with GitHub* shows a code, copies it, and opens github.com/login/device in the browser, where you're usually signed in already: paste the code, approve *Corkboard Companion*, and come back. There's no password to type into the app and no server between it and GitHub.

The first time, GitHub also asks you to install the app: pick **only your board repos**. The app can read and write those repos' files and nothing else, so a lost phone can't touch your code repos. If you signed in without installing it, the app says so and opens the install page; to add or remove repos later, go to *GitHub → Settings → Applications → Installed GitHub Apps → Corkboard Companion → Configure*.

You stay signed in: the app renews its access to GitHub by itself, as long as you open it at least once every six months. It keeps that access in Android's keystore. *Sign out* forgets it on the phone; to cut it off from GitHub's side as well (a lost phone), revoke *Corkboard Companion* under *GitHub → Settings → Applications → Authorized GitHub Apps*. Either way, the app goes back to *Sign in with GitHub*.

## Installing it

There's no Play Store package. Until releases carry a signed APK, install the debug build:

- from a CI run of the corkboard repo on GitHub (*Actions → CI → a run → Artifacts → companion-debug-apk*), unzipped; or
- built from source (`npm run apk` in `mobile/`, see [Building, releases and tests](development.md#the-android-companion)).

Then, with the phone connected over USB and USB debugging on (*Settings → About phone*, tap *Build number* seven times, then *Developer options → USB debugging*):

```bash
adb install -r app-debug.apk
```

or copy the file to the phone and open it there, allowing installs from that app when Android asks. A debug build from another machine or another CI run is signed with a different key, so Android won't install it over the one you have: uninstall that one first.

Back to the [documentation](README.md).
