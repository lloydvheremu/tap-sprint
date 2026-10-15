# Tap Sprint

Files:

- `tap-sprint-game.html` is the game. One file, no external requests.
- `leaderboard-server.js` is a small leaderboard server for the global board (Node 18 or newer, no dependencies).
- `blocklist.txt` is an empty word list for name filtering. You fill it (see "Name filtering").

## Turn on the global leaderboard

1. Run the server somewhere that stays online and keeps its disk between restarts (any host that can run Node works).
   Locally: `node leaderboard-server.js` (listens on port 8787, stores scores in `scores.json`).
2. Put it behind HTTPS. Portals load games over HTTPS and browsers block calls to plain http from an https page.
3. Open `tap-sprint-game.html` in a text editor and set the address near the bottom:

   ```js
   window.TAP_SPRINT_CONFIG = { leaderboardUrl: 'https://your-server.example.com' };
   ```

4. Once the game is live, set `ALLOW_ORIGIN` on the server to the game's origin instead of `*`.

Server settings (environment variables): `PORT`, `HOST`, `DATA_FILE`, `ALLOW_ORIGIN`, `MAX_CPS` (default 25), `POSTS_PER_MINUTE` (default 30 per IP), `REPORTS_PER_MINUTE` (default 10 per IP), `REPORT_HIDE_AT` (default 3), `BLOCKLIST_FILE`, `ADMIN_TOKEN`, and `TRUST_PROXY=1` when behind a reverse proxy.

## Input methods and the leaderboard filter

Every round is classed by what the counted taps came from:

- **Touch**: finger or pen on a screen.
- **Mouse**: left or right button.
- **Keyboard**: Space or Enter.
- **Mixed**: two or more of the above in the same round (for example mouse plus Space).

Each round length has a separate board per method, and a player keeps one best per board. The leaderboard has a filter row: All, Touch, Mouse, Keys, Mixed. It opens on what the player used last, or on Touch for a touch screen and Mouse otherwise if they have not played yet. "All" lists every score with its method shown on each row.

Custom round lengths are not ranked.

## Names and moderation

Names are 2 to 16 letters, numbers, spaces, dots, dashes or underscores. Nothing is built into the code. Several layers work together:

1. **Portal names (best option when there is one).**
   - YouTube Playables does not give a game any player name, so players type one there.
   - CrazyGames: if their SDK is on the page and the player is logged in, the game uses their CrazyGames username automatically and does not ask for a name.
   - Any other portal: set `getPlayerName` in the config to a function that returns the name (a string or a Promise), for example `{ leaderboardUrl: '...', getPlayerName: function () { return mySdk.getUsername(); } }`.
   - Characters outside the allowed set are dropped. If nothing usable is left, or the portal does not answer within 3 seconds, the player is asked for a name as usual.
2. **Word list you supply.** Put one term per line in `blocklist.txt` next to `leaderboard-server.js` (or point `BLOCKLIST_FILE` at another file) and restart. Lines starting with `#` are comments.
   - A term of 4 or more letters blocks any name containing it, ignoring case, spaces, dots, dashes and underscores, stretched letters (`fuuuck`) and number swaps (0 for o, 1 for i, 3 for e, 4 for a, 5 for s, 7 for t).
   - A shorter term only blocks when it is a whole word of the name. Start a line with `=` to force whole-word matching for a longer term too.
   - Use a public word list rather than writing your own, and check its license. The open-source "List of Dirty, Naughty, Obscene, and Otherwise Bad Words" project on GitHub is one example; I could not check its current file layout from here.
   - Longer terms can block innocent names that happen to contain them. Remove a term from the file if that happens.
   - A blocked name is refused when typed. If you add a term later, names that match disappear from the boards after the restart, and their owners are told to pick a new one.
3. **Player reports.** On any board row from someone else, tapping the name shows "Report name". When 3 different players have reported a name, it is hidden from every board. Only players who have posted a score can report. Choosing a new name clears the reports and brings the player back.
4. **Admin.** Set `ADMIN_TOKEN` to switch on the admin routes, and always use them over HTTPS:

   ```sh
   # names with reports, hidden names, or names the filter blocks
   curl -H "Authorization: Bearer $ADMIN_TOKEN" https://your-server.example.com/admin/players
   # add ?filter=all to list everyone

   # hide or restore a name by the id shown in that list
   curl -X POST -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" -d '{"id":"abc123def456"}' https://your-server.example.com/admin/hide
   curl -X POST -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" -d '{"id":"abc123def456"}' https://your-server.example.com/admin/unhide
   ```

## Limits you should know about

- A game that runs in the player's browser cannot prove a score or an input method is genuine. The server only rejects impossible values (more than `MAX_CPS` taps per second), bad names, and floods from one IP. Autoclickers and edited requests can still post believable scores, and a player could label a touch score as Mouse.
- A portal username is read by the game in the player's browser, so it is not proof of identity either. Strong verification would need your server to check the portal's signed login token (CrazyGames documents this).
- Reports can be abused by several accounts working together. Players need a posted score to report, and you can restore a name with the admin route.
- Inside the Claude app preview (the shared store), names are not filtered and there is no reporting. Only you and the people you invite can post there.
- Each portal has its own rules about a game calling your server. Check them before you submit.
- Clearing browser data starts a new player id, so a player can come back with a new name.
