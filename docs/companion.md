# The Android companion

A small Android app for a board repo's cards when you're away from the desktop: look at your boards, jot a card down, move it along. It doesn't tackle cards or run Claude; that stays on the desktop.

It talks to GitHub, not git: it reads and writes the board repo's card files through GitHub's API, one commit per change, and the desktop's sync picks those commits up like any other machine's. So it works with board repos whose remote is on GitHub.

## What it does today

It signs in with GitHub, browses your board repos (their boards, each board's lists, and the cards in them), makes cards, and changes them: their title and description, their list, complete or not, archived, their due date, labels and *Do after*. It finds cards on a board, shows its archived ones and restores them, and changes a board's lists and settings. It shares a card to another app, and copies its id.

## Browsing

The phone is laid out as the desktop is, folded for a narrow screen: a board fills the screen, the side panel slides in over it from the left, and a card opens in a drawer from the right.

**The side panel.** The hamburger at the left of a board's header, or a swipe in from the screen's left edge, slides in the side panel, a mirror of the desktop's: *Corkboard* at its head, then every board repo the app can reach, each as a project row with its icon, or else its colour swatch, as the desktop marks it (both are kept in the repo, `project.json` and `theme.json`, so the phone gets them from GitHub). A repo's row opens its main board, the one its row opens on the desktop (picked in the desktop's project settings, else its only top-level board, else the first by title); under it are the main board's child boards and the repo's other top-level boards, as the desktop's side panel lists them (in title order: the order you drag them into is the desktop's own). The arrow beside a repo folds it, and the one beside a board shows its child boards; the phone remembers both. The open board is highlighted. A repo the phone hasn't opened yet shows no boards: a tap opens it on its main board once read. The panel's foot says who's signed in, and has *Add or remove repos on GitHub* and *Sign out*. The scrim beside it, a swipe back to the left, or Android's back button closes it. The first time the app runs, with no board to show yet, the panel opens by itself.

The app wears the open repo's colours, the panel included, as the desktop paints its whole window in the project in front's; on a light theme (*Paper*) Android's status and navigation bar icons turn dark to match. The repos are named by repo: a project's name is set per machine on the desktop, so the phone can't know it.

**A board.** A board opens on its first list, with the others as tabs along the top, each marked with its list's colour as the desktop marks a column's head. A swipe across the list goes to the next list, or back to the previous one, the list following your finger, and the tabs follow, the open one scrolled into view; scrolling up and down and pulling down to refresh work as before. The swipe leaves the screen's edges alone: the left edge opens the side panel, and both edges are Android's back gesture's. Each list is in the order the desktop shows it (by hand, or the list's *Sort cards by*), with dividers as lines; archived lists stay hidden, cards with no list (the map's ideas) get an *Ideas* tab of their own, first, and a board with archived cards gets an *Archived* tab at the end, the last changed first, each saying which list it was in. A swipe goes through all of them in the tabs' order. A card in a list looks as it does on the desktop: its title, then its id and the same badges (complete, has a description, links, waits on, sessions, discussions, due, in red once past), but not the commits, which the phone can't see; labels aren't on the face, as on the desktop.

**A card** opens in a drawer from the right, over most of the screen with the board dimmed beside it, as the desktop's card drawer opens beside its board: its id (a tap copies it) and list at the top, then its title, which stay put while the rest scrolls; then its actions, its due date, labels, linked cards and *Do after*, as the desktop's drawer shows them, then its description. A swipe to the right, a tap on the dimmed board, the *×*, or Android's back button closes it. A description's images show at the width of the drawer (tap one to see it whole), and a card's cover across the top of its face, as on the desktop; links open in the browser. Images are read when a card or a list first shows them and kept on the phone (up to 60 MB, the longest unseen dropped first), so offline it shows the ones it has read, and the path of the others.

Android's back button closes what's on top: the drawer, then the side panel, then a board's settings; from the board, it leaves the app.

The app reopens on the board and list you left (never on a drawer or the panel), drawn at once from what it last read, then refreshes: pull a screen down to refresh it by hand, or, on a board, tap the refresh button at the top right. It reads only the files that changed since, and only the open board's cards, so a refresh is quick and offline it shows the last read. If you're signed out (the sign-in was revoked, or the app went six months unopened), it still shows what it last read, with a bar to sign in again.

## Finding a card

The magnifier beside a board's tabs opens a search field in their place: the board then shows every card whose id, title or description holds the text (the desktop's filter over a board), its ideas first and then list by list in the board's order, each saying its list, and the archived ones that match after them. *Close* puts the tabs back. It searches the open board only.

## Signing in

*Sign in with GitHub* shows a code, copies it, and opens github.com/login/device in the browser, where you're usually signed in already: paste the code, approve *Corkboard Companion*, and come back. There's no password to type into the app and no server between it and GitHub.

The first time, GitHub also asks you to install the app: pick **only your board repos**. The app can read and write those repos' files and nothing else, so a lost phone can't touch your code repos. If you signed in without installing it, the app says so and opens the install page; to add or remove repos later, go to *GitHub → Settings → Applications → Installed GitHub Apps → Corkboard Companion → Configure*.

You stay signed in: the app renews its access to GitHub by itself, as long as you open it at least once every six months. It keeps that access in Android's keystore. *Sign out* forgets it on the phone; to cut it off from GitHub's side as well (a lost phone), revoke *Corkboard Companion* under *GitHub → Settings → Applications → Authorized GitHub Apps*. Either way, the app goes back to *Sign in with GitHub*.

## Making a card

The **+** at the bottom of a list opens the drawer on a new card for that list: a title, and a description if you like (Markdown, as on the desktop). It goes at the end of the list, numbered after the board's highest card, and reaches GitHub as one commit, `Add CORK-122: <title>`, the same message the desktop's auto-commit writes. The desktop picks it up at its next sync.

Until it's sent, the card waits on the phone, dashed at the end of its list: offline, it goes when the connection is back and the app is in front again (or on a pull to refresh). It gets its number when it's sent, so if a desktop pushed a card with that number meanwhile, the phone's takes the next one; if a desktop made the same number and hasn't pushed yet, the desktop renumbers its own at its next sync. A card GitHub refused (its board gone, say) stays with the reason under it, until you *Discard* it.

## Changing a card

An open card has *Edit* (its title and description), *Move to…* (another list of its board; the card goes at the end), *Mark complete* and *Archive*, which asks once more and never deletes: the card is archived, as on the desktop, and can be brought back. An archived card (from the *Archived* tab, or found) has *Restore* instead: it goes to the end of its list, or to the ideas when its list was archived or is gone, decided against the board as it is when the change is written. Each change is one commit, named the way the desktop's auto-commit names it (`Move CORK-12: todo → done`, `Archive CORK-12`, `Restore CORK-12`, `Rename CORK-12: …`), and stamps the card's `updated`, so a sync between desktops keeps it if the same card changed there too.

If the card changed since you opened it (a desktop pushed meanwhile), the app reads it again: a move, a complete or an archive goes on top of the newer card, and so does an edit of a field nobody else touched. When its title, description or due date was changed there too, the app says so and asks: *Overwrite with mine*, or *Keep theirs*.

Under its actions, a card shows its details, and changes them as the desktop's drawer does, each change a commit of its own:

- **Due**: a tap opens Android's date picker; *×* clears it (`Make CORK-12 due 2026-11-05`, `Clear the due date of CORK-12`). A due time written by hand into the file shows under the date, and stays until another day is picked, as on the desktop.
- **Labels**: *×* on a label takes it off; *+ Label* offers the labels the board's cards use, the most used first, or a new one typed in (`Label CORK-12: ui`, `Unlabel CORK-12: ui`).
- **Linked cards**: each by id and title, and a tap opens it. One on another board of the repo shows which board; its title shows if the phone has read that board before (nothing is read just for it), and a tap opens it there. Links are made and taken off on the desktop.
- **Do after**: the cards it waits on, each with its title, struck through and marked *done* once complete or in the board's done list (*Claude moves finished cards to*), and *×* to take one out. *Do it after…* picks another card of the board, leaving out any that would make the order loop (`Put CORK-12 after CORK-9`).

Labels and *Do after* change by what's added or taken off, so a change made on a desktop meanwhile stays beside the phone's; a due date changed there too is asked about, as a title is.

Changing a card needs a connection. Unlike a new card, a change isn't kept for later: offline, the app says nothing was saved, and the details only show. Links, moving a card to another board and reordering a list are for the desktop.

## Lists and board settings

The **⋯** beside a board's tabs, or a long press on a tab, opens that list's menu: *Sort cards by* (the desktop's sorts; *Manual* keeps the order cards were placed in on the desktop), *Rename list*, *Move list left* / *right*, *Archive list* (asked once more: the list is hidden, its cards keep their list), *Add a list* (it opens, ready for cards), and *Board settings*.

*Board settings* holds what of a board's settings applies on a phone: its title; its lists, each with its colour (a tap picks another from the desktop's palette), its name (a tap renames it), *↑* to move it before the one above, and *Archive*, or *Restore* for an archived one; *+ Add a list*; and the flow, the lists *Tackling moves cards to* and *Claude moves finished cards to*. The code repo and prompt notes are for Claude sessions, which start on the desktop: they show, but are changed there.

A list's id is a slug of the title it was made with (`later-maybe`), unique on the board, and never changes when it's renamed, as on the desktop. Colours are written down when a list is added, moved, archived or recoloured, so the others keep theirs. Each change is one commit to `board.json` that says what it did (`Add list Later on cork`, `Archive list Doing on cork`, `Sort Done by Last updated on cork`), the way the desktop's auto-commit now says a board change too. If `board.json` changed since the phone read it (a desktop pushed), the app reads it again and makes the change on the newer file, so an edit there to another list stays. Like a card change, it needs a connection.

## Sharing a card

An open card's *Share* opens a sheet: *Share* hands its title and description to Android's share sheet (a message, a note, an email), and *Share as Markdown* heads them with `[CORK-12] Title`, the line the desktop's *Copy → Markdown* gives. Below them are the desktop's *Copy* items: the id, the title, the commit trailer (`Card: CORK-12`) and the Markdown line. A tap on the card's id, beside its labels, copies it, as a click on it does in the desktop's drawer. None of it needs a connection.

In a [work project](work-mode.md) (`project.json` says so, read with the boards), what you share names the card's Jira key, or its title alone, and never its id: *Share as Markdown* starts `[SPDI-42] Title`, and the copy items offer the *Jira key* in place of the commit trailer, exactly as on the desktop. Only the id itself, copied by name or with a tap, carries it. A card with a key shows it beside the id, and a tap copies that too.

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
