# The Android companion

A small Android app for a board repo's cards when you're away from the desktop: look at your boards, jot a card down, move it along. It doesn't tackle cards or run Claude; that stays on the desktop.

It talks to GitHub, not git: it reads and writes the board repo's card files through GitHub's API, one commit per change, and the desktop's sync picks those commits up like any other machine's. So it works with board repos whose remote is on GitHub.

## What it does today

It signs in with GitHub, browses your board repos (their boards, each board's lists, and the cards in them) and makes cards. Changing cards comes next.

## Browsing

The first screen lists the board repos the app can reach. A repo opens to its boards, child boards under their parents; a board opens on its first list, with the others as tabs along the top, in the board's colours. Each list is in the order the desktop shows it (by hand, or the list's *Sort cards by*), with dividers as lines; archived cards and archived lists stay hidden, and cards with no list (the map's ideas) get an *Ideas* tab of their own. A card opens to its title, labels, due date and description. Images in descriptions show as `[image]` for now, and links open in the browser. Android's back button goes up a level.

The app reopens where you left it, drawn at once from what it last read, then refreshes: pull a screen down to refresh it by hand. It reads only the files that changed since, and only the open board's cards, so a refresh is quick and offline it shows the last read. If you're signed out (the sign-in was revoked, or the app went six months unopened), it still shows what it last read, with a bar to sign in again.

## Signing in

*Sign in with GitHub* shows a code, copies it, and opens github.com/login/device in the browser, where you're usually signed in already: paste the code, approve *Corkboard Companion*, and come back. There's no password to type into the app and no server between it and GitHub.

The first time, GitHub also asks you to install the app: pick **only your board repos**. The app can read and write those repos' files and nothing else, so a lost phone can't touch your code repos. If you signed in without installing it, the app says so and opens the install page; to add or remove repos later, go to *GitHub → Settings → Applications → Installed GitHub Apps → Corkboard Companion → Configure*.

You stay signed in: the app renews its access to GitHub by itself, as long as you open it at least once every six months. It keeps that access in Android's keystore. *Sign out* forgets it on the phone; to cut it off from GitHub's side as well (a lost phone), revoke *Corkboard Companion* under *GitHub → Settings → Applications → Authorized GitHub Apps*. Either way, the app goes back to *Sign in with GitHub*.

## Making a card

The **+** at the bottom of a list writes a card into it: a title, and a description if you like (Markdown, as on the desktop). It goes at the end of the list, numbered after the board's highest card, and reaches GitHub as one commit, `Add CORK-122: <title>`, the same message the desktop's auto-commit writes. The desktop picks it up at its next sync.

Until it's sent, the card waits on the phone, dashed at the end of its list: offline, it goes when the connection is back and the app is in front again (or on a pull to refresh). It gets its number when it's sent, so if a desktop pushed a card with that number meanwhile, the phone's takes the next one; if a desktop made the same number and hasn't pushed yet, the desktop renumbers its own at its next sync. A card GitHub refused (its board gone, say) stays with the reason under it, until you *Discard* it.

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
