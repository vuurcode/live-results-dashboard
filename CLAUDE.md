# Commit messages

- One short subject line per commit (imperative, under ~70 characters). No body, no bullet lists.
- No Co-Authored-By or "Generated with" attribution lines in commits or PR descriptions.
- Don't name protected paths (tunnel, container-data, mockserver data, .env) in message text; the deny rules in `.claude/settings.json` match command text and will block the commit.
- Never mention the model name or version (e.g. in README, docs, commits or PRs).
