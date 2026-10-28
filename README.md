# Tap That

Files:

- `index.html` and `tap-sprint-game.html` are the same game: one file, no external requests. `index.html` is what GitHub Pages serves. Keep the two identical (`npm run check` verifies it).
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

## After a round

The result screen always leads to one next step. **Play again** is the biggest button (tap, Enter or Space). Right after a round the buttons and the name field are locked for a moment (a fill runs across Play again) so stray taps cannot press them.

- **New best, no name yet** (ranked round, leaderboard connected, no saved or portal name): an inline field asks for a name, with a "Post my score" button. Enter submits. A refused name shows a message on the field and is not saved; a network failure while checking shows a retry message. Once the name is saved and the score posted, the leaderboard opens by itself on the round length and input method just played, with the player's row highlighted and scrolled into view, the rank shown in a banner, and Play again pinned at the bottom.
- **New best, name known** (saved or portal name): the score is posted and the result shows "Posted. You're #3 on Touch, 5 sec." with a "View leaderboard" link. The board does not open by itself.
- **Not a new best, custom round, or leaderboard not connected**: no prompt. Custom rounds say they are not ranked.

The board is reachable any time from the Leaderboard button in the dock. Back, Escape and the browser Back button all close it. On phones, while the keyboard is open for the name field, the header, round picker and dock hide so the field and Post button stay visible.

A **new best** on a preset round (including the first score on each new board, such as your first 30 sec Mouse score) plays a 3 second confetti burst once, right after the round. Custom rounds and non-best rounds never do. With reduced motion on there is no confetti; the "New best" badge gets a brief static outline instead.

The call to action pulses gently: the idle "Tap anywhere to start" hint, and the "Play again" label once its lock ends (not while the name field has focus). It is an opacity fade between 100 and 70 percent about once a second, so it never flashes. With reduced motion it is underlined instead.

## Effects (optional, cosmetic)

The **Effects** button (start and result screens, not during a round) opens a panel. Effects never change the score, the input method or the leaderboard; they are not sent to the server.

- **Level:** Off, Light (default: jelly wobble and tap ripples) or Full (everything chosen below). With reduced motion on, visuals start Off and the panel says so; you can still switch them on.
- **Theme (Full only, one at a time):** None, Earthquake, Glass crack, Balloon, Paint splatter, Lightning, Zero gravity, Retro glitch, Emoji rain (8 emoji to pick from).
- **Extras:** heat meter, speed lines and screen shake (Full only), sound and vibration (any level, both off by default).
- **Try it:** a preview strip in the panel shows your settings (and plays sound or vibrates if those are on) when you tap it.
- **Cosmetics that unlock:** tap-area skins, ripple colours and trails unlock from lifetime taps or personal bests (the panel shows what is left). Themes and effects are all available from the start. A quiet "Unlocked" line appears on the result card.
- **Safety:** no flashing (whole-screen brightness never changes quickly, eased over 300 ms or more), effect layers never take clicks, nothing is drawn over the controls, and everything is cleared at Play again. A quality governor steps Full to Light to Off if frames stay slow, shows a small note once, and does not step back up until you pick a level again. Hidden tabs pause everything.
- **How it stays out of the way:** a tap is counted and timestamped first; effects are queued and drawn from one animation-frame loop that stops when nothing is moving. No layout reads happen in the tap handler.
- **Sound and portals:** sound is generated in the browser (no files) and only starts after a tap. If the page runs on YouTube Playables it follows `ytgame.system.isAudioEnabled()` and `onAudioEnabledChange`; if the CrazyGames SDK is present it follows its `muteAudio` setting.
- **Saving:** settings and unlock progress are in the same save as scores (browser and the Playables cloud save). Saves from before this feature, or damaged ones, fall back to the defaults field by field.

Tests: `npm i` then `npm test` runs a Playwright (Chrome) suite against a temporary local server (it takes several minutes). It covers the flows above, the input methods, the keyboard-only path, every effect theme (counting, hit-testing, cleanup, brightness, timer accuracy on a fake clock) and a sweep of screen sizes. Set `SHOTS_DIR` to save screenshots.

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
