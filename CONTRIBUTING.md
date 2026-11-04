# Contributing

Issues and pull requests are welcome, but this is a hobby project: there is **no support and no guaranteed response time**. For questions about setup or usage, please use GitHub Discussions rather than issues. An issue is best when you can describe what happened, what you expected, your OS, Node and ffmpeg versions, and the relevant log lines (with tokens and server details removed).

## Running the checks

```bash
npm install
npm test        # node --test; needs no Discord, Jellyfin or ffmpeg
npm run lint    # eslint
```

Both run in CI on every push. Please make sure they pass, and add or update a test when you change behaviour (see `test/helpers.js` for the fake streamer and ffmpeg used by the player tests).

## Conventions

- Plain ESM JavaScript, no build step.
- Comments explain **why**, not what: the constraint, the bug that was seen, the Discord or ffmpeg quirk. If a change has a non-obvious reason, write it down next to the code.
- Keep `src/` free of Windows-only assumptions where you can; guard them with `process.platform`.

## Secrets

Never commit tokens, API keys, `.env`, server or channel IDs, or personal data, and do not paste them into issues. `.env`, `data/` and `tmp/` are in `.gitignore`; check `git status` before committing. If a token leaks, reset it right away.
