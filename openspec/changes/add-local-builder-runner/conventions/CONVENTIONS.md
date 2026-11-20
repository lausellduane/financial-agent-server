<!-- DRAFT for lausellduane/financial-agent-server: conventions/CONVENTIONS.md.
     The local-builder workflow passes this file to Aider with --read, so it's read-only context.
     It's kept short on purpose, because it counts against the 4K-token context. -->
# Conventions for the local builder

1. **Follow `tasks.md` in order.** Do only the task numbers the job prompt gives you, in order, and don't skip ahead.
2. **Touch only the files the task names.** Don't create, rename, or delete any other file, and don't reformat code you aren't changing.
3. **Run the tests.** Your changes must pass `npm test`. If a task asks for a test, add it in the test file the task names.
4. **Never touch these:**
   - `.github/` (workflows)
   - `wrangler.toml` / `wrangler.json*` (Worker and deploy config)
   - `migrations/` (Durable Object or storage migrations)
   - `.env*` and `.dev.vars*`
   - anything holding secrets, keys, or tokens
   - `package.json` and `package-lock.json`, unless the task names them
5. **If the task is unclear, stop.** Don't guess. Write a file named `BLOCKED.md` at the repo root with:
   - the task number;
   - what's unclear or missing, in one to three sentences;
   - the question a human needs to answer.

   Make no other changes. The workflow posts `BLOCKED.md` on the issue and opens no PR.
6. **Keep the diff small:**
   - The smallest change that makes the task's scenarios pass.
   - No refactors, renames, or new dependencies.
   - No new comments unless the task asks for them.
7. **Match the existing style** of the file: TypeScript, quotes, indentation, naming.
