# Commit messages

- One short subject line per commit (imperative, under ~70 characters). No body, no bullet lists.
- No Co-Authored-By or "Generated with" attribution lines in commits or PR descriptions.
- Don't name protected paths (tunnel, container-data, mockserver data, .env) in message text; the deny rules in `.claude/settings.json` match command text and will block the commit.
- Never mention the model name or version (e.g. in README, docs, commits or PRs).

# Testing and committing

- While working, run only the tests that cover the change (a single e2e spec, a filtered run, the relevant unit tests). Lint and tsc are fine to run.
- Don't commit after each task. Commit only when asked; before committing, run the full suite once, then make all the separate commits in one go.

# Where directives go

- Generic development directives (workflow, testing, commits, conventions) belong in this file, not in personal memory. Use memory only for things specific to the user or session context.
