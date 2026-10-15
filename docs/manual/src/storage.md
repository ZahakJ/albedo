# Storage, backups and offline use

## Where your photos are

albedo keeps everything in the browser's private storage for its site: a copy of every original, thumbnails and previews, edits, masks and a SQLite catalog. Nothing is uploaded. The browser is asked to keep this storage even when the disk fills up.

Each browser, and each site address, has its own catalog. One tab at a time can use it.

## Backups

*Back up catalog…* at the bottom of the Library's left panel writes one archive with every original, edit, preset and mask. *Restore backup…* reads it into an empty catalog, in this browser or another.

## Offline

Once albedo has loaded, it works without a network: the app and its data are cached. The AI models are cached the first time each one is used.
